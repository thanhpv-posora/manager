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

// fix(partner) partial-update compatibility: distinguishes "caller omitted
// this field" (any of `keys` absent from the payload — preserve the existing
// DB value) from "caller explicitly sent it" (present, even as '' — must be
// validated, never silently coerced to the old value). A plain `data.x||''`
// fallback cannot tell these apart, which is exactly what made an explicit
// blank-out attempt indistinguishable from an omitted field.
function isFieldProvided(data, keys){
  return keys.some(k=>Object.prototype.hasOwnProperty.call(data,k));
}

// fix(partner) identity validation: digits-only comparison so "0905 123 456",
// "0905-123-456" and "0905123456" are one identity. Comparison-only — the
// raw phone as typed is still what gets stored/displayed (no reformatting of
// existing data). Mirrors the REGEXP_REPLACE used in the duplicate check and
// in _syncPartnerToSupplier's reuse match below, so all three stay consistent.
function normalizePhoneIdentity(phone){
  return String(phone||'').replace(/\D/g,'');
}

// fix(partner) identity validation: normalized name + normalized phone must
// be unique among ACTIVE (del_flg=0) partners. Deleted partners never block
// reuse — same del_flg=0 convention already used by list()/_syncPartnerToSupplier
// elsewhere in this file, not a new rule. excludeId lets update() ignore the
// record being edited.
async function assertUniquePartnerIdentity(name, phone, excludeId){
  const params=[name.trim().toLowerCase(), normalizePhoneIdentity(phone)];
  let sql=`SELECT id FROM customers WHERE del_flg=0 AND LOWER(TRIM(name))=? AND REGEXP_REPLACE(phone,'[^0-9]','')=?`;
  if(excludeId){ sql+=' AND id<>?'; params.push(excludeId); }
  const [rows]=await pool.query(sql, params);
  if(rows.length){
    const err=new Error('Đã tồn tại đối tác khác với cùng tên và số điện thoại.');
    err.status=400; err.statusCode=400; err.code='PARTNER_DUPLICATE_IDENTITY';
    throw err;
  }
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

    // Find a reusable supplier row: prefer phone match, then name match.
    // Eligible = genuinely unmapped (no supplier_partner_map row at all) OR
    // mapped only to a partner that is itself soft-deleted — i.e. provably
    // orphaned by CustomerAgent.remove()'s lifecycle sync (above), not some
    // unrelated supplier a different, still-active partner owns. This is the
    // fix for the "LÒ Bảy Tầm" duplicate-supplier bug: previously ANY
    // existing mapping row — even one pointing at an already-deleted partner
    // — blocked reuse, so re-linking a same phone/name partner always minted
    // a brand new supplier instead of reclaiming the orphaned one. The
    // eligibility check itself is keyed off the mapping + the partner's own
    // del_flg (stable, existing identifiers), not name — name/phone are only
    // ever used as the original candidate lookup, same as before.
    // A reused pre-existing row's other fields (name/phone/address/etc) are
    // intentionally left as-is here (first-time link only, no prior "current
    // Partner state" to argue is stale) — only the already-mapped path above
    // overwrites fields; the reactivation below only ever touches
    // is_active/del_flg/delete_* so a reused orphan becomes selectable again.
    let supplierId=null;
    const reuseFilter=`
      AND (
        s.del_flg=0
        OR EXISTS (SELECT 1 FROM supplier_partner_map om JOIN customers oc ON oc.id=om.partner_id WHERE om.supplier_id=s.id AND oc.del_flg=1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM supplier_partner_map am JOIN customers ac ON ac.id=am.partner_id
        WHERE am.supplier_id=s.id AND ac.del_flg=0
      )`;
    // fix(partner) identity validation: normalized (digits-only) comparison so
    // a supplier row saved as "0905123456" is still matched by a partner phone
    // typed as "0905-123-456" — consistent with assertUniquePartnerIdentity()
    // above, not a separate rule.
    const normPartnerPhone=normalizePhoneIdentity(partner.phone);
    if(normPartnerPhone){
      const [[byPhone]]=await pool.query(
        `SELECT s.id FROM suppliers s WHERE REGEXP_REPLACE(s.phone,'[^0-9]','')=? ${reuseFilter} LIMIT 1`,
        [normPartnerPhone]
      );
      if(byPhone) supplierId=byPhone.id;
    }
    if(!supplierId){
      const [[byName]]=await pool.query(
        `SELECT s.id FROM suppliers s WHERE s.name=? ${reuseFilter} LIMIT 1`,
        [partner.name]
      );
      if(byName) supplierId=byName.id;
    }

    // fix(partner) defense-in-depth: reuseFilter above already excludes any
    // supplier currently mapped to an ACTIVE partner, but that SELECT and the
    // INSERT ... ON DUPLICATE KEY UPDATE below are two separate queries, not
    // one transaction — do not trust the SELECT alone as the sole
    // authorization check for reassigning a mapping. Re-verify right before
    // committing to the candidate: if it now has ANY active-partner mapping,
    // abandon the reuse entirely rather than reassign it (never steal a
    // mapping from an active partner) — falls through to the "no reusable
    // supplier row" branch below, the same existing/correct fallback used
    // when no candidate was found at all.
    if(supplierId){
      const [[stillOrphan]]=await pool.query(
        `SELECT 1 ok FROM supplier_partner_map m JOIN customers c ON c.id=m.partner_id AND c.del_flg=0 WHERE m.supplier_id=? LIMIT 1`,
        [supplierId]
      );
      if(stillOrphan) supplierId=null;
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
    } else {
      // Reactivate — this reuse candidate may have been auto-deactivated by
      // CustomerAgent.remove()'s lifecycle sync when its previous partner was
      // deleted. A no-op for a candidate that was already active.
      await pool.query(
        `UPDATE suppliers SET is_active=1,del_flg=0,delete_reason=NULL,deleted_at=NULL,deleted_by=NULL WHERE id=?`,
        [supplierId]
      );
    }

    // fix(partner) bug found while testing the identity-validation change:
    // supplier_partner_map.uq_spm_supplier is UNIQUE(supplier_id) — reusing an
    // orphaned supplier (its OLD mapping row, to the now-deleted partner,
    // deliberately left in place — see remove() above) means a row for this
    // supplier_id already exists. Plain INSERT IGNORE silently swallowed that
    // unique-constraint conflict, so the reuse path looked successful (correct
    // supplier_id returned, supplier reactivated) but the mapping row was
    // NEVER actually reassigned to the new partner — it kept pointing at the
    // dead one. ON DUPLICATE KEY UPDATE reassigns that existing row's
    // partner_id instead of trying (and silently failing) to insert a second
    // one; for a genuinely new supplier (no existing row for this supplier_id)
    // it behaves as a plain insert, unchanged.
    await pool.query(
      `INSERT INTO supplier_partner_map(supplier_id,partner_id) VALUES(?,?)
       ON DUPLICATE KEY UPDATE partner_id=VALUES(partner_id)`,
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
    // fix(partner) identity validation: phone required on every create/edit
    // (explicit business rule — Partner Duplicate Validation requirement).
    if(!normalizePhoneIdentity(data.phone)) throw Object.assign(new Error('Số điện thoại không được để trống'),{status:400,statusCode:400,code:'PARTNER_PHONE_REQUIRED'});
    await assertUniquePartnerIdentity(name, data.phone);

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
    await assertCustomerScope(user,id);

    // fix(partner) partial-update compatibility: several existing callers
    // (e.g. price-sync updates, or backend/scripts/verify-*.js regression
    // scripts touching an unrelated field) legitimately PATCH a Partner
    // without resending name/phone. The identity rule (phone required,
    // normalized name+phone unique) must apply to the FINAL effective
    // record, not to whatever subset of fields this one request happened to
    // include — an omitted field preserves the existing value; an
    // explicitly-sent blank value ('') is a real attempt to clear it and
    // must still be rejected. `data.phone||existing.phone` cannot make that
    // distinction (both look identical once '' is involved), hence
    // isFieldProvided() below instead of a truthy fallback.
    const [[existingCust]] = await pool.query(`SELECT name, phone, default_sales_flow FROM customers WHERE id=? AND del_flg=0`, [id]);
    if(!existingCust) throw Object.assign(new Error('Không tìm thấy đối tác hoặc đã xóa'),{status:404,statusCode:404});

    const nameProvided = isFieldProvided(data, ['name','customer_name','full_name']);
    const effectiveName = nameProvided ? cleanName(data) : String(existingCust.name||'').trim();
    if(!effectiveName) throw new Error('Tên khách hàng không được để trống');

    const phoneProvided = Object.prototype.hasOwnProperty.call(data,'phone');
    const effectivePhone = phoneProvided ? String(data.phone||'') : String(existingCust.phone||'');
    if(!normalizePhoneIdentity(effectivePhone)) throw Object.assign(new Error('Số điện thoại không được để trống'),{status:400,statusCode:400,code:'PARTNER_PHONE_REQUIRED'});

    await assertUniquePartnerIdentity(effectiveName, effectivePhone, id);

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
    if (defaultSalesFlow && defaultSalesFlow !== existingCust.default_sales_flow) {
      const PriceMatrixAgent = require('./PriceMatrixAgent');
      await PriceMatrixAgent.assertCustomerDefaultFlowChangeIsSafe(id, defaultSalesFlow);
    }

    await pool.query(
      `UPDATE customers SET name=?,phone=?,address=?,price_mode=?,billing_calendar_type=?,note=?,is_active=?,partner_type=?,default_sales_flow=? WHERE id=? AND del_flg=0`,
      [effectiveName,effectivePhone,data.address||'',normalizePriceMode(data.price_mode),normalizeBillingCalendarType(data.billing_calendar_type),data.note||'',data.is_active?1:0,partner_type,defaultSalesFlow,id]
    );
    // _syncPartnerToSupplier() re-SELECTs the partner's own name/phone fresh
    // from `customers` (not from this `data` object), so it always sees the
    // effectiveName/effectivePhone just committed above regardless of which
    // fields this particular request included — an omitted phone here can
    // never reach it as empty/undefined. The explicit name/phone below are
    // passed for self-documentation only (harmless, not load-bearing).
    const sync=(partner_type & 1) === 1 ? await this._syncPartnerToSupplier(id, {...data, name: effectiveName, phone: effectivePhone}) : null;
    return {message:'Đã cập nhật đối tác',...(sync||{})};
  }

  // fix(partner): a partner mapped through supplier_partner_map owns the
  // visibility lifecycle of its linked supplier row (this is exactly the
  // relationship AUTH-SCOPE-001's resolveSupplierScope()/supplierScopeWhere()
  // in middleware/scope.js already assume is 1:1). Previously this only
  // soft-deleted `customers`, leaving the mapped `suppliers` row (and its
  // supplier_partner_map row) untouched — a deleted supplier-type partner
  // stayed fully active/selectable in Nhập Xô forever (root cause of the
  // "LÒ Bảy Tầm" duplicate-supplier bug: a later re-sync then minted a
  // second supplier row because _syncPartnerToSupplier saw the orphaned
  // mapping and refused to reuse it — see that function's reuse query,
  // fixed alongside this).
  //
  // Both updates now run in one transaction so a partner can never end up
  // deleted-with-supplier-still-active, or vice versa.
  async remove(id,reason,user){
    if(user&&user.role==='CUSTOMER'){
      if(Number(id)===Number(user.customer_id)) throw new Error('Không thể xóa tài khoản chính của mình');
      await assertCustomerScope(user,id);
    }
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      await conn.query(`UPDATE customers SET del_flg=1,note=CONCAT(COALESCE(note,''),'\nXóa: ',?) WHERE id=?`,[reason||'',id]);

      const [[map]]=await conn.query(`SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`,[id]);
      if(map){
        // Deliberately NOT SoftDeleteAgent.softDelete('supplier',...): its
        // reference check exists to BLOCK deleting data still in active use
        // (purchase_lots/purchase_orders/etc reference it) — exactly backwards
        // here, where we're hiding a supplier whose OWNING PARTNER is gone,
        // not asking permission to delete its history. Historical
        // purchase_lots/supplier_payments keep supplier_id unchanged and stay
        // fully readable; only the supplier row's own visibility flags change.
        const [supRes]=await conn.query(
          `UPDATE suppliers SET is_active=0,del_flg=1,delete_reason=?,deleted_at=NOW(),deleted_by=? WHERE id=? AND del_flg=0`,
          [reason||'',user?.id||null,map.supplier_id]
        );
        // supplier_partner_map row is intentionally left in place — no code
        // path in this codebase ever DELETEs from that table, and both FK
        // targets (suppliers, customers) are always soft-deleted, never
        // physically removed, so the row's FK constraints stay satisfied
        // either way. Keeping it also preserves the historical
        // partner<->supplier trail and is what _syncPartnerToSupplier's reuse
        // fix (below) keys off of to safely re-link this exact supplier if
        // the partner is ever recreated — reassigning this same row's
        // partner_id via ON DUPLICATE KEY UPDATE (uq_spm_supplier), not by
        // inserting a second row.
        if(supRes.affectedRows){
          const [[sup]]=await conn.query(`SELECT supplier_code,name FROM suppliers WHERE id=?`,[map.supplier_id]);
          await conn.query(
            `INSERT INTO delete_logs(entity_type,entity_id,entity_code,entity_name,reason,deleted_by) VALUES('supplier',?,?,?,?,?)`,
            [map.supplier_id,sup?.supplier_code||'',sup?.name||'',`Tự động ẩn do xóa đối tác #${id}: ${reason||''}`,user?.id||null]
          );
        }
      }

      await conn.commit();
      return {message:'Đã xóa mềm khách hàng'};
    }catch(e){ await conn.rollback(); throw e; }finally{ conn.release(); }
  }

  async nextCode(){
    return {customer_code:await nextCustomerCode()};
  }
}
module.exports=new CustomerAgent();
