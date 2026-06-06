const express=require('express');
const {auth}=require('../middleware/auth');
const SettingsAgent=require('../agents/SettingsAgent');
const router=express.Router();

router.get('/', auth(['ADMIN','STAFF']), async(req,res,next)=>{try{res.json(await SettingsAgent.getAll())}catch(e){next(e)}});
router.put('/', auth(['ADMIN','STAFF']), async(req,res,next)=>{try{res.json(await SettingsAgent.save(req.body))}catch(e){next(e)}});

module.exports=router;
