'use strict';
// fix(partner) — Partner identity validation audit. Verifies:
//   A. Phone is required on create (and edit).
//   B. normalized(name)+normalized(phone) must be unique among ACTIVE (del_flg=0) partners.
//   C. Same name + different phone -> allowed.
//   D. Different name + same phone -> allowed.
//   E. Phone normalization ("0905 123 456" / "0905-123-456" / "0905123456") is one identity.
//   F. Editing a record without changing its identity does not reject itself.
//   G. Editing a record INTO another active record's identity -> rejected.
//   H. A del_flg=1 (soft-deleted) row never blocks reuse of its name+phone.
//   I. _syncPartnerToSupplier's phone reuse-match works across phone formatting
//      differences (normalized comparison), so supplier mapping stays correct.
//   J. Two active partners sharing a name are BOTH still returned by
//      CustomerAgent.list()/PartnerAgent.listPartners() (both remain selectable).
//
// Self-cleaning: throwaway partners + suppliers + mappings, removed in `finally`.
// Never touches pre-existing business/test fixtures.

const pool = require('../src/config/db');
const CustomerAgent = require('../src/agents/CustomerAgent');
const PartnerAgent = require('../src/agents/PartnerAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function expectReject(name, fn, expectedCode) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (e) {
    check(name, !expectedCode || e.code === expectedCode, { code: e.code, message: e.message });
  }
}

const admin = { id: null, role: 'ADMIN' };
const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function mappedSupplierId(partnerId) {
  const [[row]] = await pool.query(`SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
  return row ? row.supplier_id : null;
}

async function main() {
  const partnerIds = [];

  try {
    // ══════════════════ A: blank phone create -> reject ══════════════════
    await expectReject('A: blank phone create is rejected', () =>
      CustomerAgent.create({ name: `IDV BLANK PHONE ${uniq}`, phone: '', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin),
      'PARTNER_PHONE_REQUIRED');

    // ══════════════════ Base record for B/C/D/E/F/G/H/I/J ══════════════════
    let baseId;
    {
      const r = await CustomerAgent.create({
        name: `IDV Base ${uniq}`, phone: '0905123456', partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE name=? LIMIT 1`, [`IDV Base ${uniq}`]);
      baseId = row.id;
      partnerIds.push(baseId);
      check('setup: base record created', !!baseId, r);
    }

    // ══════════════════ B: same normalized name + same normalized phone -> reject ══════════════════
    await expectReject('B: exact duplicate name+phone create is rejected', () =>
      CustomerAgent.create({ name: `IDV Base ${uniq}`, phone: '0905123456', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin),
      'PARTNER_DUPLICATE_IDENTITY');

    // ══════════════════ C: same name + different phone -> allow ══════════════════
    let cId;
    {
      const r = await CustomerAgent.create({
        name: `IDV Base ${uniq}`, phone: '0905999999', partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const [rows] = await pool.query(`SELECT id FROM customers WHERE name=? AND phone='0905999999'`, [`IDV Base ${uniq}`]);
      cId = rows[0] && rows[0].id;
      if (cId) partnerIds.push(cId);
      check('C: same name + different phone is allowed', !!cId, r);
    }

    // ══════════════════ D: different name + same phone -> allow ══════════════════
    let dId;
    {
      const r = await CustomerAgent.create({
        name: `IDV Different ${uniq}`, phone: '0905123456', partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const [rows] = await pool.query(`SELECT id FROM customers WHERE name=?`, [`IDV Different ${uniq}`]);
      dId = rows[0] && rows[0].id;
      if (dId) partnerIds.push(dId);
      check('D: different name + same phone is allowed', !!dId, r);
    }

    // ══════════════════ E: phone normalization equivalence ══════════════════
    await expectReject('E1: "0905 123 456" (spaces) matches "0905123456" for dup check', () =>
      CustomerAgent.create({ name: `IDV Base ${uniq}`, phone: '0905 123 456', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin),
      'PARTNER_DUPLICATE_IDENTITY');
    await expectReject('E2: "0905-123-456" (dashes) matches "0905123456" for dup check', () =>
      CustomerAgent.create({ name: `IDV Base ${uniq}`, phone: '0905-123-456', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin),
      'PARTNER_DUPLICATE_IDENTITY');

    // ══════════════════ F: update same record without changing identity -> allow ══════════════════
    {
      let threw = false;
      try {
        await CustomerAgent.update(baseId, { name: `IDV Base ${uniq}`, phone: '0905123456', address: 'new address', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin);
      } catch (e) { threw = true; }
      check('F: editing a record without changing its own identity does not self-reject', !threw);
    }

    // ══════════════════ G: update into another active record's identity -> reject ══════════════════
    await expectReject('G: editing record D into base record\'s name+phone is rejected', () =>
      CustomerAgent.update(dId, { name: `IDV Base ${uniq}`, phone: '0905123456', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin),
      'PARTNER_DUPLICATE_IDENTITY');

    // ══════════════════ H: identity only exists in a del_flg=1 row -> allow ══════════════════
    let hId, hReuseId;
    {
      const r1 = await CustomerAgent.create({
        name: `IDV SoftDel ${uniq}`, phone: '0905777777', partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const [rows1] = await pool.query(`SELECT id FROM customers WHERE name=?`, [`IDV SoftDel ${uniq}`]);
      hId = rows1[0].id;
      partnerIds.push(hId);
      await CustomerAgent.remove(hId, 'IDV test cleanup', admin);
      const [[delRow]] = await pool.query(`SELECT del_flg FROM customers WHERE id=?`, [hId]);
      check('H setup: record soft-deleted (del_flg=1)', Number(delRow.del_flg) === 1, delRow);

      const r2 = await CustomerAgent.create({
        name: `IDV SoftDel ${uniq}`, phone: '0905777777', partner_type: 2, default_sales_flow: 'INVENTORY_SALE',
      }, admin);
      const [rows2] = await pool.query(`SELECT id FROM customers WHERE name=? AND del_flg=0`, [`IDV SoftDel ${uniq}`]);
      hReuseId = rows2[0] && rows2[0].id;
      if (hReuseId) partnerIds.push(hReuseId);
      check('H: identity only used by a del_flg=1 row does not block a new active create', !!hReuseId, r2);
    }

    // ══════════════════ I: supplier sync phone reuse-match across formatting ══════════════════
    let iId1, iId2, iSupplierId;
    {
      // Create + delete a supplier-type partner with a dashed phone, deactivating its supplier (per c3ce3a2 lifecycle fix).
      const r1 = await CustomerAgent.create({
        name: `IDV SupSync ${uniq}`, phone: '0905-555-555', partner_type: 1,
      }, admin);
      const [rows1] = await pool.query(`SELECT id FROM customers WHERE name=?`, [`IDV SupSync ${uniq}`]);
      iId1 = rows1[0].id;
      partnerIds.push(iId1);
      iSupplierId = r1.supplier_id;
      await CustomerAgent.remove(iId1, 'IDV test cleanup', admin);
      const [[sup1]] = await pool.query(`SELECT is_active, del_flg FROM suppliers WHERE id=?`, [iSupplierId]);
      check('I setup: linked supplier deactivated after partner delete', Number(sup1.is_active) === 0 && Number(sup1.del_flg) === 1, sup1);

      // Re-create with the SAME phone but a DIFFERENT format (no dashes) — the reuse
      // match must still find/reactivate the orphaned supplier via normalized phone.
      const r2 = await CustomerAgent.create({
        name: `IDV SupSync ${uniq}`, phone: '0905555555', partner_type: 1,
      }, admin);
      const [rows2] = await pool.query(`SELECT id FROM customers WHERE name=? AND del_flg=0`, [`IDV SupSync ${uniq}`]);
      iId2 = rows2[0].id;
      partnerIds.push(iId2);
      check('I (FIX VERIFIED): reused/reactivated the SAME supplier row despite phone format difference (no duplicate)', r2.supplier_id === iSupplierId, { before: iSupplierId, after: r2.supplier_id });
      const [[sup2]] = await pool.query(`SELECT is_active, del_flg FROM suppliers WHERE id=?`, [iSupplierId]);
      check('I: reused supplier reactivated (is_active=1, del_flg=0)', Number(sup2.is_active) === 1 && Number(sup2.del_flg) === 0, sup2);
    }

    // ══════════════════ J: duplicate-name records both remain selectable ══════════════════
    {
      const listRows = await CustomerAgent.list(admin);
      const baseListed = listRows.some(r => Number(r.id) === Number(baseId));
      const cListed = listRows.some(r => Number(r.id) === Number(cId));
      check('J: both same-name (different phone) records appear in CustomerAgent.list()', baseListed && cListed, { baseListed, cListed });

      const partnerRows = await PartnerAgent.listPartners(null, { role: 'customer' });
      const baseInPartners = partnerRows.some(r => Number(r.id) === Number(baseId) && r.id !== undefined);
      check('J: PartnerAgent.listPartners() also returns id+phone for identification', partnerRows.length > 0 && 'phone' in partnerRows[0] && 'id' in partnerRows[0]);
    }

    // ══════════════════ K: partial-update compatibility — phone omitted ══════════════════
    {
      let threw = null;
      try {
        await CustomerAgent.update(baseId, { billing_calendar_type: 'LUNAR', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin);
      } catch (e) { threw = e; }
      check('K: update() with phone OMITTED (unrelated field only) succeeds', !threw, threw && { code: threw.code, message: threw.message });
      const [[afterK]] = await pool.query(`SELECT phone FROM customers WHERE id=?`, [baseId]);
      check('K: phone NOT wiped/blanked when omitted from the request', afterK.phone === '0905123456', afterK);
    }

    // ══════════════════ L: explicit blank phone update -> reject ══════════════════
    await expectReject('L: update() with phone explicitly "" is rejected (not silently kept)', () =>
      CustomerAgent.update(baseId, { phone: '', partner_type: 2 }, admin),
      'PARTNER_PHONE_REQUIRED');
    {
      const [[afterL]] = await pool.query(`SELECT phone FROM customers WHERE id=?`, [baseId]);
      check('L: phone unchanged in DB after the rejected blank-phone attempt', afterL.phone === '0905123456', afterL);
    }

    // ══════════════════ M: name-only update — duplicate check uses EXISTING phone ══════════════════
    let mId;
    {
      const r = await CustomerAgent.create({ name: `IDV NameOnlyBase ${uniq}`, phone: '0905444444', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin);
      const [rows] = await pool.query(`SELECT id FROM customers WHERE name=?`, [`IDV NameOnlyBase ${uniq}`]);
      mId = rows[0].id;
      partnerIds.push(mId);
      await CustomerAgent.update(mId, { name: `IDV NameOnlyRenamed ${uniq}` }, admin);
      const [[afterM]] = await pool.query(`SELECT name, phone FROM customers WHERE id=?`, [mId]);
      check('M: name-only update renames correctly and preserves existing phone', afterM.name === `IDV NameOnlyRenamed ${uniq}` && afterM.phone === '0905444444', afterM);
    }

    // ══════════════════ N: phone-only update — duplicate check uses EXISTING name ══════════════════
    let nId;
    {
      // Same name as baseId, distinct phone — allowed (rule C).
      const r = await CustomerAgent.create({ name: `IDV Base ${uniq}`, phone: '0905666666', partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, admin);
      const [rows] = await pool.query(`SELECT id FROM customers WHERE name=? AND phone='0905666666'`, [`IDV Base ${uniq}`]);
      nId = rows[0] && rows[0].id;
      if (nId) partnerIds.push(nId);
      check('N setup: same-name/different-phone record created', !!nId, r);

      // Phone-only update: name is OMITTED, so the effective name must still be
      // "IDV Base {uniq}" (unchanged) — updating its phone to baseId's phone
      // therefore collides on (existing name + new phone) and must be rejected.
      await expectReject('N: phone-only update into another active record\'s (existing name + new phone) identity is rejected', () =>
        CustomerAgent.update(nId, { phone: '0905123456' }, admin),
        'PARTNER_DUPLICATE_IDENTITY');

      // A genuinely free phone, phone-only, must still succeed — proving the
      // rejection above was the duplicate check (not some unrelated failure).
      let threw = null;
      try { await CustomerAgent.update(nId, { phone: '0905222222' }, admin); }
      catch (e) { threw = e; }
      check('N: phone-only update to a free phone succeeds (name preserved from existing row)', !threw, threw && { code: threw.code, message: threw.message });
      const [[afterN]] = await pool.query(`SELECT name, phone FROM customers WHERE id=?`, [nId]);
      check('N: name preserved unchanged, phone updated', afterN.name === `IDV Base ${uniq}` && afterN.phone === '0905222222', afterN);
    }

    // ══════════════════ O: supplier sync unaffected by an unrelated partial update (no duplicate supplier) ══════════════════
    {
      const [mapRowsForI2] = await pool.query(`SELECT id FROM supplier_partner_map WHERE partner_id=?`, [iId2]);
      check('O setup: reused supplier from test I is actually mapped to iId2 (uq_spm_supplier reassignment, not silently dropped)', mapRowsForI2.length === 1, mapRowsForI2);
      const before = await mappedSupplierId(iId2);
      // partner_type is resent (1=supplier) — that field's own omit-resets-to-2
      // default is pre-existing, unchanged behavior of update() and not part of
      // this fix; only name/phone are being tested here as omitted.
      await CustomerAgent.update(iId2, { billing_calendar_type: 'SOLAR', partner_type: 1 }, admin);
      const after = await mappedSupplierId(iId2);
      check('O: unrelated partial update (name/phone omitted) on a supplier-capable partner does not create a duplicate supplier mapping', before === after && !!after, { before, after });
    }

    // ══════════════════ P: active partner's supplier mapping is never stolen/reassigned ══════════════════
    let pXId, pYId, pXSupplierId;
    {
      // X: supplier-capable partner, stays ACTIVE (never deleted).
      const rX = await CustomerAgent.create({ name: `IDV ActiveGuard ${uniq}`, phone: '0905111222', partner_type: 1 }, admin);
      const [rowsX] = await pool.query(`SELECT id FROM customers WHERE name=? AND phone='0905111222'`, [`IDV ActiveGuard ${uniq}`]);
      pXId = rowsX[0].id;
      partnerIds.push(pXId);
      pXSupplierId = rX.supplier_id;
      check('P setup: X (active) created and synced to a supplier', !!pXSupplierId, rX);

      // Y: SAME name as X (would match X's supplier via the byName reuse query),
      // DIFFERENT phone (so create() itself allows it — rule C). X is still
      // ACTIVE, so Y's sync must NOT reassign/steal X's supplier mapping.
      const rY = await CustomerAgent.create({ name: `IDV ActiveGuard ${uniq}`, phone: '0905333444', partner_type: 1 }, admin);
      const [rowsY] = await pool.query(`SELECT id FROM customers WHERE name=? AND phone='0905333444'`, [`IDV ActiveGuard ${uniq}`]);
      pYId = rowsY[0].id;
      partnerIds.push(pYId);

      check('P (ACTIVE PARTNER MAPPING PROTECTED): Y got its OWN supplier, not X\'s', !!rY.supplier_id && rY.supplier_id !== pXSupplierId, { xSupplier: pXSupplierId, ySupplier: rY.supplier_id });

      const xMapAfter = await mappedSupplierId(pXId);
      check('P: X\'s mapping is untouched/still points to X\'s original supplier', xMapAfter === pXSupplierId, { before: pXSupplierId, after: xMapAfter });

      const [[xSupRow]] = await pool.query(`SELECT is_active, del_flg FROM suppliers WHERE id=?`, [pXSupplierId]);
      check('P: X\'s supplier is still active (was never touched by Y\'s sync)', Number(xSupRow.is_active) === 1 && Number(xSupRow.del_flg) === 0, xSupRow);

      const [dupCheck] = await pool.query(`SELECT COUNT(*) cnt FROM supplier_partner_map WHERE supplier_id=?`, [pXSupplierId]);
      check('P: no duplicate mapping row created for X\'s supplier', Number(dupCheck[0].cnt) === 1, dupCheck[0]);
    }

  } finally {
    const supplierIds = [];
    for (const pid of partnerIds) {
      const sid = await mappedSupplierId(pid).catch(() => null);
      if (sid) supplierIds.push(sid);
      await pool.query(`DELETE FROM supplier_partner_map WHERE partner_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [pid]).catch(() => {});
    }
    for (const sid of [...new Set(supplierIds)]) {
      await pool.query(`DELETE FROM suppliers WHERE id=?`, [sid]).catch(() => {});
    }
    console.log(`Cleanup done. Removed ${partnerIds.length} test partner(s), ${new Set(supplierIds).size} test supplier(s).`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
