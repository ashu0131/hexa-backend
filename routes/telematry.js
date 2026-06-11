const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST /api/telemetry/update-poll-interval
router.post("/update-poll-interval", async (req, res) => {
  try {
    const { status_poll_interval } = req.body;

    if (
      status_poll_interval === undefined ||
      status_poll_interval === null ||
      Number(status_poll_interval) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid status_poll_interval is required",
      });
    }

    // Get first row
    const { data: row, error: fetchError } = await supabase
      .from("teleperiod")
      .select("id")
      .order("id", { ascending: true })
      .limit(1)
      .single();

    if (fetchError) throw fetchError;

    // Update first row only
    const { error: updateError } = await supabase
      .from("teleperiod")
      .update({
        status_poll_interval: Number(status_poll_interval),
      })
      .eq("id", row.id);

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: "Poll interval updated successfully",
      status_poll_interval: Number(status_poll_interval),
    });
  } catch (err) {
    console.error("Update poll interval error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// GET /api/telemetry/get-poll-interval
router.get("/get-poll-interval", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("teleperiod")
      .select("status_poll_interval")
      .order("id", { ascending: true })
      .limit(1)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      status_poll_interval: data.status_poll_interval,
    });
  } catch (err) {
    console.error("Get poll interval error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});


module.exports = router;