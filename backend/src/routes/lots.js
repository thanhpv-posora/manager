const express=require('express');
const { auth }=require('../middleware/auth');
const SupplierAgent=require('../agents/SupplierAgent');
const router=express.Router();
// Public by design (the printed voucher carries a QR the supplier scans), but
// addressed by an unguessable token — NOT the row id. The previous
// '/public/:id/print' let any unauthenticated caller walk id=1,2,3... and read
// every lot's supplier name/phone/address, purchase unit prices, total cost and
// outstanding balance. Same token mechanism as the public order bill.
router.get('/public/:token/print', async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await SupplierAgent.printLotByToken(req.params.token))}catch(e){next(e)}});
router.get('/', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await SupplierAgent.lots())}catch(e){next(e)}});
router.post('/', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await SupplierAgent.createLot(req.body,req.user))}catch(e){next(e)}});
router.get('/:id/print', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await SupplierAgent.printLot(req.params.id))}catch(e){next(e)}});
router.put('/:id/status', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await SupplierAgent.updateLotStatus(req.params.id,req.body.status,req.user))}catch(e){next(e)}});
router.put('/:id/price', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await SupplierAgent.priceLot(req.params.id,req.user))}catch(e){next(e)}});
router.put('/:id', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await SupplierAgent.updateLot(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.post('/:id/payments', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await SupplierAgent.payLot(req.params.id,req.body,req.user))}catch(e){next(e)}});
module.exports=router;
