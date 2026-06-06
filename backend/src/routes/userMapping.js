const express=require('express');
const {auth}=require('../middleware/auth');
const UserCustomerMappingAgent=require('../agents/UserCustomerMappingAgent');
const router=express.Router();
router.get('/',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.list())}catch(e){next(e)}});
router.post('/map',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.mapUser(req.body))}catch(e){next(e)}});
router.post('/customer-user',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserCustomerMappingAgent.createCustomerUser(req.body))}catch(e){next(e)}});
module.exports=router;
