// backend/server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
require("./services/mqttClient");
const { startMachineScheduler,runStartupRecovery } = require("./services/machineScheduler");
const cookieParser = require('cookie-parser');


const app = express();

// ✅ Trust only Cloudflare proxy IP ranges (real client IP from X-Forwarded-For)
app.set('trust proxy', [
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17'
]);

const helmet = require('helmet');
app.use(helmet());
app.use(
  helmet.hsts({
    maxAge: 31536000, // 1 year in seconds
    includeSubDomains: true,
    preload: true
  })
);
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      // connectSrc: ["'self'", process.env.FRONTEND_URL || 'http://localhost:5173'],
      connectSrc: ["'self'", "*"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    }
  })
);

app.use(cookieParser());

app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    "http://localhost:5173"
  ],
  credentials: true
}));




// ✅ Stripe webhook needs raw body BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripeWebhook'));

app.use(express.json());

// const morgan = require('morgan');
// app.use(morgan('combined'));

const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max requests per IP
  message: 'Too many requests from this IP, please try again later.',
  // don’t count preflights; don’t count status polling
  skip: (req) => req.method === 'OPTIONS' || req.path === '/machine/status'
});

app.use('/api/', apiLimiter);


// Routes
const userRoutes = require('./routes/user');
app.use('/api/user', userRoutes);

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

const stripeRoutes = require('./routes/stripe');
app.use('/api/stripe', stripeRoutes);

const machineRoutes = require('./routes/machine');
app.use('/api/machine', machineRoutes);

const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes);

const publicRoutes = require('./routes/public');
app.use('/', publicRoutes);


const orgRoutes =require('./routes/orgRoutes')
app.use('/api/org',orgRoutes)


const sendmail= require("./routes/sendmail");
app.use("/api/sendmail",sendmail)

const logsRoutes = require("./routes/logs");
app.use("/api/logs", logsRoutes);

const adminMachineControl = require("./routes/adminMachineControl");
app.use("/api/test", adminMachineControl);


const telemetryRoutes = require("./routes/telematry");
app.use("/api/telemetry", telemetryRoutes);

const activation = require("./routes/activationchipid");
app.use("/api/active",activation)

const superAdminMachine = require("./controllers/superAdminMachine")
app.use("/api/superMachine", superAdminMachine)


// Start server
const PORT = process.env.PORT || 5000;

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong.' });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);

  await runStartupRecovery();

  startMachineScheduler();
});