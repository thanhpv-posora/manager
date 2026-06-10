const express=require('express');
const {auth}=require('../middleware/auth');
const ProductImageImportAgent=require('../agents/ProductImageImportAgent');
const router=express.Router();

router.post('/preview',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await ProductImageImportAgent.preview(req.body.rows||[]))}catch(e){next(e)}});
router.post('/save',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await ProductImageImportAgent.save(req.body.rows||[],req.user))}catch(e){next(e)}});
router.get('/next-code/:categoryId?',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json({product_code:await ProductImageImportAgent.nextCodeByCategory(req.params.categoryId)})}catch(e){next(e)}});

module.exports=router;
