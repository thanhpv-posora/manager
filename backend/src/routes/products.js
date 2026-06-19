const express=require('express');
const { auth }=require('../middleware/auth');
const {assertCustomerScope}=require('../middleware/scope');
const ProductAgent=require('../agents/ProductAgent');
const router=express.Router();
router.get('/categories', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.categories())}catch(e){next(e)}});
router.post('/categories', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.addCategory(req.body))}catch(e){next(e)}});
router.put('/categories/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.updateCategory(req.params.id,req.body))}catch(e){next(e)}});
router.delete('/categories/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.removeCategory(req.params.id,req.body.reason,req.user.id))}catch(e){next(e)}});
router.post('/mark-carcass-parts', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.markCarcassParts())}catch(e){next(e)}});
router.get('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.products(req.query.q||''))}catch(e){next(e)}});
router.post('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.addProduct(req.body))}catch(e){next(e)}});
router.put('/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.updateProduct(req.params.id,req.body))}catch(e){next(e)}});
router.put('/:id/price', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.updatePrice(req.params.id,req.body))}catch(e){next(e)}});
router.delete('/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.removeProduct(req.params.id,req.body.reason,req.user.id))}catch(e){next(e)}});
router.get('/customer/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{
  await assertCustomerScope(req.user, req.params.customerId);
  res.json(await ProductAgent.customerProducts(req.params.customerId))}catch(e){next(e)}});
router.put('/customer-prices/:customerId/:productId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{
  await assertCustomerScope(req.user, req.params.customerId);
  res.json(await ProductAgent.updateCustomerPrice(req.params.customerId,req.params.productId,req.body.sale_price,req.body.effective_from,req.user.id))}catch(e){next(e)}});
router.get('/next-code/:categoryId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json({product_code:await ProductAgent.nextProductCode(req.params.categoryId)})}catch(e){next(e)}});
router.post('/quick', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.quickProduct(req.body))}catch(e){next(e)}});
module.exports=router;
