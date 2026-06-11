// routes/logs.js

const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.get("/:log_id", async (req, res) => {
  try {
    const { log_id } = req.params;

    const { data, error } = await supabase
      .from("machine_logs")
      .select("logs")
      .eq("id",log_id  )
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    console.error("Logs Fetch Error:", err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;