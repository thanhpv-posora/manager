const express=require('express');
const {auth}=require('../middleware/auth');
const UserCustomerMappingAgent=require('../agents/UserCustomerMappingAgent');
const router=express.Router();

router.get('/',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.list())}catch(e){next(e)}});
router.get('/registrations',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.pendingRegistrations())}catch(e){next(e)}});
router.post('/registrations/:id/approve',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.approveRegistration(req.params.id,req.user?.id))}catch(e){next(e)}});
router.post('/registrations/:id/reject',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.rejectRegistration(req.params.id))}catch(e){next(e)}});
router.post('/map',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.mapUser(req.body))}catch(e){next(e)}});
router.post('/user',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.createUser(req.body))}catch(e){next(e)}});
router.post('/users/:id/lock',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.lockUser(req.params.id))}catch(e){next(e)}});
router.post('/users/:id/unlock',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.unlockUser(req.params.id))}catch(e){next(e)}});
router.post('/users/:id/reset-password',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.resetPassword(req.params.id,req.body.password))}catch(e){next(e)}});
router.post('/customer-user',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.createCustomerUser(req.body))}catch(e){next(e)}});
module.exports=router;
