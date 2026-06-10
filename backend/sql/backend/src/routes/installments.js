const express=require('express');
const {auth}=require('../middleware/auth');
const DebtInstallmentAgent=require('../agents/DebtInstallmentAgent');
const DebtMonthlyInstallmentAgent=require('../agents/DebtMonthlyInstallmentAgent');
const router=express.Router();

router.get('/monthly',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtMonthlyInstallmentAgent.list(req.query.month,req.query.year,req.query.calendar_type))}catch(e){next(e)}});
router.get('/monthly/active',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{
  if(req.query.date || req.query.lunar_date_text){
    return res.json(await DebtMonthlyInstallmentAgent.activeByDate(req.query.customer_id,req.query.date,req.query.calendar_type,req.query.lunar_date_text));
  }
  res.json(await DebtMonthlyInstallmentAgent.getActiveInstallment(req.query.customer_id,req.query.month,req.query.year,req.query.calendar_type,req.query.day));
}catch(e){next(e)}});
router.post('/monthly/apply',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtMonthlyInstallmentAgent.applyMonthlyInstallments(req.body))}catch(e){next(e)}});
router.get('/monthly/stats',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtMonthlyInstallmentAgent.stats(req.query))}catch(e){next(e)}});
router.get('/monthly/stats-range',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtMonthlyInstallmentAgent.statsRange(req.query))}catch(e){next(e)}});
router.put('/monthly/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtMonthlyInstallmentAgent.updateMonthlyInstallment(req.params.id,req.body))}catch(e){next(e)}});
router.delete('/monthly/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtMonthlyInstallmentAgent.softDeleteMonthlyInstallment(req.params.id))}catch(e){next(e)}});

router.get('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.list(req.query.customer_id))}catch(e){next(e)}});
router.post('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.create(req.body,req.user))}catch(e){next(e)}});
router.put('/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.update(req.params.id,req.body))}catch(e){next(e)}});
router.post('/:id/payments',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.addPayment(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.delete('/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.cancel(req.params.id,req.body.reason))}catch(e){next(e)}});
router.get('/:id/payments',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await DebtInstallmentAgent.payments(req.params.id))}catch(e){next(e)}});

module.exports=router;
