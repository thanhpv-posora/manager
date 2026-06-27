import {calcQtyExpression} from './qtyExpression';

// Grid keyboard navigation for POS table with qty + price columns.
// Inputs must have data-pos-col="qty"|"price" and data-pos-row="<product_id>".
export function movePosGridFocus(e){
  const key=e.key;
  if(key!=='Enter'&&key!=='ArrowDown'&&key!=='ArrowUp'&&key!=='ArrowLeft'&&key!=='ArrowRight') return;

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
  }

  if(target){
    e.preventDefault();
    e.stopPropagation();
    target.focus();
    setTimeout(()=>target.select&&target.select(),0);
  }
}

export function movePosQtyFocus(e){
  const key=e.key;
  const supported=['Enter','ArrowDown','ArrowUp','PageDown','PageUp'];
  if(!supported.includes(key) && !(e.ctrlKey&&(key==='Home'||key==='End'))) return;

  const input=e.currentTarget;
  if(input && input.dataset){
    input.dataset.calculatedQty=String(calcQtyExpression(input.value));
  }

  const inputs=Array.from(document.querySelectorAll('input[data-pos-qty="1"]'))
    .filter(x=>!x.disabled && x.offsetParent!==null);

  const current=inputs.indexOf(input);
  if(current<0) return;

  let target=current;
  if(key==='Enter' || key==='ArrowDown') target=current+1;
  if(key==='ArrowUp') target=current-1;
  if(key==='PageDown') target=current+10;
  if(key==='PageUp') target=current-10;
  if(e.ctrlKey && key==='Home') target=0;
  if(e.ctrlKey && key==='End') target=inputs.length-1;

  target=Math.max(0,Math.min(inputs.length-1,target));

  e.preventDefault();
  e.stopPropagation();

  const next=inputs[target];
  if(next){
    next.focus();
    setTimeout(()=>next.select&&next.select(),0);
  }
}
