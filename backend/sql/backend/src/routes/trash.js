const express=require('express');
const {auth}=require('../middleware/auth');
const SoftDeleteAgent=require('../agents/SoftDeleteAgent');
const router=express.Router();

router.get('/logs',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SoftDeleteAgent.logs())}catch(e){next(e)}});
router.get('/:entityType',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SoftDeleteAgent.deletedList(req.params.entityType))}catch(e){next(e)}});

module.exports=router;
