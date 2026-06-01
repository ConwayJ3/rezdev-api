require('dotenv').config();
require('express-async-errors');

const express    = require('express');
const rateLimit = require('express-rate-limit');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');

// Routes
const authRoutes        = require('./routes/auth');
const projectRoutes     = require('./routes/projects');
const phaseRoutes       = require('./routes/phases');
const budgetRoutes      = require('./routes/budget');
const messageRoutes     = require('./routes/messages');
const fileRoutes        = require('./routes/files');
const contractorRoutes  = require('./routes/contractors');
const userRoutes        = require('./routes/users');
const {
  coRouter, selRouter, ctrRouter, payRouter, wrnRouter, qcRouter, rfpRouter, pContractorRouter, lienRouter
} = require('./routes/projectRoutes');

const app = express();
app.set('trust proxy', 1); // Trust Railway's proxy

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // stricter for login
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/auth', authLimiter);
const signwellRouter = require('./routes/signwell');
app.use(generalLimiter);

// ── Security & Parsing ────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(','),
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use('/signwell', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
}, signwellRouter);
app.use(express.urlencoded({ extended: true }));
if(process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'rezdev-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    supabase_url: process.env.SUPABASE_URL,
  });
});

// ── Auth ──────────────────────────────────────────────────────────
app.use('/auth', authRoutes);

// ── Project-scoped routes ─────────────────────────────────────────
app.use('/projects', projectRoutes);
app.use('/projects/:projectId/phases',         phaseRoutes);
app.use('/projects/:projectId/budget',         budgetRoutes);
app.use('/projects/:projectId/messages',       messageRoutes);
app.use('/projects/:projectId/files',          fileRoutes);
app.use('/projects/:projectId/change-orders',  coRouter);
app.use('/projects/:projectId/contractors',    pContractorRouter);
app.use('/projects/:projectId/lien-waivers',  lienRouter);
app.use('/projects/:projectId/selections',     selRouter);
app.use('/projects/:projectId/contracts',      ctrRouter);
app.use('/projects/:projectId/payments',       payRouter);
app.use('/projects/:projectId/warranties',     wrnRouter);
app.use('/projects/:projectId/qc',             qcRouter);

// ── Top-level routes ──────────────────────────────────────────────
app.use('/contractors', contractorRoutes);
app.use('/users',       userRoutes);
app.use('/companies',   userRoutes);
app.use('/rfps',        rfpRouter);

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[RezDev API Error]', err.message, err.stack);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error:   err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 RezDev API running on port ${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});

module.exports = app;
