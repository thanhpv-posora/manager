const express=require('express');
const {auth}=require('../middleware/auth');
const PriceMatrixAgent=require('../agents/PriceMatrixAgent');
const router=express.Router();
const pool=require('../config/db');

function effectivePayload(body={}){
  return {
    effective_from: body.effective_from || body.effectiveFrom || body.apply_date,
    effective_calendar_type: body.effective_calendar_type || body.effectiveCalendarType || body.calendar_type,
    effective_lunar_date_text: body.effective_lunar_date_text || body.effectiveLunarDateText || body.lunar_date_text
  };
}

router.get('/:customerId/books', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.listBooks(req.params.customerId))}catch(e){next(e)}});
router.get('/books/:bookId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.getBook(req.params.bookId))}catch(e){next(e)}});
router.put('/books/:bookId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.updateBook(req.params.bookId,{...req.body,...effectivePayload(req.body)},req.user.id))}catch(e){next(e)}});
router.delete('/books/:bookId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.deleteBook(req.params.bookId,req.user.id))}catch(e){next(e)}});
router.post('/books/:bookId/copy', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.copyBook(req.params.bookId,{...req.body,...effectivePayload(req.body)},req.user.id))}catch(e){next(e)}});


// V65.52: POS/import Excel preview must resolve prices by bill shipping date,
// not by today's date or the newest price book.
router.post('/:customerId/effective-prices', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{
  const PriceBookService=require('../services/PriceBookService');
  const body=req.body||{};
  const productIds=body.product_ids || body.productIds || (body.items||[]).map(x=>x.product_id);
  res.json(await PriceBookService.getEffectivePrices(req.params.customerId, productIds, {
    order_date: body.order_date || body.bill_date || body.date,
    calendar_type: body.calendar_type,
    lunar_date_text: body.lunar_date_text
  }));
}catch(e){next(e)}});

router.get('/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.matrix(req.params.customerId))}catch(e){next(e)}});
router.put('/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.saveMatrix(req.params.customerId, req.body.items, req.user.id, effectivePayload(req.body)))}catch(e){next(e)}});
router.get('/:customerId/catalog/order', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.customerCatalogForOrder(req.params.customerId))}catch(e){next(e)}});
router.post('/copy', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.copyCatalog(req.body.from_customer_id, req.body.to_customer_id, req.user.id, effectivePayload(req.body)))}catch(e){next(e)}});
router.put('/:customerId/catalog/reorder', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.reorderCatalog(req.params.customerId, req.body.items))}catch(e){next(e)}});

router.post('/:customerId/catalog', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{
  await pool.query(`INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
    VALUES(?,?,?,1,1,0)
    ON DUPLICATE KEY UPDATE is_active=1,del_flg=0,sort_order=VALUES(sort_order)`,
    [req.params.customerId,req.body.product_id,req.body.sort_order||999]);
  res.json({message:'Đã thêm mặt hàng vào danh mục khách'});
}catch(e){next(e)}});
router.post('/:customerId/save-all-safe', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.saveAllSafe(req.params.customerId,req.body,req.user))}catch(e){next(e)}});
module.exports=router;
