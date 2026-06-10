const express=require('express');
const {auth}=require('../middleware/auth');
const SponsorVideoAgent=require('../agents/SponsorVideoAgent');
const router=express.Router();

router.get('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.list(false))}catch(e){next(e)}});
router.get('/deleted',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.deleted())}catch(e){next(e)}});
router.post('/idea',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.generateIdea(req.body))}catch(e){next(e)}});
router.post('/',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.createFromIdea(req.body))}catch(e){next(e)}});
router.put('/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.updateVideo(req.params.id,req.body))}catch(e){next(e)}});
router.delete('/:id',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.softDelete(req.params.id,req.body?.reason))}catch(e){next(e)}});
router.post('/:id/restore',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.restore(req.params.id))}catch(e){next(e)}});
router.delete('/:id/hard',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.hardDelete(req.params.id))}catch(e){next(e)}});
router.post('/:id/publish',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await SponsorVideoAgent.publish(req.params.id,req.body.is_public!==false))}catch(e){next(e)}});
router.get('/public/placements',async(req,res,next)=>{try{res.json(await SponsorVideoAgent.publicPortalVideos())}catch(e){next(e)}});

module.exports=router;
