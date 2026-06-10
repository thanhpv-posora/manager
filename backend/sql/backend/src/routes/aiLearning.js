const express=require('express');
const {auth}=require('../middleware/auth');
const AILearningAgent=require('../agents/AILearningAgent');
const router=express.Router();

router.get('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await AILearningAgent.list(req.query))}catch(e){next(e)}});
router.post('/',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await AILearningAgent.log(req.body,req.user))}catch(e){next(e)}});

module.exports=router;
