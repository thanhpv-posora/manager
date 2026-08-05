const pool=require('../config/db');
const { assertCustomerScope, customerScopeWhere }=require('../middleware/scope');

async function nextCustomerCode(){
  const [rows]=await pool.query(`SELECT customer_code FROM customers WHERE customer_code REGEXP '^KH[0-9]+$' ORDER BY CAST(SUBSTRING(customer_code,3) AS UNSIGNED) DESC LIMIT 1`);
  let nextNo=1;
  if(rows.length){
    const n=parseInt(String(rows[0].customer_code).replace('KH',''),10);
    if(!Number.isNaN(n)) nextNo=n+1;
  }
  return 'KH'+String(nextNo).padStart(3,'0');
}

function normalizePriceMode(mode){
  const m=String(mode||'').trim();
  if(['COMMON_PRICE','CUSTOM_PRICE','PRIVATE','PRIVATE_PRICE'].includes(m)) return m;
  if(m==='PRIVATE_PRICE') return 'CUSTOM_PRICE';
  return 'COMMON_PRICE';
}

function normalizeBillingCalendarType(type){
  return String(type||'SOLAR').toUpperCase()==='LUNAR' ? 'LUNAR' : 'SOLAR';
}

// fix(partner): customers.partner_type is a bitmask — 1=Nhà cung cấp (supplier
// bit), 2=Khách hàng (customer bit), 3=Khách hàng và Nhà cung cấp (both bits).
// PartnerAgent.listPartners() (`role=both` → `partner_type=3`),
// InventoryPurchaseAgent._resolvePartner(), and SupplierPurchaseOptionAgent
// already read this column as a bitmask ((partner_type & 1)=1 for the
// supplier role) — this normalizer is what completes the WRITE side to match,
// so a Partner can actually be saved as both. Previously this coerced any
// value that wasn't exactly 1 down to 2, making partner_type=3 unreachable.
// Anything invalid (missing, 0, garbage) still defaults to 2, matching this
// column's own DB-level DEFAULT 2.
function normalizePartnerType(value){
  const n=Number(value);
  return [1,2,3].includes(n) ? n : 2;
}

function cleanName(data){
  return String(data.name||data.customer_name||data.full_name||'').trim();
}

// Customer Default Model: customers.default_sales_flow picks which screen
// CreateOrder should default to for this customer. S1M: it is now ALSO the
// inheritance source for any Customer Price Category that has no sales_flow
// classification of its own (see PriceMatrixAgent.resolveEffectiveSalesFlow) —
// no longer purely a UI hint, since it can determine which products a Price
// Matrix category resolves to and which price-book items are considered
// compatible. Still never used for inventory/ledger/reports. Required when
// creating a brand new customer; optional when editing an existing one, so a
// legacy customer can stay NULL indefinitely or be classified later without
// that being forced. Changing it on an existing customer is guarded — see
// assertCustomerDefaultFlowChangeIsSafe() below.
const VALID_DEFAULT_SALES_FLOW = ['CARCASS_POS', 'INVENTORY_SALE'];
function normalizeDefaultSalesFlow(value, { required }){
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw Object.assign(
        new Error('Vui lòng chọn luồng bán hàng mặc định (Bò Xô hoặc Bán hàng kho) cho khách hàng mới.'),
        { status: 400, statusCode: 400, code: 'DEFAULT_SALES_FLOW_REQUIRED' }
      );
    }
    return null;
  }
  if (!VALID_DEFAULT_SALES_FLOW.includes(value)) {
    throw Object.assign(
      new Error(`default_sales_flow không hợp lệ: "${value}". Chỉ chấp nhận CARCASS_POS hoặc INVENTORY_SALE.`),
      { status: 400, statusCode: 400, code: 'INVALID_DEFAULT_SALES_FLOW' }
    );
  }
  return value;
}

class CustomerAgent{
  constructor(){
    this.version='6.28.0';
    this.responsibility='Customer CRUD scoped by user/customer, child customers, validation';
  }

  // Ensures a suppliers row and supplier_partner_map entry exist for this
  // partner, AND keeps the linked supplier's editable fields in sync on every
  // subsequent save. Idempotent: safe to call whenever the supplier bit
  // ((partner_type & 1) === 1) is set.
  //
  // fix(partner) sync-audit finding: previously, once a partner was mapped,
  // every later call short-circuited immediately ("Đã liên kết trước đó")
  // WITHOUT ever touching the linked supplier row again — changing the
  // Partner's name/phone/address/note/billing_calendar_type (or the Bò Xô
  // beef prices, now exposed on the Partner form — see beefPrices param)
  // never propagated past the first sync. Fixed below: an already-mapped
  // partner now UPDATEs its linked supplier instead of no-op'ing.
  //
  // @param {object} beefPrices optional {male_price,female_price,fragment_price}
  //   — same fields SupplierAgent.addSupplier()/updateSupplier() already
  //   accept, defaulted to 0 when absent (matching that same convention, not
  //   a partial-update — the removed Suppliers.jsx page always wrote all 3).
  async _syncPartnerToSupplier(customerId, beefPrices={}){
    const [[partner]]=await pool.query(
      `SELECT id,name,phone,address,note,billing_calendar_type,is_active FROM customers WHERE id=? AND del_flg=0`,
      [customerId]
    );
    if(!partner) return null;

    const malePrice=Number(beefPrices.male_price||0);
    const femalePrice=Number(beefPrices.female_price||0);
    const fragmentPrice=Number(beefPrices.fragment_price||0);

    // Already mapped — sync the linked supplier's fields to current Partner
    // values instead of no-op'ing (see finding above).
    const [[existing]]=await pool.query(
      `SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`,[customerId]
    );
    if(existing){
      await pool.query(
        `UPDATE suppliers SET name=?,phone=?,address=?,note=?,billing_calendar_type=?,is_active=?,male_price=?,female_price=?,fragment_price=?
         WHERE id=? AND del_flg=0`,
        [partner.name,partner.phone||'',partner.address||'',partner.note||'',
         partner.billing_calendar_type||'SOLAR',partner.is_active,malePrice,femalePrice,fragmentPrice,
         existing.supplier_id]
      );
      return {partner_id:customerId,supplier_id:existing.supplier_id,message:'Đã đồng bộ nhà cung cấp liên kết'};
    }

    // Find an unmapped supplier row: prefer phone match, then name match.
    // A reused pre-existing orphan row's fields are intentionally left as-is
    // here (first-time link only, no prior "current Partner state" to argue
    // is stale) — only the already-mapped path above overwrites fields.
    let supplierId=null;
    if(partner.phone){
      const [[byPhone]]=await pool.query(
        `SELECT s.id FROM suppliers s
         WHERE s.phone=? AND s.del_flg=0
         AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.supplier_id=s.id)
         LIMIT 1`,
        [partner.phone]
      );
      if(byPhone) supplierId=byPhone.id;
    }
    if(!supplierId){
      const [[byName]]=await pool.query(
        `SELECT s.id FROM suppliers s
         WHERE s.name=? AND s.del_flg=0
         AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.supplier_id=s.id)
         LIMIT 1`,
        [partner.name]
      );
      if(byName) supplierId=byName.id;
    }

    // No reusable supplier row — create one
    if(!supplierId){
      const code='NCC'+Date.now();
      const [ins]=await pool.query(
        `INSERT INTO suppliers(supplier_code,name,phone,address,note,billing_calendar_type,male_price,female_price,fragment_price,is_active,del_flg)
         VALUES(?,?,?,?,?,?,?,?,?,?,0)`,
        [code,partner.name,partner.phone||'',partner.address||'',partner.note||'',
         partner.billing_calendar_type||'SOLAR',malePrice,femalePrice,fragmentPrice,partner.is_active]
      );
      supplierId=ins.insertId;
    }

    await pool.query(
      `INSERT IGNORE INTO supplier_partner_map(supplier_id,partner_id) VALUES(?,?)`,
      [supplierId,customerId]
    );
    return {partner_id:customerId,supplier_id:supplierId,message:'Đã liên kết nhà cung cấp'};
  }

  async list(user){
    const scope=await customerScopeWhere(user,'c.id');
    const where='WHERE c.del_flg=0'+(scope.clause?' AND '+scope.clause:'');
    const params=[...scope.params];
    // fix(partner): expose the linked supplier's Bò Xô prices (via
    // supplier_partner_map) so the Partner Edit dialog can pre-fill its
    // "Thông tin giá Bò Xô" section with the CURRENT saved values instead of
    // always starting blank — without this, every edit would silently
    // overwrite them back to 0 (the section always submits some value, see
    // _syncPartnerToSupplier). Aliased (not male_price/female_price/
    // fragment_price directly) so they never collide with any future
    // same-named column on customers itself.
    const [rows]=await pool.query(
      `SELECT c.*,
        pc.name parent_customer_name,
        s.male_price supplier_male_price,
        s.female_price supplier_female_price,
        s.fragment_price supplier_fragment_price,
        COALESCE(SUM(CASE
          WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
          WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount
          ELSE 0 END),0) current_debt
       FROM customers c
       LEFT JOIN customers pc ON pc.id=c.parent_customer_id
       LEFT JOIN supplier_partner_map spm ON spm.partner_id=c.id
       LEFT JOIN suppliers s ON s.id=spm.supplier_id
       LEFT JOIN debt_transactions dt ON dt.customer_id=c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.parent_customer_id IS NULL DESC,c.id DESC`,
      params
    );
    return rows;
  }

  async create(data,user){
    const name=cleanName(data);
    if(!name) throw new Error('Tên khách hàng không được để trống');

    const code=data.customer_code||await nextCustomerCode();
    const parentCustomerId=(user&&user.role==='CUSTOMER')?user.customer_id:(data.parent_customer_id||null);

    const partner_type = normalizePartnerType(data.partner_type);
    // Customer Default Model Rule 3: required for every NEW customer that has
    // the customer bit set (partner_type=2 Khách hàng or partner_type=3
    // Khách hàng và Nhà cung cấp) — a pure partner_type=1 (supplier-only) row
    // is not sold to via CreateOrder at all, so it is exempt.
    const defaultSalesFlow = normalizeDefaultSalesFlow(data.default_sales_flow, { required: (partner_type & 2) === 2 });
    const [ins]=await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,billing_calendar_type,note,is_active,del_flg,parent_customer_id,partner_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,1,0,?,?,?)`,
      [code,name,data.phone||'',data.address||'',normalizePriceMode(data.price_mode),normalizeBillingCalendarType(data.billing_calendar_type),data.note||'',parentCustomerId,partner_type,defaultSalesFlow]
    );
    const sync=(partner_type & 1) === 1 ? await this._syncPartnerToSupplier(ins.insertId, data) : null;
    return {message:'Đã tạo đối tác',customer_code:code,...(sync||{})};
  }

  async update(id,data,user){
    const name=cleanName(data);
    if(!name) throw new Error('Tên khách hàng không được để trống');

    await assertCustomerScope(user,id);

    const partner_type = normalizePartnerType(data.partner_type);
    // Customer Default Model Rule 3: never required on edit — a legacy customer
    // may stay NULL indefinitely (no backfill, no forced classification), or be
    // classified now if the form explicitly sends a value.
    const defaultSalesFlow = normalizeDefaultSalesFlow(data.default_sales_flow, { required: false });

    // S1M: default_sales_flow is no longer a UI-only hint — Customer Price
    // Categories with no explicit classification of their own now inherit it
    // for pricing/product-filtering (see PriceMatrixAgent's
    // resolveEffectiveSalesFlow). Changing it can therefore make an
    // already-saved price-book item incompatible; only guard an actual
    // change to a new valid value (clearing it to NULL cannot make anything
    // incompatible, so it is never blocked here).
    const [[existingCust]] = await pool.query(`SELECT default_sales_flow FROM customers WHERE id=? AND del_flg=0`, [id]);
    if (existingCust && defaultSalesFlow && defaultSalesFlow !== existingCust.default_sales_flow) {
      const PriceMatrixAgent = require('./PriceMatrixAgent');
      await PriceMatrixAgent.assertCustomerDefaultFlowChangeIsSafe(id, defaultSalesFlow);
    }

    await pool.query(
      `UPDATE customers SET name=?,phone=?,address=?,price_mode=?,billing_calendar_type=?,note=?,is_active=?,partner_type=?,default_sales_flow=? WHERE id=? AND del_flg=0`,
      [name,data.phone||'',data.address||'',normalizePriceMode(data.price_mode),normalizeBillingCalendarType(data.billing_calendar_type),data.note||'',data.is_active?1:0,partner_type,defaultSalesFlow,id]
    );
    const sync=(partner_type & 1) === 1 ? await this._syncPartnerToSupplier(id, data) : null;
    return {message:'Đã cập nhật đối tác',...(sync||{})};
  }

  async remove(id,reason,user){
    if(user&&user.role==='CUSTOMER'){
      if(Number(id)===Number(user.customer_id)) throw new Error('Không thể xóa tài khoản chính của mình');
      await assertCustomerScope(user,id);
    }
    await pool.query(`UPDATE customers SET del_flg=1,note=CONCAT(COALESCE(note,''),'\nXóa: ',?) WHERE id=?`,[reason||'',id]);
    return {message:'Đã xóa mềm khách hàng'};
  }

  async nextCode(){
    return {customer_code:await nextCustomerCode()};
  }
}
module.exports=new CustomerAgent();
