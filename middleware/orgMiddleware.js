const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    // ✅ Verify token using Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ message: "Invalid user" });
    }

    // ✅ Attach user to request
    req.user = data.user;

    next();
  } catch (err) {
    return res.status(500).json({ message: "Auth error", error: err.message });
  }
};

const requireOrg = async (req, res, next) => {
  try {
    const orgId = req.headers['x-org-id'];
    const userId = req.user.id;

    if (!orgId) {
      return res.status(400).json({ message: "Organization ID missing" });
    }

    const { data, error } = await supabase
      .from("organization_members")
      .select("*")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      return res.status(403).json({ message: "Access denied to this organization" });
    }

    // 🔥 Attach org context
    req.org = data;
    req.orgId = orgId;

    next();
  } catch (err) {
    console.error("Org middleware error:", err);
    res.status(500).json({ message: "Org middleware error" });
  }
};

module.exports = {
  authMiddleware,
  requireOrg
};