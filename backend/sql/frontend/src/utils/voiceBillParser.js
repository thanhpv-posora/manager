const VI_NUM = {
  'không':0,'linh':0,'lẻ':0,'một':1,'mốt':1,'mot':1,'hai':2,'ba':3,
  'bốn':4,'bon':4,'tư':4,'năm':5,'nam':5,'lăm':5,'sáu':6,'sau':6,
  'bảy':7,'bay':7,'tám':8,'tam':8,'chín':9,'chin':9,'mười':10,'muoi':10
};

const OP_WORDS = {
  'cộng': '+', 'cong': '+', 'thêm': '+', 'them': '+', 'với': '+',
  'trừ': '-', 'tru': '-', 'bớt': '-', 'bot': '-',
  'nhân': '*', 'nhan': '*', 'x': '*',
  'chia': '/'
};

const UNIT_WORDS = new Set([
  'kg','ký','ki','kí','cân','can','kilo','kilogram','ký-lô','ky','kylo',
  'gam','gram','g','con','cái','cay','miếng','mieng'
]);

function normalizeText(s) {
  return String(s||'')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[,.]/g,' chấm ')
    .replace(/\s+/g,' ')
    .trim();
}

function parseSmallVietnameseNumber(words) {
  words = words.filter(Boolean);
  if (!words.length) return null;
  const direct = Number(words.join('').replace(',', '.'));
  if (!Number.isNaN(direct)) return direct;

  if (words.length === 1 && VI_NUM[words[0]] !== undefined) return VI_NUM[words[0]];

  const muoiIndex = words.findIndex(w => w === 'mười' || w === 'muoi');
  if (muoiIndex >= 0) {
    if (words.length === 1) return 10;
    const tail = words.slice(muoiIndex+1).find(w => VI_NUM[w] !== undefined);
    return 10 + (tail ? VI_NUM[tail] : 0);
  }

  const chucIndex = words.findIndex(w => w === 'mươi' || w === 'muoi');
  if (chucIndex > 0) {
    const ten = VI_NUM[words[chucIndex-1]] || 0;
    const tail = words.slice(chucIndex+1).find(w => VI_NUM[w] !== undefined);
    return ten * 10 + (tail ? VI_NUM[tail] : 0);
  }
  return null;
}

function parseNumberPhrase(words) {
  const dotIndex = words.findIndex(w => w === 'chấm' || w === 'phẩy');
  if (dotIndex >= 0) {
    const left = parseSmallVietnameseNumber(words.slice(0,dotIndex));
    const rightDigits = words.slice(dotIndex+1).map(w => /^\d+$/.test(w) ? w : (VI_NUM[w] !== undefined ? String(VI_NUM[w]) : '')).join('');
    if (left !== null && rightDigits !== '') return Number(`${left}.${rightDigits}`);
  }
  return parseSmallVietnameseNumber(words);
}

function expressionStartIndex(parts) {
  for (let i=0; i<parts.length; i++) {
    const w=parts[i];
    if (/^\d+([.]\d+)?$/.test(w) || VI_NUM[w] !== undefined) return i;
  }
  return -1;
}

export function parseVietnameseMathExpression(text) {
  const parts = normalizeText(text).split(' ').filter(Boolean);
  const tokens = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      const n = parseNumberPhrase(buf);
      if (n !== null && !Number.isNaN(n)) tokens.push(String(n));
      buf = [];
    }
  };

  for (const w of parts) {
    if (UNIT_WORDS.has(w)) {
      flush();
      continue;
    }
    if (OP_WORDS[w]) {
      flush();
      tokens.push(OP_WORDS[w]);
    } else {
      buf.push(w);
    }
  }
  flush();

  const expr = tokens.join(' ');
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) return null;
  try {
    const v = Function(`"use strict"; return (${expr})`)();
    return Number.isFinite(Number(v)) ? Number(v) : null;
  } catch {
    return null;
  }
}

function parseCommand(text) {
  let parts = normalizeText(text).split(' ').filter(Boolean);
  // Cho phép nói tự nhiên: "thêm Đùi mười hai ký", "cho Đùi 12kg"
  if (['thêm','them','cho','lấy','lay','bán','ban'].includes(parts[0])) parts = parts.slice(1);
  const start = expressionStartIndex(parts);
  if (start < 0) return null;
  const productName = parts.slice(0,start).filter(w=>!UNIT_WORDS.has(w)).join(' ').trim();
  const exprText = parts.slice(start).join(' ');
  const quantity = parseVietnameseMathExpression(exprText);
  if (quantity === null) return null;
  return {productName, quantity, expression:exprText};
}

function stripGenericWords(s) {
  return normalizeText(s).split(' ').filter(w=>!['bò','bo','thịt','thit','heo','lợn','lon'].includes(w)).join(' ');
}

function scoreProduct(spokenName, product) {
  const a = stripGenericWords(spokenName).replace(/\s/g,'');
  const b = stripGenericWords(product.product_name || product.name || '').replace(/\s/g,'');
  const c = normalizeText(product.product_code || '').replace(/\s/g,'');
  if (!a) return 0;
  if (b === a || c === a) return 100;
  if (b.includes(a) || a.includes(b)) return 80;
  const aWords = normalizeText(spokenName).split(' ');
  const bWords = normalizeText(product.product_name || product.name || '').split(' ');
  let hit = 0;
  for (const w of aWords) if (bWords.some(x => x.includes(w) || w.includes(x))) hit++;
  return Math.round((hit / Math.max(aWords.length, 1)) * 70);
}

export function parseVoiceBillCommand(text, products) {
  const raw = normalizeText(text);
  if (raw === 'lưu bill' || raw === 'luu bill' || raw === 'lưu hóa đơn') {
    return {ok:true, action:'SAVE_BILL'};
  }
  if (raw.startsWith('xóa ') || raw.startsWith('xoa ')) {
    const name = raw.replace(/^xóa\s+|^xoa\s+/, '');
    let best=null,bestScore=0;
    for (const p of products || []) {
      const sc = scoreProduct(name,p);
      if (sc > bestScore) {best=p;bestScore=sc;}
    }
    if (!best || bestScore < 35) return {ok:false,message:`Không tìm thấy mặt hàng để xóa "${name}".`};
    return {ok:true, action:'CLEAR_ITEM', product:best};
  }

  const parsed = parseCommand(text);
  if (!parsed) return { ok:false, message:'Không hiểu số lượng. Ví dụ: "Bò búp mười tám chấm năm cộng hai mươi ba".' };

  let best=null,bestScore=0;
  for (const p of products || []) {
    const sc = scoreProduct(parsed.productName,p);
    if (sc > bestScore) {best=p;bestScore=sc;}
  }
  if (!best || bestScore < 35) return { ok:false, message:`Không tìm thấy mặt hàng gần với "${parsed.productName}".` };
  return { ok:true, action:'ADD_QTY', product:best, quantity:parsed.quantity, expression:parsed.expression, score:bestScore, spokenProductName:parsed.productName };
}

export function voiceSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const recognition = new SpeechRecognition();
  recognition.lang = 'vi-VN';
  recognition.continuous = false;
  recognition.interimResults = false;
  return recognition;
}
