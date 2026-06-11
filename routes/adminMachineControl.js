const express = require("express");
const router = express.Router();

const { sendPowerCommand } = require("../services/mqttClient");
const { authMiddleware, requireOrg } = require("../middleware/orgMiddleware");

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

router.post(
  "/machine-control",
  authMiddleware,
  requireOrg,
  async (req, res) => {
    try {
      // Only org admin
      if (req.org.role !== "admin") {
        return res.status(403).json({
          error: "Admin access required",
        });
      }

      const { machineId, state } = req.body;

      if (!machineId || !state) {
        return res.status(400).json({
          error: "machineId and state required",
        });
      }

      const powerState = state.toUpperCase();

      if (!["ON", "OFF"].includes(powerState)) {
        return res.status(400).json({
          error: "State must be ON or OFF",
        });
      }

      // IMPORTANT:
      // Verify machine belongs to active organization
      const { data: machine, error } = await supabase
        .from("machines")
        .select("id, chipid, machine_code, organization_id")
        .eq("id", machineId)
        .eq("organization_id", req.orgId)
        .single();

      if (error || !machine) {
        return res.status(404).json({
          error: "Machine not found in this organization",
        });
      }

      await sendPowerCommand(machine.chipid, powerState);
      await supabase
        .from("machines")
        .update({
          power_state: powerState === "ON",
        })
        .eq("id", machineId);

      console.log(
        `ORG ${req.orgId} | ADMIN ${req.user.id} | ${machine.machine_code} -> ${powerState}`,
      );

      return res.json({
        success: true,
        machine: machine.machine_code,
        state: powerState,
      });
    } catch (err) {
      console.error(err);

      return res.status(500).json({
        error: err.message,
      });
    }
  },
);

module.exports = router;
