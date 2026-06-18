const express=require('express');
const {auth}=require('../middleware/auth');
const OCRProviderAgent=require('../agents/OCRProviderAgent');
const router=express.Router();

router.get('/providers',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await OCRProviderAgent.providers())}catch(e){next(e)}});
router.get('/configs',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await OCRProviderAgent.configs())}catch(e){next(e)}});
router.post('/configs',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await OCRProviderAgent.saveConfig(req.body))}catch(e){next(e)}});
router.get('/active/:moduleKey',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await OCRProviderAgent.activeConfig(req.params.moduleKey))}catch(e){next(e)}});
router.post('/parse/:moduleKey',auth(['ADMIN','STAFF']),async(req,res,next)=>{try{res.json(await OCRProviderAgent.parseExternal(req.params.moduleKey,req.body))}catch(e){next(e)}});

module.exports=router;
