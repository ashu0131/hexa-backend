const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");
const { verifyPlugOnline } = require("../services/mqttClient");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.post("/check-chip", async (req, res) => {
  try {
    const { chipid } = req.body;

    if (!chipid) {
      return res.status(400).json({
        success: false,
        message: "chipid is required",
      });
    }

    // Check chip exists
    const { data, error } = await supabase
      .from("unassigned_plugs")
      .select("*")
      .eq("chipid", chipid)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        message: "Chip ID not found",
      });
    }

    // Check plug is online via MQTT
    const online = await verifyPlugOnline(chipid);

    if (!online) {
      return res.status(400).json({
        success: false,
        message: "Plug is offline or not connected to MQTT",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Plug verified and online",
      data,
    });
  } catch (err) {
    console.error("Check chip error:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;