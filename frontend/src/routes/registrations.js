const express=require('express');
const {auth}=require('../middleware/auth');
const RegistrationAgent=require('../agents/RegistrationAgent');
const router=express.Router();

router.post('/public',async(req,res,next)=>{try{res.json(await RegistrationAgent.create(req.body,req))}catch(e){next(e)}});
router.get('/verify-email',async(req,res,next)=>{try{res.json(await RegistrationAgent.verifyEmail(req.query.token||req.body?.token,req))}catch(e){next(e)}});
router.post('/resend-email',async(req,res,next)=>{try{res.json(await RegistrationAgent.resendEmailVerify(req.body.identifier||req.body.email||req.body.phone||req.body.username,req))}catch(e){next(e)}});
router.post('/phone-otp',async(req,res,next)=>{try{res.json(await RegistrationAgent.requestPhoneOtp(req.body.identifier||req.body.phone||req.body.username||req.body.email,req))}catch(e){next(e)}});
router.post('/verify-phone',async(req,res,next)=>{try{res.json(await RegistrationAgent.verifyPhone({identifier:req.body.identifier||req.body.phone||req.body.username||req.body.email,otp:req.body.otp||req.body.code},req))}catch(e){next(e)}});

router.get('/',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await RegistrationAgent.list())}catch(e){next(e)}});
router.put('/:id/status',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await RegistrationAgent.updateStatus(req.params.id,req.body.status,req.user?.id))}catch(e){next(e)}});

module.exports=router;
