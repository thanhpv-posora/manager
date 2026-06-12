function wrapText(ctx,text,maxWidth){
  const words=String(text||'').split(/\s+/);
  const lines=[]; let line='';
  for(const word of words){
    const test=line?line+' '+word:word;
    if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word}else line=test;
  }
  if(line)lines.push(line);
  return lines;
}
function drawFrame(ctx,w,h,slide,progress){
  const g=ctx.createLinearGradient(0,0,w,h);
  g.addColorStop(0,'#fff7ed'); g.addColorStop(1,'#fee2e2');
  ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
  ctx.fillStyle='#8f1d1d'; ctx.beginPath(); ctx.arc(w-110,95,70+12*Math.sin(progress*Math.PI*2),0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#101827'; ctx.font='bold 54px Arial';
  let y=150; for(const line of wrapText(ctx,slide.title,w-160).slice(0,2)){ctx.fillText(line,80,y);y+=65}
  ctx.fillStyle='#334155'; ctx.font='32px Arial'; y+=25;
  for(const line of wrapText(ctx,slide.body,w-160).slice(0,6)){ctx.fillText(line,80,y);y+=44}
  ctx.fillStyle='#8f1d1d'; ctx.font='bold 30px Arial'; ctx.fillText('MeatBiz Business Portal',80,h-70);
}
export async function generateSponsorVideo({title,script_text,video_idea,sponsor_name,durationSec=12,onProgress}){
  if(!window.MediaRecorder)throw new Error('Trình duyệt không hỗ trợ tạo video. Hãy dùng Chrome hoặc Edge mới.');
  const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720;
  const ctx=canvas.getContext('2d');
  const stream=canvas.captureStream ? canvas.captureStream(30) : null;
  if(!stream)throw new Error('Trình duyệt không hỗ trợ canvas.captureStream');
  const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/webm';
  const recorder=new MediaRecorder(stream,{mimeType:mime});
  const chunks=[]; recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
  const slides=[
    {title:title||('Giới thiệu '+(sponsor_name||'nhà tài trợ')),body:script_text||'Giới thiệu uy tín, sản phẩm và dịch vụ nổi bật.'},
    {title:'Điểm nổi bật',body:video_idea||'Sản phẩm chất lượng, dịch vụ tốt, đồng hành cùng hộ kinh doanh.'},
    {title:'Cảm ơn quý khách',body:'Liên hệ ngay hôm nay để biết thêm thông tin.'}
  ];
  const fps=24,totalFrames=durationSec*fps,framesPerSlide=Math.floor(totalFrames/slides.length);
  return await new Promise((resolve,reject)=>{
    recorder.onerror=e=>reject(e.error||e);
    recorder.onstop=()=>resolve(new Blob(chunks,{type:'video/webm'}));
    recorder.start(1000);
    let frame=0;
    const timer=setInterval(()=>{
      const slideIndex=Math.min(slides.length-1,Math.floor(frame/framesPerSlide));
      drawFrame(ctx,canvas.width,canvas.height,slides[slideIndex],(frame%framesPerSlide)/framesPerSlide);
      frame++; onProgress&&onProgress(Math.min(100,Math.round(frame/totalFrames*100)));
      if(frame>=totalFrames){clearInterval(timer); setTimeout(()=>recorder.stop(),300)}
    },1000/fps);
  });
}
