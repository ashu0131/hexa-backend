const { createClient } = require("@supabase/supabase-js");
const { sendPowerCommand } = require("./mqttClient");
const sendMachineStopMail = require("../utils/sendMachineStopMail");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// =====================================
// energy mode support
// =====================================
const ENERGY_BASED_MODES = ["energy_based"];

async function checkExpiredMachines() {
  try {
    const now = new Date().toISOString();

    const { data: statuses, error } = await supabase
      .from("machine_status")
      .select("*");

    if (error) throw error;

    for (const status of statuses) {
      // =====================================
      //  0. CONSISTENCY GUARD
      // =====================================
      if (!status.in_use && status.end_time && now < status.end_time) {
        console.warn("Fixing: idle but time still left:", status.machine_id);

        await supabase
          .from("machine_status")
          .update({ in_use: true })
          .eq("machine_id", status.machine_id);

        continue;
      }
      // Energy mode machines may not have end_time
      if (
        status.in_use &&
        !status.end_time &&
        !ENERGY_BASED_MODES.includes(status.mode)
      ) {
        console.error("CRITICAL: running without end_time:", status.machine_id);

        await supabase
          .from("machine_status")
          .update({
            in_use: false,
            started_by: null,
            mode: null,
          })
          .eq("machine_id", status.machine_id);

        continue;
      }

      // =====================================
      //  1. Door cleanup
      // =====================================

      if (status.door_active_until && now > status.door_active_until) {
        console.log("Clearing door_active_until for:", status.machine_id);

        await supabase
          .from("machine_status")
          .update({ door_active_until: null })
          .eq("machine_id", status.machine_id);
      }

      if (status.door_cooldown_until && now > status.door_cooldown_until) {
        console.log("Clearing door_cooldown_until for:", status.machine_id);

        await supabase
          .from("machine_status")
          .update({ door_cooldown_until: null })
          .eq("machine_id", status.machine_id);
      }
      if (!status.in_use) continue;
      if (ENERGY_BASED_MODES.includes(status.mode)) {
        console.log(
          `Energy mode active for ${status.machine_id} → time scheduler skipped`,
        );

        continue;
      }

      if (!status.end_time) continue;

      // =====================================
      //  TIME BASED STOP
      // =====================================

      if (now > status.end_time) {
        const { data: machine } = await supabase
          .from("machines")
          .select("chipid, name")
          .eq("id", status.machine_id)
          .single();

        if (!machine?.chipid) continue;

        console.log("Stopping machine:", machine.chipid);

        try {
          await sendPowerCommand(machine.chipid, "OFF");
        } catch (err) {
          console.error("MQTT stop failed:", err.message);
        }

        console.log("Scheduler updating DB for:", status.machine_id);

        await supabase
          .from("machine_status")
          .update({
            in_use: false,
            started_by: null,
            end_time: null,
            mode: null,
          })
          .eq("machine_id", status.machine_id);

        // ======================================
        // GET ACTIVE LOG BEFORE CLOSING
        // ======================================

        const { data: activeLog } = await supabase
          .from("machine_logs")
          .select("user_id")
          .eq("machine_id", status.machine_id)
          .is("end_time", null)
          .single();

        // CLOSE LOG
        await supabase
          .from("machine_logs")
          .update({
            end_time: new Date().toISOString(),
          })
          .eq("machine_id", status.machine_id)
          .is("end_time", null);

        // SEND MAIL
        if (activeLog?.user_id) {
          await sendMachineStopMail({
            userId: activeLog.user_id,
            machineName: machine.name,
          });

          console.log("Time-based stop mail sent");
        }

        console.log(` Time based machine stopped ${machine.chipid}`);
      }
    }
  } catch (err) {
    console.error("Scheduler error:", err);
  }
}

async function runStartupRecovery() {
  console.log("Running startup recovery...");

  try {
    const now = new Date().toISOString();

    const { data: statuses, error } = await supabase
      .from("machine_status")
      .select("*")
      .eq("in_use", true);

    if (error) throw error;

    for (const status of statuses) {
      // =====================================
      // Skip energy-based machines
      // =====================================

      if (ENERGY_BASED_MODES.includes(status.mode)) {
        console.log(`Recovery skipped for energy machine ${status.machine_id}`);

        continue;
      }

      if (!status.end_time) continue;

      const { data: machine } = await supabase
        .from("machines")
        .select("chipid , machine_code")
        .eq("id", status.machine_id)
        .single();

      if (!machine?.chipid) continue;

      if (now > status.end_time) {
        console.log("Recovery stopping expired machine:", machine.chipid);

        try {
          await sendPowerCommand(machine.chipid, "OFF");
        } catch (err) {
          console.error("Recovery stop failed:", err.message);
        }

        await supabase
          .from("machine_status")
          .update({
            in_use: false,
            started_by: null,
            end_time: null,
            mode: null,
          })
          .eq("machine_id", status.machine_id);

        await supabase
          .from("machine_logs")
          .update({
            end_time: new Date().toISOString(),
          })
          .eq("machine_id", status.machine_id)
          .is("end_time", null);

        console.log(`✅ Recovery completed for ${machine.chipid}`);
      } else {
        console.log("Machine still running:", machine.chipid);
      }
    }

    // =====================================
    //  DOOR RECOVERY
    // =====================================

    const { data: doorStatuses } = await supabase
      .from("machine_status")
      .select("machine_id, door_active_until");

    for (const status of doorStatuses) {
      if (status.door_active_until && now > status.door_active_until) {
        const { data: machine } = await supabase
          .from("machines")
          .select("chipid")
          .eq("id", status.machine_id)
          .single();

        if (machine?.chipid) {
          console.log("Recovery: door expired → OFF:", machine.chipid);

          try {
            await sendPowerCommand(machine.chipid, "OFF");
          } catch (err) {
            console.error("Recovery door OFF failed:", err.message);
          }
        }

        await supabase
          .from("machine_status")
          .update({ door_active_until: null })
          .eq("machine_id", status.machine_id);
      }
    }
  } catch (err) {
    console.error("Startup recovery error:", err);
  }
}

function startMachineScheduler() {
  setInterval(checkExpiredMachines, 5000);
}

module.exports = {
  startMachineScheduler,
  runStartupRecovery,
};
