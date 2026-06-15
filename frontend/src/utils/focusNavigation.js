export function handlePosInputKeyNavigation(e){
  const key=e.key;
  if(!['Enter','ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(key))return;

  const el=e.currentTarget;
  if(!el||el.tagName==='TEXTAREA')return;

  if(key==='ArrowLeft'){
    const start=typeof el.selectionStart==='number'?el.selectionStart:0;
    if(start>0)return;
  }
  if(key==='ArrowRight'){
    const end=typeof el.selectionEnd==='number'?el.selectionEnd:String(el.value||'').length;
    if(end<String(el.value||'').length)return;
  }

  const list=Array.from(document.querySelectorAll('[data-pos-nav="true"]'))
    .filter(x=>!x.disabled&&x.offsetParent!==null);
  const idx=list.indexOf(el);
  if(idx<0)return;

  let nextIdx=idx;
  if(key==='Enter'||key==='ArrowDown'||key==='ArrowRight')nextIdx=Math.min(idx+1,list.length-1);
  if(key==='ArrowUp'||key==='ArrowLeft')nextIdx=Math.max(idx-1,0);

  if(nextIdx!==idx){
    e.preventDefault();
    const target=list[nextIdx];
    target.focus();
    if(typeof target.select==='function')setTimeout(()=>target.select(),0);
  }
}
