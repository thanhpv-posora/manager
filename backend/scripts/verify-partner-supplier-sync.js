'use strict';
// fix(partner) — Partner-to-Supplier synchronization audit. Verifies:
//   - Creating a Partner with the supplier bit set creates/links exactly one
//     suppliers row (CustomerAgent._syncPartnerToSupplier()).
//   - Repeated saves never create a duplicate supplier (still exactly one
//     supplier_partner_map row for the partner).
//   - PREVIOUSLY BROKEN, now fixed: changing name/phone/address/note/
//     billing_calendar_type on a Partner propagates to the linked supplier
//     on every subsequent save, not just the first.
//   - PREVIOUSLY MISSING, now fixed: male_price/female_price/fragment_price
//     (Bò Xô prices) set on the Partner form persist to the linked supplier,
//     and CustomerAgent.list() exposes the linked supplier's current values
//     back (so the Edit dialog can pre-fill them without zeroing them out).
//   - PREVIOUSLY UNREACHABLE, now fixed: customers.partner_type is a bitmask
//     (1=supplier,2=customer,3=both) — a Partner can now be saved as 3, and
//     PartnerAgent.listPartners() correctly surfaces it under role=supplier,
//     role=customer, AND role=both.
//   - Purchase (InventoryPurchaseAgent._resolvePartner) and Supplier Purchase
//     Options (SupplierPurchaseOptionAgent) resolve the correct supplier_id
//     for a partner_type=3 ("both") Partner, same as a pure partner_type=1.
//   - Changing a Partner AWAY from the supplier role does not delete the
//     linked supplier or the map entry (historical data safety).
//   - A pure partner_type=2 (Khách hàng) Partner never creates a supplier.
//
// Self-cleaning: throwaway partners + suppliers + products + purchase
// orders, removed in `finally`. Never touches real data.

const pool = require('../src/config/db');
const CustomerAgent = require('../src/agents/CustomerAgent');
const PartnerAgent = require('../src/agents/PartnerAgent');
const InventoryPurchaseAgent = require('../src/agents/InventoryPurchaseAgent');
const SupplierPurchaseOptionAgent = require('../src/agents/SupplierPurchaseOptionAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const admin = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function mappedSupplierId(partnerId) {
  const [[row]] = await pool.query(`SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
  return row ? row.supplier_id : null;
}
async function supplierRow(supplierId) {
  const [[row]] = await pool.query(`SELECT * FROM suppliers WHERE id=?`, [supplierId]);
  return row;
}
async function mapRowCount(partnerId) {
  const [[row]] = await pool.query(`SELECT COUNT(*) cnt FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
  return Number(row.cnt);
}

async function main() {
  const partnerIds = [];
  const productIds = [];
  const poIds = [];

  try {
    // ══════════════════ 1: create pure-supplier Partner, verify sync ══════════════════
    let p1Id, p1SupplierId;
    {
      const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const r = await CustomerAgent.create({
        name: `SYNC TEST SUP ${uniq}`, phone: `090${uniq.slice(0, 7)}`, address: 'addr v1', note: 'note v1',
        billing_calendar_type: 'SOLAR', partner_type: 1,
        male_price: 200000, female_price: 190000, fragment_price: 100000,
      }, admin);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE name=? LIMIT 1`, [`SYNC TEST SUP ${uniq}`]);
      p1Id = row.id;
      partnerIds.push(p1Id);

      check('1: create() returns a supplier_id (synced)', !!r.supplier_id, r);
      p1SupplierId = await mappedSupplierId(p1Id);
      check('1: supplier_partner_map links partner -> supplier', p1SupplierId === r.supplier_id, { mapped: p1SupplierId, returned: r.supplier_id });
      const sup = await supplierRow(p1SupplierId);
      check('1: linked supplier has correct name/phone/beef prices from create', sup && sup.name === `SYNC TEST SUP ${uniq}` && Number(sup.male_price) === 200000 && Number(sup.female_price) === 190000 && Number(sup.fragment_price) === 100000, sup);
      check('1: exactly one map row for this partner', await mapRowCount(p1Id) === 1);
    }

    // ══════════════════ 2: repeat save updates linked supplier (was broken) ══════════════════
    {
      await CustomerAgent.update(p1Id, {
        name: `SYNC TEST SUP UPDATED`, phone: '0999999999', address: 'addr v2', note: 'note v2',
        billing_calendar_type: 'LUNAR', partner_type: 1,
        male_price: 210000, female_price: 195000, fragment_price: 105000,
      }, admin);
      const supplierIdAfter = await mappedSupplierId(p1Id);
      check('2: supplier_id UNCHANGED across the edit (no duplicate supplier)', supplierIdAfter === p1SupplierId, { before: p1SupplierId, after: supplierIdAfter });
      check('2: still exactly one map row (no duplicate)', await mapRowCount(p1Id) === 1);
      const sup = await supplierRow(supplierIdAfter);
      check('2 (FIX VERIFIED): linked supplier name/phone/address/note/calendar propagated on repeat save', sup.name === 'SYNC TEST SUP UPDATED' && sup.phone === '0999999999' && sup.address === 'addr v2' && sup.note === 'note v2' && sup.billing_calendar_type === 'LUNAR', sup);
      check('2 (FIX VERIFIED): linked supplier beef prices propagated on repeat save', Number(sup.male_price) === 210000 && Number(sup.female_price) === 195000 && Number(sup.fragment_price) === 105000, sup);
    }

    // ══════════════════ 3: third save (no changes) still no duplicate; list() exposes current values ══════════════════
    {
      await CustomerAgent.update(p1Id, {
        name: 'SYNC TEST SUP UPDATED', phone: '0999999999', address: 'addr v2', note: 'note v2',
        billing_calendar_type: 'LUNAR', partner_type: 1,
        male_price: 210000, female_price: 195000, fragment_price: 105000,
      }, admin);
      check('3: still exactly one map row after a third save', await mapRowCount(p1Id) === 1);

      const listRows = await CustomerAgent.list(admin);
      const listed = listRows.find(r => Number(r.id) === Number(p1Id));
      check('3 (FIX VERIFIED): CustomerAgent.list() exposes the linked supplier\'s CURRENT beef prices (not blank/stale)', listed && Number(listed.supplier_male_price) === 210000 && Number(listed.supplier_female_price) === 195000 && Number(listed.supplier_fragment_price) === 105000, listed);
    }

    // ══════════════════ 4: partner_type=2 (pure customer) never syncs a supplier ══════════════════
    {
      const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const r = await CustomerAgent.create({
        name: `SYNC TEST CUST ${uniq}`, phone: `091${uniq.slice(0, 7)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE name=? LIMIT 1`, [`SYNC TEST CUST ${uniq}`]);
      partnerIds.push(row.id);
      check('4: pure Khách hàng create() returns no supplier_id', !r.supplier_id, r);
      check('4: no supplier_partner_map row created', await mapRowCount(row.id) === 0);
    }

    // ══════════════════ 5: partner_type=3 (both) — the previously-unreachable bitmask value ══════════════════
    let p3Id, p3SupplierId;
    {
      const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const r = await CustomerAgent.create({
        name: `SYNC TEST BOTH ${uniq}`, phone: `092${uniq.slice(0, 7)}`, partner_type: 3, default_sales_flow: 'INVENTORY_SALE',
        male_price: 220000, female_price: 200000, fragment_price: 110000,
      }, admin);
      const [[row]] = await pool.query(`SELECT id, partner_type FROM customers WHERE name=? LIMIT 1`, [`SYNC TEST BOTH ${uniq}`]);
      p3Id = row.id;
      partnerIds.push(p3Id);

      check('5 (FIX VERIFIED): partner_type=3 actually persisted (was coerced to 2 before this fix)', Number(row.partner_type) === 3, row);
      check('5: "both" partner still syncs a supplier (supplier bit set)', !!r.supplier_id, r);
      p3SupplierId = r.supplier_id;

      const asSupplier = await PartnerAgent.listPartners(null, { role: 'supplier' });
      const asCustomer = await PartnerAgent.listPartners(null, { role: 'customer' });
      const asBoth = await PartnerAgent.listPartners(null, { role: 'both' });
      check('5: appears under role=supplier', asSupplier.some(x => Number(x.id) === Number(p3Id)));
      check('5: appears under role=customer', asCustomer.some(x => Number(x.id) === Number(p3Id)));
      check('5: appears under role=both', asBoth.some(x => Number(x.id) === Number(p3Id)));
    }

    // ══════════════════ 6: Purchase resolves the correct supplier_id for a "both" partner ══════════════════
    {
      const po = await InventoryPurchaseAgent.create({ partner_id: p3Id, purchase_date: today }, admin.id);
      poIds.push(po.id);
      const [[poRow]] = await pool.query(`SELECT partner_id, supplier_id FROM purchase_orders WHERE id=?`, [po.id]);
      check('6 (FIX VERIFIED): Purchase resolves supplier_id for a partner_type=3 Partner (previously unselectable — (partner_type & 1)=1 was unreachable at 3)', Number(poRow.supplier_id) === Number(p3SupplierId), poRow);
    }

    // ══════════════════ 7: Supplier Purchase Options resolve the same partner_id/supplier_id pair ══════════════════
    {
      const product = await makeProduct();
      productIds.push(product.id);
      const [[unit]] = await pool.query(`SELECT id FROM units WHERE is_active=1 LIMIT 1`);
      const opt = await SupplierPurchaseOptionAgent.create({
        partner_id: p3Id, product_id: product.id, unit_id: unit.id, default_conversion_qty: 1,
      });
      const [[optRow]] = await pool.query(`SELECT partner_id, supplier_id FROM supplier_purchase_options WHERE id=?`, [opt.id]);
      check('7: SupplierPurchaseOptionAgent resolves the same supplier_id for the "both" partner', Number(optRow.supplier_id) === Number(p3SupplierId), optRow);
      await pool.query(`DELETE FROM supplier_purchase_options WHERE id=?`, [opt.id]);
    }

    // ══════════════════ 8: flipping AWAY from supplier role does not delete historical supplier data ══════════════════
    {
      await CustomerAgent.update(p1Id, {
        name: 'SYNC TEST SUP UPDATED', phone: '0999999999', address: 'addr v2', note: 'note v2',
        billing_calendar_type: 'LUNAR', partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const sup = await supplierRow(p1SupplierId);
      check('8 (SAFETY VERIFIED): supplier row still exists after Partner flips away from Nhà cung cấp', !!sup, sup);
      check('8: supplier_partner_map row still exists (not deleted)', await mapRowCount(p1Id) === 1);
      check('8: supplier row del_flg unchanged (not soft-deleted either)', Number(sup.del_flg) === 0, sup);
    }

  } finally {
    for (const pid of poIds) {
      await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [pid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    const supplierIds = [];
    for (const pid of partnerIds) {
      const sid = await mappedSupplierId(pid).catch(() => null);
      if (sid) supplierIds.push(sid);
      await pool.query(`DELETE FROM supplier_partner_map WHERE partner_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [pid]).catch(() => {});
    }
    for (const sid of supplierIds) {
      await pool.query(`DELETE FROM suppliers WHERE id=?`, [sid]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function makeProduct() {
  const name = `SYNC TEST PRODUCT ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 0, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
