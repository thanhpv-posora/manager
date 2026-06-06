const express=require('express');
const {auth}=require('../middleware/auth');
const RegistrationAgent=require('../agents/RegistrationAgent');
const router=express.Router();

router.post('/public',async(req,res,next)=>{try{res.json(await RegistrationAgent.create(req.body))}catch(e){next(e)}});
router.get('/',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await RegistrationAgent.list())}catch(e){next(e)}});
router.put('/:id/status',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await RegistrationAgent.updateStatus(req.params.id,req.body.status))}catch(e){next(e)}});

module.exports=router;
