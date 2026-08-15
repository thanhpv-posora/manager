const express=require('express');
const { auth }=require('../middleware/auth');
const QRCode=require('qrcode');
const OrderAgent=require('../agents/OrderAgent');
const ReturnAgent=require('../agents/ReturnAgent');
const router=express.Router();

// A4 print options are presentation-only and never persisted. Only an exact
// showUnpaid=0 disables the unpaid-bills section — absent/empty/unknown/
// malformed values (undefined, '', 'abc', '01', ...) all fall back to true so
// every existing/shared/bookmarked print link keeps rendering it.
function parseShowUnpaid(v){ return String(v) !== '0'; }

router.get('/public/:token/print', async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await OrderAgent.printHtmlByToken(req.params.token,{showUnpaid:parseShowUnpaid(req.query.showUnpaid)}))}catch(e){next(e)}});
router.get('/public/:token/k80', async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await OrderAgent.printK80ByToken(req.params.token))}catch(e){next(e)}});
router.get('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.list(req.user,req.query))}catch(e){next(e)}});
router.post('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.create(req.body,req.user))}catch(e){next(e)}});
router.get('/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.get(req.params.id,req.user))}catch(e){next(e)}});
function getPublicAppUrl(req){
  const envUrl=process.env.PUBLIC_APP_URL||process.env.FRONTEND_PUBLIC_URL||process.env.FRONTEND_URL||process.env.APP_URL||process.env.SITE_URL;
  if(envUrl) return String(envUrl).replace(/\/$/,'');
  const proto=String(req.headers['x-forwarded-proto']||req.protocol||'https').split(',')[0].trim();
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'meatbiz.posora.vn').split(',')[0].trim();
  if(!host || /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(host)) return 'https://meatbiz.posora.vn';
  return `${proto}://${host}`.replace(/\/$/,'');
}
router.get('/:id/qrcode', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{
  const o=await OrderAgent.get(req.params.id,req.user);
  if(!o.private_token){const e=new Error('Bill chưa có token in hóa đơn');e.status=500;e.statusCode=500;throw e;}
  const app=getPublicAppUrl(req); const token=o.private_token; const url=`${app}/bill/${token}`;
  res.json({url,token,qrcode:await QRCode.toDataURL(url)})
}catch(e){next(e)}});
router.get('/:id/print', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.send(await OrderAgent.printHtmlById(req.params.id,req.user,{showUnpaid:parseShowUnpaid(req.query.showUnpaid)}))}catch(e){next(e)}});
router.post('/:id/lock', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await OrderAgent.lock(req.params.id,req.body,req.user))}catch(e){next(e)}});
// S8.2: ADMIN only per CEO directive — not STAFF (despite PaymentAgent's cancel precedent), not CUSTOMER.
router.post('/:id/cancel', auth(['ADMIN']), async (req,res,next)=>{try{res.json(await OrderAgent.cancel(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.post('/:id/items', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.addItem(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.put('/:id/items/:itemId', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await OrderAgent.updateItem(req.params.id,req.params.itemId,req.body,req.user))}catch(e){next(e)}});
// S9.2: Sales Return Foundation — Create/List Return Request only. Same role list
// as order create/list (line 9-10 above): a customer may request a return on their
// own bill, scope-enforced inside ReturnAgent via assertCustomerScope.
router.post('/:id/returns', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ReturnAgent.create(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.get('/:id/returns', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ReturnAgent.list(req.params.id,req.user))}catch(e){next(e)}});
module.exports=router;
