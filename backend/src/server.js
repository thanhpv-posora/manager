require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const express=require('express');
const cors=require('cors');
const rateLimit=require('express-rate-limit');
const AutoMigrationAgent=require('./agents/AutoMigrationAgent');
const SchemaMigrationAgent=require('./agents/SchemaMigrationAgent');
const { ensureSchema }=require('./config/bootstrap');
const { errorHandler }=require('./middleware/errorHandler');
const { requestFileLogger } = require('./middleware/requestFileLogger');
const fileLogger = require('./services/fileLogger.service');
const { validateStartupConfig, parseAllowedOrigins } = require('./config/startupValidator');

function buildCorsOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowed = parseAllowedOrigins();
  if (!isProd && allowed.length === 0) {
    return { origin: ['http://localhost:5173', 'http://localhost:3000'], credentials: true };
  }
  return {
    origin: (origin, callback) => {
      if (!origin || allowed.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  };
}

const aiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Quá nhiều yêu cầu AI. Vui lòng thử lại sau.' },
});

const app=express();
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '10mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '10mb' }));
app.use(express.static('public'));
app.use(requestFileLogger);

app.get('/api/health',(req,res)=>res.json({ok:true,name:'meatbiz-api',version:'6.6.0'}));

app.use('/api/auth',require('./routes/auth'));
app.use('/api/customers',require('./routes/customers'));
app.use('/api/products',require('./routes/products'));
app.use('/api/orders',require('./routes/orders'));
app.use('/api/payments',require('./routes/payments'));
app.use('/api/suppliers',require('./routes/suppliers'));
app.use('/api/lots',require('./routes/lots'));
app.use('/api/units',require('./routes/units'));
app.use('/api/supplier-purchase-options',require('./routes/supplier-purchase-options.routes'));
app.use('/api/reports',require('./routes/reports'));
app.use('/api/agents',require('./routes/agents'));
app.use('/api/trash',require('./routes/trash'));
app.use('/api/price-matrix',require('./routes/priceMatrix'));
app.use('/api/settings',require('./routes/settings'));
app.use('/api/installments',require('./routes/installments'));
app.use('/api/portal',require('./routes/portal'));
app.use('/api/handwriting',require('./routes/handwriting'));
app.use('/api/user-mapping',require('./routes/userMapping'));
app.use('/api/videos',require('./routes/videos'));
app.use('/api/uploads',require('./routes/videoUploads'));
app.use('/api/ai-learning',require('./routes/aiLearning'));
app.use('/api/production-check',require('./routes/productionCheck'));
app.use('/api/schema',require('./routes/schema'));
app.use('/api/migrations',require('./routes/migrations'));
app.use('/api/registrations',require('./routes/registrations'));
app.use('/api/product-import',require('./routes/productImport'));
app.use('/api/ocr-providers',require('./routes/ocrProviders'));
app.use('/api/preferences',require('./routes/preferences'));
app.use('/api/permissions',require('./routes/permissions'));
const aiRoutes = require('./routes/ai.routes');
app.use('/api/ai', aiRateLimit, aiRoutes);
app.use('/api/logs', require('./routes/logs.routes'));

app.use(errorHandler);

process.on('uncaughtException', (err) => {
  fileLogger.logError('UNCAUGHT_EXCEPTION', { error: err });
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

process.on('unhandledRejection', (reason) => {
  fileLogger.logError('UNHANDLED_REJECTION', { error: reason });
  console.error('[UNHANDLED_REJECTION]', reason);
});

const port=Number(process.env.PORT||4000);
validateStartupConfig()
  .then(()=>ensureSchema())
  .then(()=>app.listen(port,()=>{ console.log(`API running on http://localhost:${port}`); fileLogger.logSystem('SERVER_STARTED', { port }); }))
  .catch(e=>{ fileLogger.logError('DB_BOOTSTRAP_FAILED', { error: e }); console.error('DB bootstrap failed',e);process.exit(1);});
