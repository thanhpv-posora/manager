/**
 * Verifies the supplier lot voucher is no longer addressable by row id.
 *
 * GET /api/lots/public/:id/print previously took the raw purchase_lots.id with
 * no authentication, so anyone could walk id=1,2,3... and read every lot's
 * supplier name/phone/address, purchase unit prices, total cost and outstanding
 * balance. It now takes an unguessable public_token, the same mechanism the
 * public order bill already uses (orders.private_token).
 *
 * The endpoint stays public on purpose: the printed voucher carries a QR the
 * supplier scans.
 *
 * Requires the API running on PORT (default 4000).
 *
 * Run: node scripts/verify-lot-public-print-token.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 4000);

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

const get = async (path) => {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.text() };
};

async function main() {
  console.log('=== supplier lot voucher: token-addressed, not id-addressed ===\n');

  const [lots] = await pool.query(
    `SELECT id, lot_code, public_token FROM purchase_lots WHERE del_flg=0 ORDER BY id LIMIT 5`
  );
  if (!lots.length) {
    console.log('  [SKIP] no purchase_lots rows to verify against');
    console.log('\n0 passed, 0 failed');
    await pool.end();
    process.exit(0);
  }

  console.log('-- 1. every lot has an unguessable token --');
  const [missing] = await pool.query(
    `SELECT COUNT(*) cnt FROM purchase_lots WHERE del_flg=0 AND (public_token IS NULL OR public_token='')`
  );
  ok(Number(missing[0].cnt) === 0, 'no lot is left without a public_token (backfill applied)', missing[0]);
  for (const l of lots) {
    ok(!!l.public_token && String(l.public_token).length >= 20,
      `lot ${l.id} token is long enough to be unguessable (${String(l.public_token || '').length} chars)`);
    ok(String(l.public_token) !== String(l.id), `lot ${l.id} token is not the row id`);
  }

  const [dupes] = await pool.query(
    `SELECT COUNT(*) cnt FROM (SELECT public_token FROM purchase_lots WHERE public_token IS NOT NULL
      GROUP BY public_token HAVING COUNT(*)>1) d`
  );
  ok(Number(dupes[0].cnt) === 0, 'tokens are unique across all lots', dupes[0]);

  console.log('\n-- 2. the old id-addressed URL no longer serves lot data --');
  for (const id of [1, 2, 3]) {
    const r = await get(`/api/lots/public/${id}/print`);
    const leaks = /Nhà cung cấp|Đơn giá|Thành tiền/.test(r.body);
    ok(!leaks, `/public/${id}/print does not return voucher content by row id`, r.status);
  }

  console.log('\n-- 3. the token URL still works (QR workflow preserved) --');
  {
    const target = lots[0];
    const r = await get(`/api/lots/public/${target.public_token}/print`);
    ok(r.status === 200, 'valid token -> 200', r.status);
    ok(r.body.includes(target.lot_code), 'renders the correct lot voucher', target.lot_code);
    ok(/Nhà cung cấp/.test(r.body), 'voucher content is present for the legitimate holder');
    // The QR is embedded as a base64 data: image, so the encoded URL is not
    // present as text in the HTML — asserting on r.body cannot see it. Check
    // how the URL is built instead, in both PrintService copies, and separately
    // assert the page leaks no id-addressed URL anywhere.
    ok(!new RegExp(`/api/lots/public/${target.id}/print`).test(r.body),
      'rendered voucher contains no id-addressed URL');
  }

  console.log('\n-- 3b. both PrintService copies build the QR URL from the token --');
  {
    const files = [
      path.resolve(__dirname, '..', 'src', 'services', 'PrintService.js'),
      path.resolve(__dirname, '..', '..', 'frontend', 'src', 'services', 'PrintService.js'),
    ];
    for (const f of files) {
      if (!fs.existsSync(f)) { console.log(`  [SKIP] ${f} not present`); continue; }
      const src = fs.readFileSync(f, 'utf8');
      const label = f.includes('frontend') ? 'frontend' : 'backend';
      ok(/lots\/public\/\$\{lot\.public_token\}\/print/.test(src),
        `${label} PrintService builds the QR URL from lot.public_token`);
      ok(!/lots\/public\/\$\{lot\.id\}\/print/.test(src),
        `${label} PrintService no longer uses lot.id in the QR URL`);
    }
  }

  console.log('\n-- 4. wrong / guessed tokens are rejected --');
  for (const bad of ['0000000000000000000000', 'not-a-real-token', '1', '']) {
    const r = await get(`/api/lots/public/${encodeURIComponent(bad)}/print`);
    const leaks = /Nhà cung cấp|Đơn giá|Thành tiền/.test(r.body);
    ok(!leaks, `token "${bad || '(empty)'}" returns no voucher content`, r.status);
  }

  console.log('\n-- 5. a soft-deleted lot is not reachable by its token --');
  {
    const [[victim]] = await pool.query(
      `SELECT id, public_token FROM purchase_lots WHERE del_flg=0 ORDER BY id LIMIT 1`
    );
    await pool.query(`UPDATE purchase_lots SET del_flg=1 WHERE id=?`, [victim.id]);
    try {
      const r = await get(`/api/lots/public/${victim.public_token}/print`);
      const leaks = /Nhà cung cấp|Đơn giá|Thành tiền/.test(r.body);
      ok(!leaks, 'soft-deleted lot returns no voucher content', r.status);
    } finally {
      await pool.query(`UPDATE purchase_lots SET del_flg=0 WHERE id=?`, [victim.id]);
    }
    const [[restored]] = await pool.query(`SELECT del_flg FROM purchase_lots WHERE id=?`, [victim.id]);
    ok(Number(restored.del_flg) === 0, 'test lot restored to del_flg=0 (no residue)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch {} process.exit(1); });
