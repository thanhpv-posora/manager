const express=require('express');
const {auth}=require('../middleware/auth');
const {listAgents}=require('../agents/AgentRegistry');
const router=express.Router();
router.get('/',auth(['ADMIN','STAFF']),async(req,res)=>res.json({architecture:'Real Agent Architecture',version:'6.7.0',agents:listAgents()}));
module.exports=router;
