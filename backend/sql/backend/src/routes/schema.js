const express=require('express');
const {auth}=require('../middleware/auth');
const SchemaMigrationAgent=require('../agents/SchemaMigrationAgent');
const router=express.Router();

router.get('/check',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await SchemaMigrationAgent.check())}catch(e){next(e)}});
router.post('/migrate',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await SchemaMigrationAgent.migrate())}catch(e){next(e)}});

module.exports=router;
