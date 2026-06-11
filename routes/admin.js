const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const multer = require('multer');
const path = require('path');
const { verifyAdmin } = require('../middleware/verifyAdmin');
const { authMiddleware, requireOrg } = require('../middleware/orgMiddleware');

const rateLimit = require('express-rate-limit');

// const adminLimiter = rateLimit({
//   windowMs: 1 * 60 * 1000, // 1 minute
//   max: 50, // Max 50 requests per 1 min
//   message: 'Too many requests from this admin. Please try again later.'
// });

// router.use(adminLimiter);


// Set up storage engine
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads'); // Save files in 'uploads' directory
  },
  filename: function (req, file, cb) {
    cb(null, 'agb.pdf'); // Always overwrite with the latest AGB
  }
});

// const upload = multer({ storage: storage });
// Add file filter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files allowed'));
    }
    cb(null, true);
  }
});


// Protect all routes below this line
// router.use(verifyAdmin);
router.use(authMiddleware);
router.use(requireOrg);

const supabase = require('../utils/supabaseAdmin');

router.get('/users', async (req, res) => {
  try {
    // 1️⃣ Check org admin
    if (req.org.role !== 'admin') {
      return res.status(403).json({ msg: 'Unauthorized' });
    }

    // 2️⃣ Get users of THIS org only
    const { data, error } = await supabase
      .from('organization_members')
      .select(`
        user_id,
        role,
        balance,
        profiles (
          id,
          username,
          room_number
        )
      `)
      .eq('organization_id', req.orgId);

    if (error) throw error;

    // 3️⃣ Format response
    const users = data.map((u) => ({
      id: u.profiles?.id,
      username: u.profiles?.username,
      room_number: u.profiles?.room_number,
      role: u.role,
      balance:u.balance
    }));

    res.json(users);

  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ msg: 'Error fetching users' });
  }
});


router.get('/logs', async (req, res) => {
  try {
    // 1️⃣ Check admin
    if (req.org.role !== 'admin') {
      return res.status(403).json({ msg: 'Unauthorized' });
    }

    // 2️⃣ Get machines of THIS org
    const { data: machines, error: machineError } = await supabase
      .from('machines')
      .select('id, machine_code')
      .eq('organization_id', req.orgId);

    if (machineError) throw machineError;

    const machineIds = machines.map(m => m.id);

    if (machineIds.length === 0) {
      return res.json([]);
    }

    // 3️⃣ Fetch logs only for those machines
    const { data: logs, error } = await supabase
      .from('machine_logs')
      .select(`
        id,
        start_time,
        end_time,
        was_force_stopped,
        machine_id,
        profiles ( username )
      `)
      .in('machine_id', machineIds)
      .order('start_time', { ascending: false });

    if (error) throw error;

    // 4️⃣ Map machine_id → machine_code
    const machineMap = {};
    machines.forEach(m => {
      machineMap[m.id] = m.machine_code;
    });

    // 5️⃣ Format response
    const formatted = logs.map(log => ({
      id: log.id,
      machine: machineMap[log.machine_id] || 'Unknown',
      email: log.profiles?.username || 'Unknown',
      startTime: log.start_time,
      endTime: log.end_time,
      wasForceStopped: log.was_force_stopped
    }));

    res.json(formatted);

  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to fetch logs');
  }
});

router.get("/logs/user/:userId", async (req, res) => {
  try {
    if (req.org.role !== "admin") {
      return res.status(403).json({ msg: "Unauthorized" });
    }

    const { userId } = req.params;

    // Organization ki machines
    const { data: machines, error: machineError } = await supabase
      .from("machines")
      .select("id, machine_code")
      .eq("organization_id", req.orgId);

    if (machineError) throw machineError;

    const machineIds = machines.map((m) => m.id);

    // Sirf us user ke logs
    const { data: logs, error } = await supabase
      .from("machine_logs")
      .select(`
        id,
        start_time,
        end_time,
        was_force_stopped,
        machine_id,
        user_id,
        profiles(username)
      `)
      .eq("user_id", userId)
      .in("machine_id", machineIds)
      .order("start_time", { ascending: false });

    if (error) throw error;

    const machineMap = {};
    machines.forEach((m) => {
      machineMap[m.id] = m.machine_code;
    });

    res.json(
      logs.map((log) => ({
        id: log.id,
        machine: machineMap[log.machine_id],
        email: log.profiles?.username,
        startTime: log.start_time,
        endTime: log.end_time,
        wasForceStopped: log.was_force_stopped,
      }))
    );
  }catch (err) {
    console.error("USER LOG ERROR:", err);

    res.status(500).json({
      error: err.message,
      details: err,
    });
  }
});
router.get('/stats', adminController.getStats);

router.get('/graph', adminController.getGraphData);

router.get('/recent-transactions', adminController.getRecentTransactions);

// Upload AGB PDF
router.post(
  '/upload-agb',
  authMiddleware,
  requireOrg,
  upload.single('agb'),
  async (req, res) => {
    try {
      // 🔐 Only org admin
      if (req.org.role !== 'admin') {
        return res.status(403).json({ msg: 'Unauthorized' });
      }

      if (!req.file) {
        return res.status(400).json({ msg: 'No file uploaded' });
      }

      // 🔥 Org-specific AGB
      const filePath = `agb/${req.orgId}/latest.pdf`;

      const { error } = await supabase.storage
        .from('documents')
        .upload(filePath, req.file.buffer, {
          contentType: 'application/pdf',
          upsert: true
        });

      if (error) throw error;

      console.log(`AGB uploaded for org ${req.orgId}`);

      res.json({
        msg: 'AGB uploaded successfully',
        path: filePath
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ msg: 'Upload failed' });
    }
  }
);


module.exports = router;