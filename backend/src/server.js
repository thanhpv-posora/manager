require('dotenv').config();
const express=require('express');
const AutoMigrationAgent=require('./agents/AutoMigrationAgent');
const SchemaMigrationAgent=require('./agents/SchemaMigrationAgent');
const cors=require('cors');
const { ensureSchema }=require('./config/bootstrap');
const { errorHandler }=require('./middleware/errorHandler');

const app=express();
app.use(cors());
app.use(express.json({limit:'10mb'}));

app.get('/api/health',(req,res)=>res.json({ok:true,name:'meatbiz-api',version:'6.6.0'}));

app.use('/api/auth',require('./routes/auth'));
app.use('/api/customers',require('./routes/customers'));
app.use('/api/products',require('./routes/products'));
app.use('/api/orders',require('./routes/orders'));
app.use('/api/payments',require('./routes/payments'));
app.use('/api/suppliers',require('./routes/suppliers'));
app.use('/api/lots',require('./routes/lots'));
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

app.use(errorHandler);

const port=Number(process.env.PORT||4000);
ensureSchema()
  .then(()=>app.listen(port,()=>console.log(`API running on http://localhost:${port}`)))
  .catch(e=>{console.error('DB bootstrap failed',e);process.exit(1);});
