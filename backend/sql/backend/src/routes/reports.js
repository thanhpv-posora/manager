const express=require('express');
const { auth }=require('../middleware/auth');
const ReportAgent=require('../agents/ReportAgent');
const router=express.Router();
router.get('/dashboard', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ReportAgent.dashboard(req.user))}catch(e){next(e)}});
router.get('/revenue', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ReportAgent.revenue(req.query,req.user))}catch(e){next(e)}});
module.exports=router;
