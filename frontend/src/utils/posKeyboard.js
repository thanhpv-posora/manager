// Grid keyboard navigation for POS table with qty + price columns.
// Inputs must have data-pos-col="qty"|"price" and data-pos-row="<product_id>".
function computePageJumpCount(input){
  const container=input.closest('.pos-agent-table-scroll');
  const row=input.closest('tr');
  if(container&&row&&row.offsetHeight>0){
    return Math.max(1,Math.floor(container.clientHeight/row.offsetHeight));
  }
  // Layout doesn't expose a reliable row height (e.g. not mounted in the expected
  // scroll container) — fall back to a stable configured page jump.
  return 8;
}

export function movePosGridFocus(e){
  const key=e.key;
  if(key!=='Enter'&&key!=='ArrowDown'&&key!=='ArrowUp'&&key!=='ArrowLeft'&&key!=='ArrowRight'&&key!=='PageDown'&&key!=='PageUp') return;

  const input=e.currentTarget;
  const col=input.dataset.posCol;
  const row=input.dataset.posRow;
  if(!col||!row) return;

  const vis=el=>!el.disabled&&el.offsetParent!==null;
  const qtyInputs=[...document.querySelectorAll('input[data-pos-col="qty"]')].filter(vis);
  const priceInputs=[...document.querySelectorAll('input[data-pos-col="price"]')].filter(vis);

  // Interleaved order: [qty0, price0, qty1, price1, ...] — used for Enter/Shift+Enter
  const all=[];
  for(const qi of qtyInputs){
    all.push(qi);
    const pi=priceInputs.find(p=>p.dataset.posRow===qi.dataset.posRow);
    if(pi) all.push(pi);
  }

  const curColInputs=col==='qty'?qtyInputs:priceInputs;
  const curColIdx=curColInputs.indexOf(input);
  const curAllIdx=all.indexOf(input);

  let target=null;
  let scrollTargetIntoView=false;

  if(key==='Enter'&&!e.shiftKey){
    if(curAllIdx>=0&&curAllIdx<all.length-1) target=all[curAllIdx+1];
  } else if(key==='Enter'&&e.shiftKey){
    if(curAllIdx>0) target=all[curAllIdx-1];
  } else if(key==='ArrowDown'){
    if(curColIdx>=0&&curColIdx<curColInputs.length-1) target=curColInputs[curColIdx+1];
  } else if(key==='ArrowUp'){
    if(curColIdx>0) target=curColInputs[curColIdx-1];
  } else if(key==='ArrowRight'&&col==='qty'){
    target=priceInputs.find(p=>p.dataset.posRow===row)||null;
  } else if(key==='ArrowLeft'&&col==='price'){
    target=qtyInputs.find(q=>q.dataset.posRow===row)||null;
  } else if((key==='PageDown'||key==='PageUp')&&col==='qty'){
    // Page jump is currently approved for the quantity column only — price cells keep
    // their native scroll-only PageUp/PageDown behavior (see the early-return above:
    // col!=='qty' here means target stays null and preventDefault is never called).
    if(curColIdx>=0){
      const jump=computePageJumpCount(input);
      const rawIdx=curColIdx+(key==='PageDown'?jump:-jump);
      const clamped=Math.max(0,Math.min(curColInputs.length-1,rawIdx));
      target=curColInputs[clamped];
      scrollTargetIntoView=true;
    }
  }

  if(target){
    e.preventDefault();
    e.stopPropagation();
    target.focus();
    setTimeout(()=>target.select&&target.select(),0);
    if(scrollTargetIntoView) target.scrollIntoView({block:'center',inline:'nearest'});
  }
}
