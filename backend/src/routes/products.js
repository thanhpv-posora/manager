const express=require('express');
const { auth }=require('../middleware/auth');
const {assertCustomerScope}=require('../middleware/scope');
const ProductAgent=require('../agents/ProductAgent');
const router=express.Router();
// P0-003: shared-catalog mutation routes are ADMIN/STAFF only. ProductAgent
// itself has no downstream role check (confirmed by audit), so the route
// gate here is the sole authorization boundary — CUSTOMER must never reach
// these. Read-only routes below (categories/list/customer-scoped list/
// next-code) are unchanged; they were never the vulnerability.
router.get('/categories', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.categories(req.query.all==='1'))}catch(e){next(e)}});
router.post('/categories', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.addCategory(req.body))}catch(e){next(e)}});
router.put('/categories/:id', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.updateCategory(req.params.id,req.body))}catch(e){next(e)}});
router.delete('/categories/:id', auth(['ADMIN']), async (req,res,next)=>{try{res.json(await ProductAgent.removeCategory(req.params.id,req.body.reason,req.user.id))}catch(e){next(e)}});
router.get('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ProductAgent.products(req.query.q||'',req.query.inventory_mode||''))}catch(e){next(e)}});
router.post('/', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.addProduct(req.body))}catch(e){next(e)}});
router.put('/:id', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.updateProduct(req.params.id,req.body))}catch(e){next(e)}});
router.put('/:id/price', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.updatePrice(req.params.id,req.body))}catch(e){next(e)}});
router.delete('/:id', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.removeProduct(req.params.id,req.body.reason,req.user.id))}catch(e){next(e)}});
router.get('/customer/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{
  await assertCustomerScope(req.user, req.params.customerId);
  res.json(await ProductAgent.customerProducts(req.params.customerId))}catch(e){next(e)}});
router.put('/customer-prices/:customerId/:productId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{
  await assertCustomerScope(req.user, req.params.customerId);
  res.json(await ProductAgent.updateCustomerPrice(req.params.customerId,req.params.productId,req.body.sale_price,req.body.effective_from,req.user.id))}catch(e){next(e)}});
router.get('/next-code/:categoryId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json({product_code:await ProductAgent.nextProductCode(req.params.categoryId)})}catch(e){next(e)}});
// Sole caller is CreateOrder.jsx's Bò Xô quick-add (see ProductAgent.quickProduct's
// own comment) — CUSTOMER has no menu grant to create-order by default
// (bootstrap.js role_menu_permissions seed) and no other caller exists anywhere
// in the frontend. No CUSTOMER workflow requires this route.
router.post('/quick', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ProductAgent.quickProduct(req.body))}catch(e){next(e)}});
module.exports=router;
