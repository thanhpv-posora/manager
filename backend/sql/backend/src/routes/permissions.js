const express=require('express');
const {auth}=require('../middleware/auth');
const UserPermissionAgent=require('../agents/UserPermissionAgent');
const router=express.Router();

router.get('/me',auth(['ADMIN','STAFF','CUSTOMER']),async(req,res,next)=>{try{res.json(await UserPermissionAgent.me(req.user))}catch(e){next(e)}});
router.get('/users',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserPermissionAgent.users())}catch(e){next(e)}});
router.get('/users/:id/menus',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserPermissionAgent.getUserMenus(req.params.id))}catch(e){next(e)}});
router.put('/users/:id/menus',auth(['ADMIN']),async(req,res,next)=>{try{res.json(await UserPermissionAgent.saveUserMenus(req.params.id,req.body.menus,req.user.id))}catch(e){next(e)}});

module.exports=router;
