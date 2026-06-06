const express=require('express');
const {auth}=require('../middleware/auth');
const ProductionCheckAgent=require('../agents/ProductionCheckAgent');
const router=express.Router();

router.get('/',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await ProductionCheckAgent.check())}catch(e){next(e)}});

module.exports=router;
