const express=require('express');
const {auth}=require('../middleware/auth');
const DebtInstallmentAgent=require('../agents/DebtInstallmentAgent');
const router=express.Router();

router.get('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.list(req.query.customer_id))}catch(e){next(e)}});
router.post('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.create(req.body,req.user))}catch(e){next(e)}});
router.put('/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.update(req.params.id,req.body))}catch(e){next(e)}});
router.post('/:id/payments',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.addPayment(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.delete('/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.cancel(req.params.id,req.body.reason))}catch(e){next(e)}});
router.get('/:id/payments',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.payments(req.params.id))}catch(e){next(e)}});

module.exports=router;
