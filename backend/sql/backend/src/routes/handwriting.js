const express=require('express');
const {auth}=require('../middleware/auth');
const HandwritingBillAgent=require('../agents/HandwritingBillAgent');
const router=express.Router();
router.get('/aliases',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await HandwritingBillAgent.aliases(req.query.customer_id))}catch(e){next(e)}});
router.post('/aliases',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await HandwritingBillAgent.saveAlias(req.body))}catch(e){next(e)}});
module.exports=router;
