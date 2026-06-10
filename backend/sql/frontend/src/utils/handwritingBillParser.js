function normalize(s){
  return String(s||'').toLowerCase().normalize('NFC').replace(/[đ]/g,'d').replace(/[^a-z0-9+\-*/.\s]/g,' ').replace(/\s+/g,' ').trim();
}
function compact(s){return normalize(s).replace(/\s/g,'');}
function calcExpr(expr){
  const s=String(expr||'').replace(/,/g,'.').replace(/[^0-9+\-*/().\s]/g,'').trim();
  if(!s||!/^[0-9+\-*/().\s]+$/.test(s))return null;
  try{const v=Function('"use strict"; return ('+s+')')();return Number.isFinite(Number(v))?Number(Number(v).toFixed(3)):null;}catch{const n=Number(s);return Number.isFinite(n)?Number(n.toFixed(3)):null;}
}
function normalizeHandwritingQty(expr){
  const raw=String(expr||'').trim();
  if(/[+\-*/]/.test(raw)){
    const parts=raw.split(/([+\-*/])/).map(x=>x.trim()).filter(Boolean);
    const normalized=parts.map(p=>/^[+\-*/]$/.test(p)?p:(/^\d{3}$/.test(p)?String(Number(p)/10):(/^\d{4}$/.test(p)?String(Number(p)/10):p))).join(' ');
    return {expr:normalized,qty:calcExpr(normalized),rule:'HANDWRITING_EXPRESSION'};
  }
  if(/^\d{3}$/.test(raw))return {expr:String(Number(raw)/10),qty:Number(raw)/10,rule:'THREE_DIGIT_DECIMAL'};
  if(/^\d{4}$/.test(raw))return {expr:String(Number(raw)/10),qty:Number(raw)/10,rule:'FOUR_DIGIT_DECIMAL_TRUE_LARGE'};
  return {expr:raw,qty:calcExpr(raw),rule:'NORMAL'};
}
function splitLine(line){
  const clean=String(line||'').replace(/[，]/g,'.').replace(/(\d)\s*[.,]\s*(\d)/g,'$1.$2').replace(/\s+/g,' ').trim();
  const m=clean.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?(?:\s*[+\-*/]\s*[0-9]+(?:\.[0-9]+)?)*)$/);
  if(!m)return null;
  return {raw:clean,name:m[1].trim(),qtyRaw:m[2].replace(/\s+/g,'')};
}
function scoreName(name,product){
  const a=normalize(name),b=normalize(product.product_name||product.name||''),c=normalize(product.product_code||'');
  if(!a)return {score:0,reason:'EMPTY'};
  if(compact(a)===compact(b)||compact(a)===compact(c))return {score:100,reason:'EXACT'};
  const at=a.split(' ').filter(Boolean),bt=b.split(' ').filter(Boolean);
  const full=at.every(t=>bt.some(x=>x===t||x.includes(t)||t.includes(x)));
  if(full&&at.length>=1)return {score:90,reason:'TOKEN'};
  let hit=0;for(const t of at)if(bt.some(x=>x===t||x.includes(t)||t.includes(x)))hit++;
  return {score:Math.round((hit/Math.max(at.length,1))*70),reason:'FUZZY'};
}
export function parseHandwritingText(text,customerCatalogProducts,allProducts=[],aliases=[]){
  const rows=[];
  for(const line of String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)){
    const parsed=splitLine(line); if(!parsed)continue;
    const q=normalizeHandwritingQty(parsed.qtyRaw);
    const alias=aliases.find(a=>normalize(a.alias_text)===normalize(parsed.name));
    let best=null,bestScore=0,bestReason='',inCatalog=false;
    if(alias){best={product_id:alias.product_id,product_name:alias.product_name,product_code:alias.product_code};bestScore=100;bestReason='ALIAS';}
    const search=(products,catalog)=>{for(const p of products||[]){const sc=scoreName(parsed.name,p);if(sc.score>bestScore){best=p;bestScore=sc.score;bestReason=sc.reason;inCatalog=catalog;}}};
    search(customerCatalogProducts,true);
    if(!best||bestScore<80)search(allProducts,false);
    if(best&&customerCatalogProducts.some(p=>String(p.product_id)===String(best.product_id)))inCatalog=true;
    const errors=[],warnings=[];
    if(q.qty===null||q.qty<=0)errors.push('Lỗi số lượng');
    if(!best||bestScore<75)errors.push('Không nhận diện chắc chắn');
    else if(!inCatalog)warnings.push('Chưa có trong danh mục khách');
    else if(bestScore<90)warnings.push('Tên khớp chưa chắc chắn');
    const status=errors.length?'ERROR':(warnings.length?'WARN':'OK');
    rows.push({raw:parsed.raw,name:parsed.name,qtyRaw:parsed.qtyRaw,qtyExpr:q.expr,qty:q.qty,qtyRule:q.rule,product:best,product_id:best?.product_id,product_name:best?.product_name,score:bestScore,match_reason:bestReason,inCatalog,status,errors,warnings,selected:status==='OK',canApply:status!=='ERROR',ok:status==='OK'});
  }
  return rows;
}
