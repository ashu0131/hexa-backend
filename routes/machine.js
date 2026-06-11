const express = require("express");
const router = express.Router();
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { requireAuth } = require("./auth");
const { sendPowerCommand } = require("../services/mqttClient");
const { requireOrg } = require("../middleware/orgMiddleware");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

router.get("/status", requireAuth, requireOrg, async (req, res) => {
  try {
    // 1. Machine ka current status fetch karein
    const { data: statuses, error: statusError } = await supabase
      .from("machine_status")
      .select(`
        machine_id,
        in_use,
        end_time,
        started_by,
        door_active_until,
        door_cooldown_until,
        mode,
        machines!inner ( id, name, machine_code, organization_id ),
        profiles ( username )
      `)
      .eq("machines.organization_id", req.orgId);

    if (statusError) throw statusError;

    const { data: activeLogs, error: logError } = await supabase
      .from("machine_logs")
      .select("machine_id, energy_started")
      .is("end_time", null);

    if (logError) throw logError;

  
    const energyFlagMap = {};
    if (activeLogs) {
      activeLogs.forEach((log) => {
        energyFlagMap[log.machine_id] = Boolean(log.energy_started);
      });
    }

    const formattedStatuses = statuses.map((item) => {
      return {
        machine_id: item.machine_id,
        in_use: item.in_use,
        end_time: item.end_time,
        started_by: item.started_by,
        door_active_until: item.door_active_until,
        door_cooldown_until: item.door_cooldown_until,
        mode: item.mode,
        machines: item.machines,
        profiles: item.profiles,
        // 🔥 Yeh flag frontend ko batayega ki power 20W cross hui ya nahi
        energyStarted: energyFlagMap[item.machine_id] || false 
      };
    });

    res.json(formattedStatuses);
  } catch (err) {
    console.error("Status API Error:", err);
    res.status(500).json({ error: "Error getting machine status" });
  }
});

// START MACHINE

router.post("/start", requireAuth, requireOrg, async (req, res) => {
  const { machine_code } = req.body;

  const userId = req.user.id;

  try {
    // 1️⃣ GET MACHINE
    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("*")
      .eq("machine_code", machine_code)
      .eq("organization_id", req.orgId)
      .single();

    if (machineError || !machine) {
      return res.status(400).json({
        msg: "Invalid machine selected",
      });
    }
    console.log("Machine fetched:", machine);

    if (machine.is_enabled === false) {
     return res.status(400).json({
      msg: "Machine is disabled by administrator",
      });
      }
    // 2️⃣ GET MEMBER

    const { data: member, error: memberError } = await supabase
      .from("organization_members")
      .select("balance")
      .eq("user_id", userId)
      .eq("organization_id", req.orgId)
      .single();

    if (memberError || !member) {
      return res.status(400).json({
        msg: "User not part of this organization",
      });
    }

    console.log("Member fetched:", member);

    // ===============================================
    // 3️⃣ BALANCE CHECK
    if (member.balance < machine.cost) {
      return res.status(400).json({
        msg: "Insufficient balance",
      });
    }
    // ===============================================
    // 4️⃣ CHECK MACHINE STATUS

    const { data: status } = await supabase
      .from("machine_status")
      .select("*")
      .eq("machine_id", machine.id)
      .single();

    console.log("Machine status:", status);

    if (status?.in_use) {
      return res.status(400).json({
        msg: "Machine is currently in use",
      });
    }

    // ===============================================
    // 5️⃣ MACHINE MODE

    const machineMode = machine.run_mode || "time_based";
    console.log("Machine mode:", machineMode);

    // ===============================================
    // 6️⃣ CALCULATE END TIME

    let endTime = null;

    // TIME MODE
    if (machineMode === "time_based") {
      endTime = new Date(Date.now() + machine.duration_ms).toISOString();

      console.log(`TIME MODE → machine will stop at ${endTime}`);
    }

    // ENERGY MODE
    if (machineMode === "energy_based") {
      endTime = null;

      console.log(`ENERGY MODE → no timer for ${machine.id}`);
    }

    // ===============================================
    // 7️⃣ SAVE STATUS FIRST
    // ===============================================

    const { error: statusError } = await supabase.from("machine_status").upsert(
      {
        machine_id: machine.id,
        in_use: true,
        started_by: userId,
        end_time: endTime,
        mode: machineMode,
      },
      {
        onConflict: "machine_id",
      },
    );

    if (statusError) {
      console.error("STATUS ERROR:", statusError);

      throw statusError;
    }

    console.log("Machine status saved");

    // ===============================================
    // 8️⃣ START MACHINE AFTER DB SAVE
    // ===============================================

    try {
      if (!machine.chipid) {
        throw new Error("Machine chipid missing");
      }

      await sendPowerCommand(machine.chipid, "ON");

      console.log("Command confirmed");
      if (typeof resetMachineRuntime === "function") {
        resetMachineRuntime(machine.chipid);

        console.log("Runtime reset");
      }
    } catch (deviceError) {
      console.error("MQTT activation failed:", deviceError.message);

      // ===============================================
      // ROLLBACK STATUS

      await supabase
        .from("machine_status")
        .update({
          in_use: false,
          started_by: null,
          end_time: null,
          mode: null,
        })
        .eq("machine_id", machine.id);

      return res.status(503).json({
        msg: "Machine unavailable. Device not responding.",
      });
    }

    // ===============================================
    // 9️⃣ DEDUCT BALANCE
    const newBalance = member.balance - machine.cost;

    const { error: balanceError } = await supabase
      .from("organization_members")
      .update({
        balance: newBalance,
      })
      .eq("user_id", userId)
      .eq("organization_id", req.orgId);

    if (balanceError) {
      console.error(balanceError);

      throw balanceError;
    }
    // CLOSE OLD OPEN LOGS FIRST
    await supabase
      .from("machine_logs")
      .update({
        end_time: new Date().toISOString(),
      })
      .eq("machine_id", machine.id)
      .is("end_time", null);
    // ===============================================
    // 🔟 INSERT MACHINE LOG

    await supabase.from("machine_logs").insert({
      machine_id: machine.id,
      user_id: userId,
      start_time: new Date().toISOString(),
      end_time: null,
      was_force_stopped: false,
      logs: [],
    });
    res.json({
      msg: "Machine started successfully",
      endTime,
      newBalance,
      mode: machineMode,
    });
  } catch (err) {
    console.error("START MACHINE ERROR:", err);

    res.status(500).json({
      msg: "Failed to start machine",
      error: err.message,
    });
  }
});

// ===============================
// GET PRICE

router.get("/prices", async (req, res) => {
  try {
    const { data: machines, error } = await supabase
      .from("machines")
      .select("machine_code, cost");

    if (error) throw error;

    const prices = {};

    machines.forEach((machine) => {
      prices[machine.machine_code] = machine.cost;
    });

    res.json(prices);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to fetch prices",
    });
  }
});

// ===============================
// UPDATE PRICE

router.post("/update-price", requireAuth, requireOrg, async (req, res) => {
  const { machine_code, newPrice } = req.body;

  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    const { data, error } = await supabase
      .from("machines")
      .update({
        cost: newPrice,
      })
      .eq("machine_code", machine_code)
      .eq("organization_id", req.orgId)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        msg: "Machine not found",
      });
    }

    res.json({
      msg: "Price updated successfully",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to update price",
    });
  }
});

// ===============================
// UPDATE MACHINE MODE

router.post("/update-mode", requireAuth, requireOrg, async (req, res) => {
  const { machine_code, mode } = req.body;

  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    if (mode !== "time_based" && mode !== "energy_based") {
      return res.status(400).json({
        msg: "Invalid mode",
      });
    }

    // =========================
    // UPDATE MACHINE TABLE
    // =========================

    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .update({
        run_mode: mode,
      })
      .eq("machine_code", machine_code)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (machineError) throw machineError;

    // =========================
    // UPDATE MACHINE_STATUS TABLE
    // =========================

    const {data: updatedStatus, error: statusError } = await supabase
      .from("machine_status")
      .update({
        mode: mode,
      })
      .eq("machine_id", machine.id)
      .select();

      
    if (statusError) throw statusError;


    // =========================
    // RESPONSE
    // =========================

    res.json({
      msg: "Machine mode updated successfully",
      machine,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to update mode",
    });
  }
});

// ===============================
// FORCE STOP
router.post("/force-stop", requireAuth, requireOrg, async (req, res) => {
  const { machine_id } = req.body;

  console.log("Force stop called for machine_id:", machine_id);

  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("*")
      .eq("id", machine_id)
      .eq("organization_id", req.orgId)
      .single();

    if (machineError || !machine) {
      return res.status(400).json({
        msg: "Invalid machine",
      });
    }

    await sendPowerCommand(machine.chipid, "OFF");

    await supabase
      .from("machine_status")
      .update({
        in_use: false,
        end_time: null,
        started_by: null,
        mode: null,
      })
      .eq("machine_id", machine.id);

    await supabase
      .from("machine_logs")
      .update({
        end_time: new Date().toISOString(),
        was_force_stopped: true,
      })
      .eq("machine_id", machine.id)
      .is("end_time", null);

    res.json({
      msg: "Machine force stopped successfully",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to force stop machine",
    });
  }
});

// ===============================
// ENABLE / DISABLE MACHINE
// ===============================

router.post("/toggle-machine", requireAuth, requireOrg, async (req, res) => {
  const { machine_code, is_enabled } = req.body;

  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    const { data, error } = await supabase
      .from("machines")
      .update({
        is_enabled,
      })
      .eq("machine_code", machine_code)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      msg: `Machine ${is_enabled ? "enabled" : "disabled"} successfully`,
      machine: data,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to update machine status",
    });
  }
});

// ===============================
// DOOR
// ===============================

router.post("/door", requireAuth, requireOrg, async (req, res) => {
  const { machine_code } = req.body;

  try {
    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("*")
      .eq("machine_code", machine_code)
      .eq("organization_id", req.orgId)
      .single();

    if (machineError || !machine) {
      return res.status(400).json({
        msg: "Invalid machine",
      });
    }

    if (!machine.chipid) {
      return res.status(500).json({
        msg: "Machine not configured correctly",
      });
    }

    const { data: status } = await supabase
      .from("machine_status")
      .select("*")
      .eq("machine_id", machine.id)
      .single();

    const now = new Date();

    if (status?.in_use) {
      return res.status(400).json({
        msg: "Machine is currently in use",
      });
    }

    if (status?.door_active_until && now < new Date(status.door_active_until)) {
      return res.status(403).json({
        msg: "Door is already open",
        doorActiveUntil: status.door_active_until,
      });
    }

    if (
      status?.door_cooldown_until &&
      now < new Date(status.door_cooldown_until)
    ) {
      return res.status(403).json({
        msg: "Please wait before opening again",
        nextAllowedAt: status.door_cooldown_until,
      });
    }

    await sendPowerCommand(machine.chipid, "ON");

    setTimeout(async () => {
      try {
        await sendPowerCommand(machine.chipid, "OFF");
      } catch (err) {
        console.error("Door auto-close failed:", err.message);
      }
    }, 30000);

    const doorActiveUntil = new Date(now.getTime() + 30 * 1000).toISOString();

    const doorCooldownUntil = new Date(now.getTime() + 60 * 1000).toISOString();

    await supabase.from("machine_status").upsert({
      machine_id: machine.id,
      door_active_until: doorActiveUntil,
      door_cooldown_until: doorCooldownUntil,
      in_use: false,
    });

    res.json({
      msg: "Door opened",
      doorActiveUntil,
      doorCooldownUntil,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to trigger door",
    });
  }
});
// ===============================
// UPDATE CONFIG

router.post("/update-config", requireAuth, requireOrg, async (req, res) => {
  const { machine_code, updates } = req.body;

  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    const finalUpdates = {
      ...updates,
    };

    // ALSO UPDATE machine_status TABLE
    if (updates.mode) {
      await supabase
        .from("machine_status")
        .update({
          mode: updates.mode,
        })
        .eq("machine_code", machine_code)
        .eq("organization_id", req.orgId);
    }

    // UPDATE machines TABLE
    const { data, error } = await supabase
      .from("machines")
      .update(finalUpdates)
      .eq("machine_code", machine_code)
      .eq("organization_id", req.orgId)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        msg: "Machine not found",
      });
    }

    res.json({
      msg: "Machine config updated successfully",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to update machine config",
    });
  }
});

// ===============================
// GET CONFIGS
// ===============================
router.get("/configs", requireAuth, requireOrg, async (req, res) => {
  try {
  
    const { data, error } = await supabase
      .from("machines")
      .select("*")
      .eq("organization_id", req.orgId);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to fetch configs",
    });
  }
});
router.get("/configs/admin", requireAuth, requireOrg, async (req, res) => {
  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    const { data, error } = await supabase
      .from("machines")
      .select("*")
      .eq("organization_id", req.orgId);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to fetch configs",
    });
  }
});

// ===============================
// ADD MACHINE
// ===============================

router.post("/add-config", requireAuth, requireOrg, async (req, res) => {
  const {  name, cost, chipid, duration_ms,run_mode} = req.body;

  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({
        msg: "Unauthorized",
      });
    }

    if (!name || !cost || !chipid || !duration_ms || !run_mode) {
      return res.status(400).json({
        msg: "All fields are required",
      });
    }

    const { data: machine, error } = await supabase
      .from("machines")
      .insert({
       
        name,
        cost,
        chipid,
        duration_ms,
        run_mode,

        organization_id: req.orgId,
      })
      .select()
      .single();

    if (error) {
  console.error(error);

  if (error.code === "23505") {
    if (error.message.includes("machines_chipid_unique")) {
      return res.status(409).json({
        msg: "Chip ID already exists",
      });
    }

    if (error.message.includes("machines_machine_code_unique")) {
      return res.status(409).json({
        msg: "Machine Code already exists",
      });
    }

    return res.status(409).json({
      msg: "Duplicate entry found",
    });
  }

  throw error;
}

    await supabase.from("machine_status").insert({
      machine_id: machine.id,
      in_use: false,
      started_by: null,
      end_time: null,
      mode: null,
    });

    res.json({
      msg: "Machine added successfully",
      machine,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      msg: "Failed to add machine config",
    });
  }
});

// ===============================
// DELETE MACHINE
// ===============================

router.delete(
  "/delete-config/:machine_code",
  requireAuth,
  requireOrg,
  async (req, res) => {
    const { machine_code } = req.params;

    try {
      if (req.org.role !== "admin") {
        return res.status(403).json({
          msg: "Unauthorized",
        });
      }

      const { data, error } = await supabase
        .from("machines")
        .delete()
        .eq("machine_code", machine_code)
        .eq("organization_id", req.orgId)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        return res.status(404).json({
          msg: "Machine not found",
        });
      }

      res.json({
        msg: "Machine deleted successfully",
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        msg: "Failed to delete machine config",
      });
    }
  },
);

module.exports = router;
