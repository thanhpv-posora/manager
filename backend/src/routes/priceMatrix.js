const express=require('express');
const {auth}=require('../middleware/auth');
const PriceMatrixAgent=require('../agents/PriceMatrixAgent');
const router=express.Router();
const pool=require('../config/db');

router.get('/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.matrix(req.params.customerId))}catch(e){next(e)}});
router.put('/:customerId', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.saveMatrix(req.params.customerId, req.body.items, req.user.id))}catch(e){next(e)}});
router.get('/:customerId/catalog/order', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.customerCatalogForOrder(req.params.customerId))}catch(e){next(e)}});
router.post('/copy', auth(['ADMIN','STAFF','CUSTOMER']), async(req,res,next)=>{try{res.json(await PriceMatrixAgent.copyCatalog(req.body.from_customer_id, req.body.to_customer_id, req.user.id))}catch(e){next(e)}});
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
