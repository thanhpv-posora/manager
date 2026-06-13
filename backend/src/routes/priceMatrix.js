const express=require('express');
const {auth}=require('../middleware/auth');
const PriceMatrixAgent=require('../agents/PriceMatrixAgent');
const router=express.Router();

router.get('/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.matrix(req.params.customerId,req.user))}catch(e){next(e)}});
router.put('/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.saveMatrix(req.params.customerId, req.body.items, req.user))}catch(e){next(e)}});
router.get('/:customerId/catalog/order', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.customerCatalogForOrder(req.params.customerId,req.user))}catch(e){next(e)}});
router.post('/copy', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.copyCatalog(req.body.from_customer_id, req.body.to_customer_id, req.user))}catch(e){next(e)}});
router.put('/:customerId/catalog/reorder', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.reorderCatalog(req.params.customerId, req.body.items, req.user))}catch(e){next(e)}});
router.post('/:customerId/catalog', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.addCatalog(req.params.customerId,req.body.product_id,req.body.sort_order,req.user))}catch(e){next(e)}});
router.post('/:customerId/save-all-safe', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.saveAllSafe(req.params.customerId,req.body,req.user))}catch(e){next(e)}});
module.exports=router;
