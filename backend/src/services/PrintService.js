const QRCode = require('qrcode');
const { formatQty: qty } = require('../utils/quantityFormat');

// Print currency presentation policy — bare grouped number for table cells (currency
// stated once in the column heading), " VND" suffix only for standalone totals outside
// a table. One term ("VND") used consistently in printed output. Does not touch any
// stored/calculated amount — presentation only.
function formatMoneyValue(n) { return Number(n || 0).toLocaleString('en-US'); }
function formatMoneyWithCurrency(n) { return `${formatMoneyValue(n)} VND`; }

// order_items has no dedicated quantity_expr column — the cashier's original typed
// expression (e.g. "12.5+7") is frozen into order_items.note with a "SL nhập: " prefix,
// written once by CreateOrder.jsx's POS save() flow, and only when the expression
// actually differs from the plain calculated quantity (see that file's payloadItems
// mapping) — so any note matching this exact prefix is guaranteed by the writer to be a
// real calculation, never a no-op tooltip. Items added via OrderAgent.addItem() or
// order.service.js don't write this prefix, so they simply get no tooltip (same as an
// empty/null note) rather than a reconstructed/guessed expression. Applies identically
// to CARCASS_POS and INVENTORY_SALE lines — sales_flow never affects this.
function qtyExprOf(item) {
  const m = /^SL nhập:\s*(.+)$/.exec(String(item?.note || '').trim());
  return m ? m[1].trim() : '';
}
// Minimal attribute-context escaping for the new title="..." usage below — the rest of
// this file interpolates into text nodes (HTML doesn't parse those as markup the same
// way), this is the first place a value lands inside an HTML attribute.
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function qtyTitleAttr(item, displayValue) {
  const expr = qtyExprOf(item);
  if (!expr) return '';
  // Noise reduction (belt-and-suspenders — CreateOrder.jsx's writer already
  // skips writing the note at all when expr===String(quantity), but this
  // stays correct even if some other future writer doesn't apply that filter).
  if (expr === String(displayValue).trim() || expr === String(item?.quantity ?? '').trim()) return '';
  return ` title="${escAttr(expr)}"`;
}
function allocationTender(row){
  const amount = Number(row?.allocated_amount || 0);
  let cash = Number(row?.allocation_cash_amount || 0);
  let bank = Number(row?.allocation_bank_amount || 0);
  if (cash + bank <= 0) {
    const m=String(row?.payment_method||'').toUpperCase();
    if(m==='BANK_TRANSFER') bank = amount;
    else if(m==='CASH') cash = amount;
    else {
      const payAmount=Number(row?.payment_amount||0);
      const ratio=payAmount>0 ? amount/payAmount : 0;
      cash=Math.min(amount, Math.round(Number(row?.cash_amount||0)*ratio));
      bank=Math.max(0, amount-cash);
    }
  }
  return {cash, bank, total: amount};
}
function paymentStatusLabel(status, remaining){
  if(Number(remaining||0)<=0 || String(status||'').toUpperCase()==='PAID') return 'ĐÃ THANH TOÁN';
  return 'CHƯA THANH TOÁN';
}
function capTenderToAmount(tender, cappedAmount){
  const amount = Number(cappedAmount || 0);
  const rawCash = Number(tender?.cash || 0);
  const rawBank = Number(tender?.bank || 0);
  const rawTotal = Number(tender?.total || 0) || rawCash + rawBank;
  if (amount <= 0) return { cash: 0, bank: 0, total: 0 };
  if (rawTotal <= 0) return { cash: amount, bank: 0, total: amount };
  if (rawTotal <= amount) return { cash: rawCash, bank: rawBank, total: rawTotal };
  const cash = Math.min(amount, Math.round(rawCash * amount / rawTotal));
  const bank = Math.max(0, amount - cash);
  return { cash, bank, total: amount };
}

function normalizedAllocationsForBill(order, payableTotal){
  // V65.36: print must show only the amount allocated to THIS bill, not the whole payment receipt.
  // Some older/buggy rows may contain the full receipt amount. Cap every payment row by the remaining
  // balance of the bill so a 75M receipt used to clear 24,161,500đ old debt is printed as 24,161,500đ.
  const raw = Array.isArray(order.payment_allocations) ? order.payment_allocations : [];
  let remaining = Math.max(0, Number(payableTotal || 0));
  const rows = [];
  for (const a of raw) {
    if (remaining <= 0) break;
    const t = allocationTender(a);
    const capped = Math.min(remaining, Number(t.total || 0));
    if (capped <= 0) continue;
    const cappedTender = capTenderToAmount(t, capped);
    rows.push({ ...a, allocated_amount: capped, __cash: cappedTender.cash, __bank: cappedTender.bank, __total: cappedTender.total });
    remaining -= capped;
  }
  return rows;
}

function allocationSummary(order, payableTotal){
  const allocs = normalizedAllocationsForBill(order, payableTotal);
  const paid = Math.min(Number(payableTotal || 0), allocs.reduce((sum,a)=>sum+Number((a.__total ?? a.allocated_amount) || 0),0));
  const cash = allocs.reduce((sum,a)=>sum+Number((a.__cash ?? allocationTender(a).cash) || 0),0);
  const bank = allocs.reduce((sum,a)=>sum+Number((a.__bank ?? allocationTender(a).bank) || 0),0);
  const remaining = Math.max(0, Number(payableTotal || 0) - paid);
  return {allocs, paid, cash, bank, remaining};
}
// S8.2: minimal visual patch only — print never blocked or specially marked
// CANCELLED bills before this (order.status was never referenced in either
// template). Line items and totals stay exactly as printed for any other bill;
// only this banner is conditional.
function cancelledBannerHtml(order, style) {
  if (String(order?.status || '').toUpperCase() !== 'CANCELLED') return '';
  return style === 'k80'
    ? `<div class="center" style="border:2px solid #b91c1c;color:#b91c1c;font-weight:900;padding:4px;margin:6px 0;font-size:14px">ĐÃ HỦY</div>`
    : `<div style="border:3px solid #b91c1c;color:#b91c1c;font-weight:900;text-align:center;padding:10px;margin:14px 0;font-size:22px;letter-spacing:2px">ĐÃ HỦY</div>`;
}

function ymd(v){
  if(!v) return '';
  const raw = String(v).slice(0,10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : raw;
}
// Old-debt rows carry their OWN frozen calendar_type/lunar_date_text (selected
// by OrderAgent.get()/getByToken()'s old_debts query) — same authority the bill
// header already uses for `billDate` above. Never derive from the customer's
// current billing_calendar_type: a historical bill keeps the calendar facts it
// was created under, even if the customer's setting changed afterward.
function oldDebtDateLabel(d){
  return d.calendar_type==='LUNAR' && d.lunar_date_text
    ? `${d.lunar_date_text} ÂL / ${ymd(d.order_date)} DL`
    : ymd(d.order_date);
}
const floor1=v=>Math.floor((Number(v)||0)*10)/10;
const animal=v=>floor1(v).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});

function publicAppUrl(){
  const raw = process.env.PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || process.env.SITE_URL || process.env.APP_URL || process.env.FRONTEND_URL || 'https://meatbiz.posora.vn';
  try {
    const u = new URL(String(raw));
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(u.hostname)) return 'https://meatbiz.posora.vn';
    return String(raw).replace(/\/$/, '');
  } catch (_) {
    return 'https://meatbiz.posora.vn';
  }
}

class PrintService {
  async settings() {
    try {
      const pool = require('../config/db');
      const [rows] = await pool.query(`SELECT setting_key,setting_value FROM business_settings`);
      const s = {};
      for (const r of rows) s[r.setting_key] = r.setting_value;
      return s;
    } catch(e) {
      return {shop_name:'MEATBIZ FOOD', bill_footer:'Cảm ơn quý khách!'};
    }
  }
  // options.showUnpaid: presentation-only toggle for the "Những bill chưa
  // thanh toán" section. Defaults to true (preserve current behavior) — the
  // caller (routes/orders.js) is responsible for the absent/malformed→true
  // fallback, so this stays a plain boolean check here.
  async billHtml(order, options={}) {
    const showUnpaid = options.showUnpaid !== false;
    const settings = await this.settings();
    const app = publicAppUrl();
    const url = `${app}/bill/${order.private_token || order.order_code}`;
    const qr = await QRCode.toDataURL(url);
    const pay=order.payment||{};
    // V6.51: total_amount is the payable total (today's bill + configured daily installment).
    // current_bill_amount keeps only today's product bill; installment_amount keeps the configured contribution for the bill.
    const configuredInstallment=Number(order.installment_amount || order.monthly_installment?.installment_amount || 0);
    const monthlyInstallment=configuredInstallment;
    const storedTotal=Number(order.total_amount||0);
    const rawCurrentBill=Number(order.current_bill_amount||0);
    const itemTotal=(order.items||[]).reduce((sum,i)=>sum+Number(i.total_price || (Number(i.quantity||0)*Number(i.sale_price||0)) || 0),0);
    // V6.51 FINAL PRINT RULE:
    // order.total_amount đã là TỔNG CUỐI CÙNG phải thanh toán.
    // Nếu có góp nợ/ngày thì total_amount đã bao gồm khoản góp này.
    // Không được cộng installment_amount thêm lần nữa.
    //
    // Ví dụ:
    // total_amount = 3.075.000
    // installment_amount = 2.000.000
    // => Bill hôm nay = 1.075.000
    // => Góp nợ/ngày = 2.000.000
    // => Tổng cần thanh toán = 3.075.000
    const payableTotal = storedTotal > 0
      ? storedTotal
      : (rawCurrentBill > 0
          ? rawCurrentBill
          : (itemTotal + monthlyInstallment));

    const todayBillTotal = monthlyInstallment > 0
      ? Math.max(0, payableTotal - monthlyInstallment)
      : (rawCurrentBill || itemTotal || payableTotal);
    const {allocs:paymentAllocations, paid:allocatedPaidTotal, cash:allocatedCashTotal, bank:allocatedBankTotal, remaining:remainingDebt}=allocationSummary(order,payableTotal);
    const statusLabel = paymentStatusLabel(order.payment_status, remainingDebt);
    const paymentRows = paymentAllocations.map((a,idx)=>{ const t={cash:Number(a.__cash ?? allocationTender(a).cash), bank:Number(a.__bank ?? allocationTender(a).bank), total:Number(a.__total ?? a.allocated_amount ?? allocationTender(a).total)}; return `<tr><td>Đợt thanh toán ${idx+1}</td><td>${ymd(a.payment_date)}</td><td>${a.payment_code||''}</td><td class="right">${formatMoneyValue(t.cash)}</td><td class="right">${formatMoneyValue(t.bank)}</td><td class="right"><b>${formatMoneyValue(t.total)}</b></td></tr>`; }).join('');
    const billDate = order.calendar_type==='LUNAR' && order.lunar_date_text ? `${order.lunar_date_text} ÂL / ${ymd(order.order_date)} DL` : (ymd(order.order_date) || ymd(pay.payment_date) || '');
    const createdDate = ymd(order.created_at) || ymd(order.order_date);
    const showInstallment = monthlyInstallment > 0;
    const oldDebtRows = showUnpaid ? (order.old_debts||[]).map(d=>`
      <tr><td>${oldDebtDateLabel(d)}</td><td>${d.order_code}</td><td class="right">${formatMoneyValue(d.total_amount)}</td><td class="right">${formatMoneyValue(d.paid_amount)}</td><td class="right"><b>${formatMoneyValue(d.debt_amount)}</b></td></tr>
    `).join('') : '';
    const rows = order.items.map((i,idx)=>`
      <tr><td class="center">${idx+1}</td><td>${i.product_name}</td><td class="center">${i.unit}</td><td class="right"${qtyTitleAttr(i,qty(i.quantity,settings.quantity_decimal_places))}>${qty(i.quantity,settings.quantity_decimal_places)}</td><td class="right">${formatMoneyValue(i.sale_price)}</td><td class="right">${formatMoneyValue(i.total_price)}</td></tr>
    `).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${order.order_code}</title><style>
@page{margin:14mm 16mm 14mm 16mm}
body{font-family:Arial,sans-serif;margin:20px;color:#111}.header{display:flex;justify-content:space-between;border-bottom:3px solid #7f1d1d;padding-bottom:10px}
.logo{font-size:30px;font-weight:900;color:#7f1d1d}.sub{color:#666;font-size:13px}.qr{width:120px;height:120px}.info{margin:13px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}
table{width:100%;border-collapse:collapse;margin-top:7px}th{background:#7f1d1d;color:#fff}td,th{border:1px solid #ddd;padding:9px}.right{text-align:right;white-space:nowrap}.center{text-align:center}
.bill-items-frame{width:100%;box-sizing:border-box;border:1px solid #ddd;margin-top:7px}
table.bill-items{width:100%;table-layout:fixed;border-collapse:collapse;margin:0;border:0}
table.bill-items th,table.bill-items td{border:1px solid #ddd;box-sizing:border-box}
table.bill-items thead th{text-align:center;vertical-align:middle;white-space:normal;line-height:1.2;padding:8px 4px}
.payment-box{margin-top:12px}.payment-line{font-size:17px;font-weight:700;margin-top:6px}.total{margin-top:11px;text-align:right;font-size:20px;font-weight:900}.section-title{margin-top:14px;font-size:16px;font-weight:900;color:#7f1d1d;border-bottom:2px solid #7f1d1d;padding-bottom:4px}.debt-summary{margin-top:7px;margin-left:auto;max-width:460px}.debt-summary div{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #ddd}.debt-summary b{font-size:17px}.status-paid{color:#15803d;font-weight:900}.status-unpaid{color:#b91c1c;font-weight:900}.print-btn{position:fixed;right:20px;top:20px;padding:12px 18px;background:#7f1d1d;color:#fff;border:0;border-radius:10px;font-weight:700}
.sign{display:flex;justify-content:space-between;margin-top:32px;text-align:center}@media print{.print-btn{display:none}body{margin:0}}</style></head><body>
<button class="print-btn" onclick="window.print()">IN BILL</button>
<div class="header"><div><div class="logo">${settings.shop_name||"MEATBIZ FOOD"}</div><div class="sub">${settings.shop_address||""} ${settings.shop_phone? " - " + settings.shop_phone : ""}</div><div class="sub">Phiếu giao hàng / Bill bán hàng</div><div>Mã bill: <b>${order.order_code}</b></div><div>Ngày lập phiếu: ${createdDate}</div><div>Ngày xuất hàng: ${billDate}</div></div><div><img class="qr" src="${qr}"><div class="sub">Quét QR xem bill</div></div></div>
${cancelledBannerHtml(order)}
<div class="info"><div><b>Khách hàng:</b> ${order.customer_name}<br><b>SĐT:</b> ${order.phone || ''}<br><b>Địa chỉ:</b> ${order.address || ''}</div><div><b>Trạng thái:</b> ${order.payment_status}<br><b>Ghi chú:</b> ${order.note || ''}</div></div>
<div class="bill-items-frame"><table class="bill-items"><colgroup><col style="width:5%"><col style="width:37%"><col style="width:7%"><col style="width:10%"><col style="width:17%"><col style="width:24%"></colgroup><thead><tr><th>STT</th><th>Mặt hàng</th><th>ĐVT</th><th>Số lượng</th><th>Đơn giá (VND)</th><th>Thành tiền (VND)</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="section-title">THÔNG TIN THANH TOÁN</div>
<table><thead><tr><th>Nội dung</th><th>Ngày thu</th><th>Mã phiếu thu</th><th>Tiền mặt (VND)</th><th>Chuyển khoản (VND)</th><th>Giá trị thanh toán (VND)</th></tr></thead><tbody>${paymentRows || '<tr><td colspan="6" class="right">Chưa phát sinh thanh toán cho bill này</td></tr>'}</tbody></table>
<div class="section-title">TỔNG HỢP CÔNG NỢ</div>
<div class="debt-summary">
  <div><span>Giá trị hàng hóa</span><b>${formatMoneyWithCurrency(todayBillTotal)}</b></div>
  ${showInstallment ? `<div><span>Góp nợ/ngày</span><b>${formatMoneyWithCurrency(monthlyInstallment)}</b></div>` : ''}
  <div><span>Tổng giá trị bill</span><b>${formatMoneyWithCurrency(payableTotal)}</b></div>
  <div><span>Tổng tiền mặt đã thanh toán</span><b>${formatMoneyWithCurrency(allocatedCashTotal)}</b></div>
  <div><span>Tổng chuyển khoản đã thanh toán</span><b>${formatMoneyWithCurrency(allocatedBankTotal)}</b></div>
  <div><span>Tổng đã thanh toán</span><b>${formatMoneyWithCurrency(allocatedPaidTotal)}</b></div>
  <div><span>Dư nợ còn lại</span><b>${formatMoneyWithCurrency(remainingDebt)}</b></div>
  <div><span>Tình trạng thanh toán</span><b class="${remainingDebt<=0?'status-paid':'status-unpaid'}">${statusLabel}</b></div>
</div>
${oldDebtRows ? `<h3>Những bill chưa thanh toán</h3><table><thead><tr><th>Ngày</th><th>Bill</th><th>Tổng (VND)</th><th>Đã thu (VND)</th><th>Còn nợ (VND)</th></tr></thead><tbody>${oldDebtRows}</tbody></table><div class="total">Tổng nợ cũ: ${formatMoneyWithCurrency(order.old_debt_total)}</div>` : ''}
<div class="sign"><div>Người giao<br><br><br>____________</div><div>Khách nhận<br><br><br>____________</div></div></body></html>`;
  }

  async billK80Html(order) {
    const settings = await this.settings();
    const pay=order.payment||{};

    const monthlyInstallment=Number(order.installment_amount || order.monthly_installment?.installment_amount || 0);
    const storedTotal=Number(order.total_amount||0);
    const rawCurrentBill=Number(order.current_bill_amount||0);
    const itemTotal=(order.items||[]).reduce((sum,i)=>sum+Number(i.total_price || (Number(i.quantity||0)*Number(i.sale_price||0)) || 0),0);

    // K80 dùng cùng rule với A4:
    // total_amount đã là tổng cuối cùng, đã bao gồm góp nợ/ngày.
    // Không cộng installment_amount thêm lần nữa.
    const payableTotal = storedTotal > 0
      ? storedTotal
      : (rawCurrentBill > 0
          ? rawCurrentBill
          : (itemTotal + monthlyInstallment));

    const todayBillTotal = monthlyInstallment > 0
      ? Math.max(0, payableTotal - monthlyInstallment)
      : (rawCurrentBill || itemTotal || payableTotal);

    const {allocs:paymentAllocations, paid:allocatedPaidTotal, cash:allocatedCashTotal, bank:allocatedBankTotal, remaining:remainingDebt}=allocationSummary(order,payableTotal);
    const statusLabel = paymentStatusLabel(order.payment_status, remainingDebt);
    const paymentRows = paymentAllocations.map((a,idx)=>{ const t={cash:Number(a.__cash ?? allocationTender(a).cash), bank:Number(a.__bank ?? allocationTender(a).bank), total:Number(a.__total ?? a.allocated_amount ?? allocationTender(a).total)}; return `<div>Dot TT ${idx+1}: TM ${formatMoneyValue(t.cash)} / CK ${formatMoneyValue(t.bank)}</div><div class="right">Gia tri TT: ${formatMoneyValue(t.total)}</div>`; }).join('');
    const billDate = order.calendar_type==='LUNAR' && order.lunar_date_text ? `${order.lunar_date_text} ÂL / ${ymd(order.order_date)} DL` : (ymd(order.order_date) || ymd(pay.payment_date) || '');
    const createdDate = ymd(order.created_at) || ymd(order.order_date);
    const showInstallment = monthlyInstallment > 0;

    const rows = (order.items||[]).map((i,idx)=>`
      <tr>
        <td>${idx+1}. ${i.product_name}<br>
          <span${qtyTitleAttr(i,qty(i.quantity,settings.quantity_decimal_places))}>${qty(i.quantity,settings.quantity_decimal_places)}</span> ${i.unit} × ${formatMoneyValue(i.sale_price)} = ${formatMoneyValue(i.total_price)}
        </td>
      </tr>
    `).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><title>${order.order_code}</title><style>
@page{margin:2mm 3mm 3mm 3mm}
body{font-family:Arial,sans-serif;margin:0;padding:0;color:#111;width:78mm;font-size:12px}
.center{text-align:center}.shop{font-size:16px;font-weight:900}.muted{font-size:11px;color:#555}
hr{border:0;border-top:1px dashed #333;margin:4px 0}
table{width:100%;border-collapse:collapse}td{padding:3px 0;vertical-align:top}.right{text-align:right;white-space:nowrap}
.total{font-size:13px;font-weight:900;margin-top:4px}.print-btn{position:fixed;right:10px;top:10px;padding:8px;background:#111;color:#fff;border:0;border-radius:6px}
@media print{.print-btn{display:none}body{width:78mm;margin:0;padding:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">IN K80</button>
<div class="center">
  <div class="shop">${settings.shop_name||"MEATBIZ FOOD"}</div>
  <div class="muted">${settings.shop_address||""}</div>
  <div class="muted">${settings.shop_phone||""}</div>
  <div><b>PHIẾU BÁN HÀNG</b></div>
  <div class="muted">Đơn vị tiền: VND</div>
</div>
${cancelledBannerHtml(order, 'k80')}
<hr>
<div>Mã bill: <b>${order.order_code}</b></div>
<div>Ngày lập: ${createdDate}</div>
<div>Ngày xuất hàng: ${billDate}</div>
<div>Khách: ${order.customer_name||''}</div>
<div>SĐT: ${order.phone||''}</div>
<hr>
<table>${rows}</table>
<hr>
<div><b>THONG TIN THANH TOAN</b></div>
<div>${paymentRows || 'Chua phat sinh thanh toan'}</div>
<hr>
<div><b>TONG HOP CONG NO</b></div>
<div class="right total">Gia tri hang hoa: ${formatMoneyValue(todayBillTotal)}</div>
${showInstallment ? `<div class="right total">Gop no/ngay: ${formatMoneyValue(monthlyInstallment)}</div>` : ''}
<div class="right total">Tong tien mat: ${formatMoneyValue(allocatedCashTotal)}</div>
<div class="right total">Tong chuyen khoan: ${formatMoneyValue(allocatedBankTotal)}</div>
<div class="right total">Tong da TT: ${formatMoneyValue(allocatedPaidTotal)}</div>
<div class="right total">Du no con lai: ${formatMoneyValue(remainingDebt)}</div>
<div class="right total">Tinh trang: ${statusLabel}</div>
<div class="right total">TONG: ${formatMoneyWithCurrency(payableTotal)}</div>
<hr>
<div class="center muted">${settings.bill_footer||'Cảm ơn quý khách!'}</div>
</body></html>`;
  }


  async lotHtml(lot) {
    const settings = await this.settings();
    const expr = (v, fallback) => v && String(v).trim() ? v : fallback;
    const rawExpr = expr(lot.raw_weight_expr, lot.raw_weight);
    const boneExpr = expr(lot.bone_weight_expr, lot.bone_weight);
    const deductMode = lot.deduct_mode || 'PER_ANIMAL';
    const deductExpr = deductMode === 'TOTAL_KG'
      ? expr(lot.deducted_weight_expr, lot.deducted_weight)
      : `${lot.total_animals||0} con × ${lot.deduct_kg_per_animal||0} kg/con`;
    const lotMappedSolarDate = ymd(lot.purchase_date) || '';
    const lotDate = lot.calendar_type === 'LUNAR' && lot.lunar_date_text
      ? `${lot.lunar_date_text} ÂL`
      : (lotMappedSolarDate ? `${lotMappedSolarDate} DL` : '');
    const lotCreatedDate = ymd(lot.created_at) || lotMappedSolarDate;
    const lotUrl = `${publicAppUrl()}/api/lots/public/${lot.public_token}/print`;
    const lotQr = await QRCode.toDataURL(lotUrl);

    const isPriced = lot.price_status === 'PRICED';
    // Bold border + explicit label text, not color alone, so the status still
    // reads on a grayscale/thermal print — color is layered on top only as a
    // secondary cue, per the print-only scope of this patch.
    const priceStatusBadge = `<div style="display:inline-block;margin-top:6px;padding:4px 10px;border:2px solid #111;border-radius:4px;font-weight:900;letter-spacing:.5px;${isPriced?'color:#166534':'color:#7f1d1d'}">TRẠNG THÁI TÍNH TIỀN: ${isPriced?'ĐÃ TÍNH TIỀN':'CHƯA TÍNH TIỀN'}</div>`;

    return `<!doctype html><html><head><meta charset="utf-8"><title>${lot.lot_code}</title><style>
body{font-family:Arial;margin:28px;color:#111}.header{display:flex;justify-content:space-between;gap:18px;border-bottom:3px solid #7f1d1d;padding-bottom:12px}.logo{font-size:28px;font-weight:900;color:#7f1d1d}.qr{width:120px;height:120px}.sub{color:#666;font-size:12px;text-align:center}
table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border:1px solid #ddd;padding:10px}th{background:#7f1d1d;color:white}.right{text-align:right;white-space:nowrap}.total{font-size:22px;font-weight:900;text-align:right;margin-top:18px}.print{position:fixed;right:20px;top:20px;padding:12px 18px;background:#7f1d1d;color:#fff;border:0;border-radius:10px}.note{white-space:pre-wrap}.muted{color:#666}@media print{.print{display:none}}</style></head><body>
<button class="print" onclick="window.print()">IN PHIẾU</button><div class="header"><div><div class="logo">PHIẾU NHẬP LÔ / NHÀ CUNG CẤP</div><div>Mã lô: <b>${lot.lot_code}</b></div><div>Ngày lập phiếu: ${lotCreatedDate}</div><div>Ngày nhập hàng: ${lot.calendar_type==='LUNAR' ? `${lotMappedSolarDate} (${lotDate} âm lịch)` : lotMappedSolarDate}</div><div>Lịch tính bill: ${lot.calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</div>${priceStatusBadge}</div><div><img class="qr" src="${lotQr}"><div class="sub">Quét QR xem phiếu NCC</div></div></div>
<p><b>Nhà cung cấp:</b> ${lot.supplier_name||''} - ${lot.supplier_phone||''}<br><b>Địa chỉ:</b> ${lot.supplier_address||''}</p>
<table><tbody>
<tr><th>Nội dung</th><th>Cách nhập</th><th class="right">Giá trị (kg)</th></tr>
<tr><td>Tổng kg thịt xô</td><td>${rawExpr}</td><td class="right">${qty(lot.raw_weight,settings.quantity_decimal_places)}</td></tr>
<tr><td>Xương sườn quy đổi thịt xô</td><td>${boneExpr} / 2</td><td class="right">+${qty(Number(lot.bone_weight||0)/2,settings.quantity_decimal_places)}</td></tr>
<tr><td>Trừ xô</td><td>${deductExpr}</td><td class="right">-${qty(lot.deducted_weight,settings.quantity_decimal_places)}</td></tr>
<tr><td>Trừ bò hư</td><td></td><td class="right">-${qty(lot.damage_weight,settings.quantity_decimal_places)}</td></tr>
<tr><td>Trừ mỡ</td><td></td><td class="right">-${qty(lot.fat_weight,settings.quantity_decimal_places)}</td></tr>
<tr><td>Trừ khác</td><td>${lot.deduct_note||''}</td><td class="right">-${qty(lot.other_deduct_weight,settings.quantity_decimal_places)}</td></tr>
<tr><td><b>Kg bò xô tính tiền</b></td><td></td><td class="right"><b>${qty(lot.total_weight,settings.quantity_decimal_places)}</b></td></tr>
</tbody></table>

<table><tbody>
<tr><th>Phân loại bò</th><th class="right">Số con</th><th class="right">Kg phân bổ</th><th class="right">Đơn giá (VND/kg)</th></tr>
<tr><td>Bò đực</td><td class="right">${animal(lot.male_animals)}</td><td class="right">${qty(lot.male_weight,settings.quantity_decimal_places)}</td><td class="right">${formatMoneyValue(lot.male_price||lot.purchase_price)}</td></tr>
<tr><td>Bò cái</td><td class="right">${animal(lot.female_animals)}</td><td class="right">${qty(lot.female_weight,settings.quantity_decimal_places)}</td><td class="right">${formatMoneyValue(lot.female_price||lot.purchase_price)}</td></tr>
<tr><td>Thịt vụn</td><td class="right"></td><td class="right">${qty(lot.fragment_weight,settings.quantity_decimal_places)}</td><td class="right">${formatMoneyValue(lot.fragment_price||0)}</td></tr>
</tbody></table>

<table><tbody>
<tr><td>Đã ứng</td><td class="right">${formatMoneyValue(lot.advance_amount)}</td></tr>
<tr><td>Đã trả</td><td class="right">${formatMoneyValue(lot.paid_amount)}</td></tr>
<tr><td>Còn phải trả</td><td class="right">${formatMoneyValue(lot.remaining_amount)}</td></tr>
<tr><td>Ghi chú / mô tả lô</td><td class="note">${lot.note||''}</td></tr>
</tbody></table>
<div class="total">Thành tiền: ${isPriced ? formatMoneyWithCurrency(lot.total_cost) : 'CHƯA TÍNH'}</div></body></html>`;
  }
  
}
module.exports = new PrintService();
