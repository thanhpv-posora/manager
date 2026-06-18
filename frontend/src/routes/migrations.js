const express=require('express');
const {auth}=require('../middleware/auth');
const AutoMigrationAgent=require('../agents/AutoMigrationAgent');
const router=express.Router();

router.get('/check',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await AutoMigrationAgent.check())}catch(e){next(e)}});
router.post('/run',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await AutoMigrationAgent.run())}catch(e){next(e)}});

module.exports=router;
