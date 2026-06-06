import {calcQtyExpression} from './qtyExpression';

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
