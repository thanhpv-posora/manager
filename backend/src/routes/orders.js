const express=require('express');
const { auth }=require('../middleware/auth');
const QRCode=require('qrcode');
const OrderAgent=require('../agents/OrderAgent');
const router=express.Router();

router.get('/public/:token/print', async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await OrderAgent.printHtmlByToken(req.params.token))}catch(e){next(e)}});
router.get('/public/:token/k80', async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await OrderAgent.printK80ByToken(req.params.token))}catch(e){next(e)}});
router.get('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.list(req.user))}catch(e){next(e)}});
router.post('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.create(req.body,req.user))}catch(e){next(e)}});
router.get('/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.get(req.params.id,req.user))}catch(e){next(e)}});
router.get('/:id/qrcode', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{const o=await OrderAgent.get(req.params.id,req.user); const app=process.env.PUBLIC_APP_URL||'http://localhost:5173'; const token=o.private_token||o.order_code; const url=`${app}/bill/${token}`; res.json({url,token,qrcode:await QRCode.toDataURL(url)})}catch(e){next(e)}});
router.get('/:id/print', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await OrderAgent.printHtmlById(req.params.id))}catch(e){next(e)}});
router.put('/:id/items/:itemId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.updateItem(req.params.id,req.params.itemId,req.body))}catch(e){next(e)}});
module.exports=router;
