const express=require('express');
const {auth}=require('../middleware/auth');
const CustomerAgent=require('../agents/CustomerAgent');
const router=express.Router();

router.get('/',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await CustomerAgent.list(req.user))}catch(e){next(e)}});
router.get('/next-code',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await CustomerAgent.nextCode())}catch(e){next(e)}});
router.post('/',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await CustomerAgent.create(req.body,req.user))}catch(e){next(e)}});
router.put('/:id',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await CustomerAgent.update(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.delete('/:id',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await CustomerAgent.remove(req.params.id,req.body?.reason,req.user))}catch(e){next(e)}});

module.exports=router;
