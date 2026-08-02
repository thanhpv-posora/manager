const express=require('express');
const { auth }=require('../middleware/auth');
const ReturnAgent=require('../agents/ReturnAgent');
const router=express.Router();

// S9.3R — Sales Return UI + Business Workflow (Foundation revision). APPROVED
// removed per the locked FS — Manager Review is a permission gate on a future
// receive() action, not a status, so the old /approve route is gone.
// Return Request CREATION stays on the existing POST /api/orders/:id/returns
// (backend/src/routes/orders.js) — not duplicated or renamed here. This file
// only adds the top-level search/grid, single-return detail, and the Cancel
// action, none of which existed before S9.3.
//
// Roles mirror existing precedent in this codebase (auth() + role arrays is
// the only permission framework this codebase has — see ReturnAgent.js's own
// header comment on the repository-boundary audit): list/get match
// order list/get (ADMIN, STAFF, CUSTOMER — a customer may see their own
// returns, scope-enforced inside ReturnAgent via assertCustomerScope/
// customerScopeWhere); cancel matches Order Lock's role set (ADMIN, STAFF),
// not Order Cancel's ADMIN-only rule, since Cancel here has zero inventory/
// debt effect (nothing is ever posted while a return is REQUESTED — see
// ReturnAgent.cancel()).
//
// S9.4 — Warehouse Receive & Inspection. receive/inspect/complete/reject are
// all warehouse/back-office actions, never customer-initiated — there is no
// separate "warehouse" or "QC" role in this codebase (only ADMIN/STAFF/
// CUSTOMER), so these four follow the same ADMIN/STAFF precedent as cancel
// above, not a new role.
router.get('/', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ReturnAgent.listAll(req.query,req.user))}catch(e){next(e)}});
router.get('/:id', auth(['ADMIN','STAFF','CUSTOMER']), async (req,res,next)=>{try{res.json(await ReturnAgent.get(req.params.id,req.user))}catch(e){next(e)}});
router.post('/:id/cancel', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ReturnAgent.cancel(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.post('/:id/receive', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ReturnAgent.receive(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.post('/:id/inspect', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ReturnAgent.inspect(req.params.id,req.body,req.user))}catch(e){next(e)}});
router.post('/:id/complete', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ReturnAgent.complete(req.params.id,req.user))}catch(e){next(e)}});
router.post('/:id/reject', auth(['ADMIN','STAFF']), async (req,res,next)=>{try{res.json(await ReturnAgent.reject(req.params.id,req.body,req.user))}catch(e){next(e)}});

module.exports=router;
