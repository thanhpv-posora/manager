import {parseMoney} from './money';

function cleanLine(line){
  return String(line||'')
    .replace(/[|;]+/g,' ')
    .replace(/[，]/g,',')
    .replace(/\s+/g,' ')
    .trim();
}

function guessUnit(text){
  const s=String(text||'').toLowerCase();
  const m=s.match(/\b(kg|g|gram|cái|cai|con|bao|hộp|hop|thùng|thung)\b/);
  if(!m) return 'kg';
  const u=m[1];
  if(u==='cai')return 'cái';
  if(u==='hop')return 'hộp';
  if(u==='thung')return 'thùng';
  return u;
}

function normalizeProductName(name){
  return String(name||'')
    .replace(/\b(kg|g|gram|cái|cai|con|bao|hộp|hop|thùng|thung)\b/ig,' ')
    .replace(/\b(gia|giá|don gia|đơn giá|sale|price)\b/ig,' ')
    .replace(/^\d+[\).\s-]*/,'')
    .replace(/\s+/g,' ')
    .trim();
}

function scoreRow(row){
  let score=100;
  if(!row.name) score-=80;
  if(!row.sale_price) score-=20;
  if(row.raw.length<3) score-=30;
  if(/[0-9]{8,}/.test(row.raw.replace(/[,.]/g,''))) score-=20;
  return Math.max(0,score);
}

export function parseProductImportText(text, defaultCategoryId=''){
  const rows=[];
  const lines=String(text||'').split(/\r?\n/).map(cleanLine).filter(Boolean);

  for(const line of lines){
    if(/^(stt|mã|ma|tên|ten|đơn|don|giá|gia|bảng|bang)/i.test(line)) continue;

    // Prefer price patterns with separators: 230,000 / 230.000 / 230000
    const moneyMatches=line.match(/(?:\d{1,3}(?:[,.]\d{3})+|\d{5,})(?:\s?đ)?/g)||[];
    const saleRaw=moneyMatches.length?moneyMatches[moneyMatches.length-1]:'';

    let name=line;
    for(const m of moneyMatches) name=name.replace(m,' ');
    name=normalizeProductName(name);

    // If OCR merges name and price badly, keep row as manual warning instead of dropping it.
    const sale_price=parseMoney(saleRaw);
    if(!name && !sale_price) continue;

    const row={
      name,
      unit:guessUnit(line),
      category_id:defaultCategoryId||null,
      sale_price,
      cost_price:0,
      inventory_mode:'STOCK',
      allow_negative_stock:0,
      raw:line,
      selected:true
    };
    row.ocr_confidence=scoreRow(row);
    rows.push(row);
  }

  return rows;
}
