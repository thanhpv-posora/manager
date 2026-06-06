const express=require('express');
const {auth}=require('../middleware/auth');
const UserPreferenceAgent=require('../agents/UserPreferenceAgent');
const router=express.Router();

router.get('/:key',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{
  try{res.json(await UserPreferenceAgent.get(req.user,req.params.key))}catch(e){next(e)}
});

router.post('/:key',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{
  try{res.json(await UserPreferenceAgent.save(req.user,req.params.key,req.body||{}))}catch(e){next(e)}
});

module.exports=router;
