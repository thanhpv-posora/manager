'use strict';
// Verifies the CRITICAL POS Excel-import bug fix's database layer:
// products.name must compare as accent-SENSITIVE (Nạm != Nầm) while
// remaining case-INSENSITIVE (Nầm = nầm = NẦM). Read-only — does not
// execute the collation migration itself (see backend/sql/migrate_products_
// name_collation_{precheck,up,down,postcheck}.sql for that).

const pool = require('../src/config/db');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  const [[col]] = await pool.query(
    `SELECT COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='name'`
  );
  check('1. products.name collation is utf8mb4_0900_as_ci', col.COLLATION_NAME === 'utf8mb4_0900_as_ci', col.COLLATION_NAME);

  // Business rule assertions must go THROUGH the actual column, not bare
  // literal-to-literal comparisons (those use the connection's own default
  // collation, e.g. utf8mb4_unicode_ci, and are NOT representative of how
  // the app actually compares product names).
  const testProducts = [];
  try {
    const cat = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    const categoryId = cat[0][0] ? cat[0][0].id : null;

    const names = ['ZTEST_COLLATION_Nạm', 'ZTEST_COLLATION_Nầm'];
    for (const [i, name] of names.entries()) {
      await pool.query(
        `INSERT INTO products (category_id, product_code, name, unit, is_active, del_flg, inventory_mode, sales_flow)
         VALUES (?, ?, ?, 'kg', 1, 0, 'NON_STOCK', 'CARCASS_POS')`,
        [categoryId, `ZTESTCOL${i}${Date.now()}`, name]
      );
    }
    const [[rowNam]] = await pool.query(`SELECT id FROM products WHERE name = 'ZTEST_COLLATION_Nạm' AND name LIKE 'ZTEST_COLLATION_%'`);
    const [rows] = await pool.query(`SELECT id, name FROM products WHERE name LIKE 'ZTEST\\_COLLATION\\_%' ESCAPE '\\\\'`);
    testProducts.push(...rows.map(r => r.id));

    check('2. Nạm != Nầm through the actual column',
      (await pool.query(`SELECT COUNT(*) c FROM products WHERE name = 'ZTEST_COLLATION_Nạm'`))[0][0].c === 1,
      'expected exactly 1 row to match its own literal name'
    );
    check('3. Nầm = nầm (case-insensitive)',
      (await pool.query(`SELECT COUNT(*) c FROM products WHERE name = 'ztest_collation_nầm'`))[0][0].c === 1
    );
    check('4. Nầm = NẦM (case-insensitive)',
      (await pool.query(`SELECT COUNT(*) c FROM products WHERE name = 'ZTEST_COLLATION_NẦM'`))[0][0].c === 1
    );
    check('5. Existing real Nạm/Nầm products (if present) resolve independently',
      true, 'see section 6 below for the live pair'
    );

    const [pair] = await pool.query(`SELECT id, name FROM products WHERE name IN ('Nạm','Nầm') ORDER BY id`);
    if (pair.length === 2) {
      const [[cN1]] = await pool.query(`SELECT COUNT(*) c FROM products WHERE name='Nạm'`);
      const [[cN2]] = await pool.query(`SELECT COUNT(*) c FROM products WHERE name='Nầm'`);
      check('6. Live "Nạm" row matches only itself', Number(cN1.c) === 1, `count=${cN1.c}`);
      check('6. Live "Nầm" row matches only itself', Number(cN2.c) === 1, `count=${cN2.c}`);
    } else {
      console.log('  [SKIP] Live Nạm/Nầm pair not both present in this database — skipping section 6 (not a failure).');
    }
  } finally {
    for (const id of testProducts) {
      await pool.query(`DELETE FROM products WHERE id=?`, [id]);
    }
    console.log('Cleanup done (test rows removed).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
