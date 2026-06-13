export function applyMobileNumericInputMode(root=document){
  if(!root || typeof root.querySelectorAll!=='function') return;
  const numericHints=[
    'kg','ký','kí','so luong','số lượng','qty','quantity','tien','tiền','gia','giá','cash','bank','debt','no','nợ','paid','thu','chi','tong','tổng','can','cân','ton','tồn','nguong','ngưỡng','sort','thứ tự','otp','sdt','sđt','phone'
  ];
  const decimalHints=['kg','ký','kí','qty','quantity','số lượng','so luong','cân','can','tồn','ton','ngưỡng','nguong'];
  root.querySelectorAll('input, textarea').forEach(el=>{
    if(el.type==='date'||el.type==='file'||el.type==='checkbox'||el.type==='password'||el.type==='email') return;
    const label=el.closest('label')?.innerText||'';
    const haystack=`${el.placeholder||''} ${el.name||''} ${el.id||''} ${label}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const isNumeric=numericHints.some(h=>haystack.includes(h.normalize('NFD').replace(/[\u0300-\u036f]/g,'')));
    if(!isNumeric) return;
    const isDecimal=decimalHints.some(h=>haystack.includes(h.normalize('NFD').replace(/[\u0300-\u036f]/g,'')));
    if(!el.getAttribute('inputmode')) el.setAttribute('inputmode', isDecimal?'decimal':'numeric');
    if(!el.getAttribute('autocomplete')) el.setAttribute('autocomplete','off');
  });
}
