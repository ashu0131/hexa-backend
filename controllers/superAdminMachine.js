
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Supabase Initialization
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Admin functionalities ke liye bypass key
);
// ─────────────────────────────────────────────────────────────────
// 📡 FETCH API (GET): Synchronize ALL machinery records from DB
// ─────────────────────────────────────────────────────────────────
router.get('/getMachine', async (req, res) => {
  try {
    console.log("📡 Fetching all fleet specifications from telemetry cluster mesh...");

    const { data, error } = await supabase
      .from('unassigned_plugs')
      .select('name, cost, chipid, duration_ms, run_mode')
      .order('id', { ascending: false });

    if (error) {
      console.error("Supabase DB Engine reported multi-row read exception:", error.message);
      return res.status(400).json({ msg: `Database read failure: ${error.message}` });
    }

    return res.status(200).json(data || []);

  } catch (err) {
    console.error(" Critical fetch all configurations execution crash:", err);
    return res.status(500).json({ msg: "Internal execution loop failed to parse telemetry active data array stack." });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST API: Register a BRAND NEW machine instance row inside DB
// ─────────────────────────────────────────────────────────────────
router.post('/addMachine', async (req, res) => {
  try {
    const { name, cost, chipid, duration_ms, run_mode } = req.body;

    // Safety Guard 1: Basic validation constraint check
    if (!chipid || !name || !run_mode) {
      return res.status(400).json({ msg: "Required structural configuration parameters are missing." });
    }

    const safeName = String(name || "").trim();
    const safeChipid = String(chipid || "").trim();

    const { data, error } = await supabase
      .from('unassigned_plugs')
      .insert({
        name: safeName,
        chipid: safeChipid,
        cost: Number(cost) || 0,
        duration_ms: Number(duration_ms) || 0,
        run_mode: run_mode,
        updated_at: new Date().toISOString()
      })
      .select();

    if (error) {
      console.error(" Supabase Database Engine Operation Rejected:", error.message, error.details);
      return res.status(400).json({ msg: `Database error: ${error.message}` });
    }

    return res.status(200).json({
      success: true,
      msg: "New machinery asset registered successfully inside cluster mesh.",
      data: data[0]
    });

  } catch (err) {
    console.error(" Telemetry write matrix fault trace exception:", err);
    return res.status(500).json({ msg: "Internal server validation engine broke down during write." });
  }
});

module.exports = router;