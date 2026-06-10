const express=require('express');
const path=require('path');
const fs=require('fs');
const multer=require('multer');
const {auth}=require('../middleware/auth');
const router=express.Router();

const dir=path.join(process.cwd(),'uploads','videos');
fs.mkdirSync(dir,{recursive:true});

const storage=multer.diskStorage({
  destination:(req,file,cb)=>cb(null,dir),
  filename:(req,file,cb)=>{
    const ext=path.extname(file.originalname)||'.webm';
    cb(null,'video_'+Date.now()+'_'+Math.round(Math.random()*1e9)+ext);
  }
});

const upload=multer({storage,limits:{fileSize:80*1024*1024}});

router.post('/video',auth(['ADMIN','STAFF']),upload.single('video'),(req,res)=>{
  if(!req.file)return res.status(400).json({message:'Không có file video'});
  const url=(process.env.PUBLIC_BASE_URL||'')+'/uploads/videos/'+req.file.filename;
  res.json({message:'Đã upload video',url});
});

module.exports=router;
