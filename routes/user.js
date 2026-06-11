const express = require("express");
const router = express.Router();
const { requireAuth } = require("./auth");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Deprecated route
router.post("/update-balance", (req, res) => {
  console.log("⚠️ Deprecated endpoint hit: /update-balance");
  return res.status(403).json({
    msg: "This endpoint is deprecated. Balance is updated automatically via Stripe.",
  });
});

// Get profile
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const requestedUserId = req.query.userId;
    const currentUserId = req.user.id;

    // 1️⃣ Get current user's role
    const { data: currentProfile, error: roleError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", currentUserId)
      .single();

    if (roleError || !currentProfile) {
      return res.status(404).json({ msg: "User not found" });
    }

    const isAdmin = currentProfile.role === "admin";

    // 2️⃣ Decide whose profile to load
    const userIdToLoad =
      isAdmin && requestedUserId ? requestedUserId : currentUserId;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userIdToLoad)
      .single();

    if (error || !profile) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json(profile);
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;