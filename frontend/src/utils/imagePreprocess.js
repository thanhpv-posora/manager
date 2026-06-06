export async function preprocessImageFile(file,{scale=2,threshold=150,contrast=1.35,grayscale=true}={}){
  const img=await loadImage(file);
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(img.width*scale);
  canvas.height=Math.round(img.height*scale);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingEnabled=true;
  ctx.drawImage(img,0,0,canvas.width,canvas.height);

  const data=ctx.getImageData(0,0,canvas.width,canvas.height);
  const d=data.data;
  for(let i=0;i<d.length;i+=4){
    let r=d[i],g=d[i+1],b=d[i+2];
    let gray=0.299*r+0.587*g+0.114*b;
    gray=(gray-128)*contrast+128;
    gray=Math.max(0,Math.min(255,gray));
    if(grayscale){
      const bw=gray>threshold?255:0;
      d[i]=d[i+1]=d[i+2]=bw;
    }else{
      d[i]=d[i+1]=d[i+2]=gray;
    }
  }
  ctx.putImageData(data,0,0);
  return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
}

function loadImage(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=reject;
    img.src=URL.createObjectURL(file);
  });
}
