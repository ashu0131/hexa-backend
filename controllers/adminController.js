const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Helper: parse date range from query, with defaults (last 30 days)
function getDateRange(query) {
  let from = query.from ? new Date(query.from) : null;
  let to = query.to ? new Date(query.to) : null;

  // Fallback to last 30 days if missing or invalid
  if (!from || isNaN(from.getTime())) {
    from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  }

  if (!to || isNaN(to.getTime())) {
    to = new Date(); // now
  }

  return { from, to };
}
exports.getStats = async (req, res) => {
  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({ msg: "Unauthorized" });
    }

    const { from, to } = getDateRange(req.query);

    const MAX_RANGE_MS = 1000 * 60 * 60 * 24 * 180;
    if (to - from > MAX_RANGE_MS) {
      return res.status(400).json({ msg: "Date range too large" });
    }

    // 🔥 1️⃣ Get machines of this org
    const { data: machines, error: machineError } = await supabase
      .from("machines")
      .select("id")
      .eq("organization_id", req.orgId);

    if (machineError) throw machineError;

    const machineIds = machines.map((m) => m.id);

    if (machineIds.length === 0) {
      return res.json({
        washes: 0,
        earnings: 0,
        totalUsers: 0,
        activeUsers: 0,
        machineBreakdown: [],
        rechargeRevenue: 0,
        rechargeCount: 0,
        from,
        to,
      });
    }

    // 🔥 2️⃣ Washes (ONLY this org)
    const { data: washes, error: washError } = await supabase
      .from("machine_logs")
      .select("id, machine_id, user_id, start_time")
      .in("machine_id", machineIds)
      .gte("start_time", from.toISOString())
      .lte("start_time", to.toISOString());

    if (washError) throw washError;

    // 🔥 3️⃣ Users (ONLY org members)
    const { data: members, error: memberError } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", req.orgId);

    if (memberError) throw memberError;

    const totalUsers = members.length;

    // 🔥 4️⃣ Active users
    const activeUsersSet = new Set(washes.map((w) => w.user_id));

    // 🔥 5️⃣ Machine breakdown
    const machineBreakdownMap = {};
    for (const wash of washes) {
      machineBreakdownMap[wash.machine_id] =
        (machineBreakdownMap[wash.machine_id] || 0) + 1;
    }

    const machineBreakdown = Object.entries(machineBreakdownMap).map(
      ([machine_id, washes]) => ({
        machine_id,
        washes,
      }),
    );

    // 🔥 6️⃣ Earnings (you can later replace with real cost logic)
    const appEarnings = (washes.length * 0.1).toFixed(2);

    // 🔥 7️⃣ Recharges (OPTIONAL: depends on your schema)
    const { data: recharges, error: rechargeError } = await supabase
  .from("recharges")
  .select("amount")
  .eq("organization_id", req.orgId)
  .gte("created_at", from.toISOString())
  .lte("created_at", to.toISOString());

    if (rechargeError) throw rechargeError;
    
    


    // Filter only org users
    const orgUserIds = new Set(members.map((m) => m.user_id));

    const filteredRecharges = recharges.filter((r) =>
      orgUserIds.has(r.user_id),
    );

   const rechargeTotal = recharges.reduce(
  (sum, r) => sum + Number(r.amount || 0),
  0
);

   res.json({
  washes: washes.length,
  earnings: appEarnings,
  totalUsers,
  activeUsers: activeUsersSet.size,
  machineBreakdown,
  rechargeRevenue: rechargeTotal.toFixed(2),
  rechargeCount: recharges.length,
  from,
  to,
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
};

exports.getGraphData = async (req, res) => {
  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({ msg: "Unauthorized" });
    }

    const { from, to } = getDateRange(req.query);

    const MAX_RANGE_MS = 1000 * 60 * 60 * 24 * 180;
    if (to - from > MAX_RANGE_MS) {
      return res.status(400).json({ msg: "Date range too large" });
    }

    // 🔥 1️⃣ Get machines of org
    const { data: machines } = await supabase
      .from("machines")
      .select("id")
      .eq("organization_id", req.orgId);

    const machineIds = machines.map((m) => m.id);

    // 🔥 2️⃣ Get org users
    const { data: members } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", req.orgId);

    const orgUserIds = new Set(members.map((m) => m.user_id));

    // 🔥 3️⃣ Fetch washes (filtered)
    let washes = [];
    if (machineIds.length > 0) {
      const { data } = await supabase
        .from("machine_logs")
        .select("start_time")
        .in("machine_id", machineIds)
        .gte("start_time", from.toISOString())
        .lte("start_time", to.toISOString());

      washes = data || [];
    }

    // 🔥 4️⃣ Fetch recharges (filtered)
    const { data: rechargesRaw } = await supabase
      .from("recharges")
      .select("created_at, amount, user_id")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());

    const recharges = (rechargesRaw || []).filter((r) =>
      orgUserIds.has(r.user_id)
    );

    const map = {};

    function toDateString(d) {
      return new Date(d).toISOString().slice(0, 10);
    }

    // 🔥 5️⃣ Aggregate washes
    for (const wash of washes) {
      const date = toDateString(wash.start_time);
      if (!map[date]) {
        map[date] = { date, washes: 0, rechargeAmount: 0, rechargeCount: 0 };
      }
      map[date].washes += 1;
    }

    // 🔥 6️⃣ Aggregate recharges
    for (const r of recharges) {
      const date = toDateString(r.created_at);
      if (!map[date]) {
        map[date] = { date, washes: 0, rechargeAmount: 0, rechargeCount: 0 };
      }
      map[date].rechargeAmount += Number(r.amount);
      map[date].rechargeCount += 1;
    }

    const data = Object.values(map).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    res.json({ data, from, to });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch graph data" });
  }
};

exports.getRecentTransactions = async (req, res) => {
  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({ msg: "Unauthorized" });
    }

    const lim = Math.min(Number(req.query.limit) || 10, 100);

    console.log("Current Org:", req.orgId);

    const { data: recharges, error } = await supabase
      .from("recharges")
      .select(`
        amount,
        created_at,
        user_id,
        profiles (
          id,
          username
        )
      `)
      .eq("organization_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(lim);

    if (error) throw error;

    const transactions = recharges.map((r) => ({
      type: "recharge",
      user_name: r.profiles?.username || r.user_id,
      time: r.created_at,
      amount: r.amount,
    }));

    res.json({ transactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch recent transactions" });
  }
};


