function todayCompact() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

async function nextCode(conn, table, field, prefix) {
  const like = `${prefix}${todayCompact()}%`;
  const [rows] = await conn.query(
    `SELECT ${field} AS code FROM ${table} WHERE ${field} LIKE ? ORDER BY id DESC LIMIT 1`,
    [like]
  );
  let n = 1;
  if (rows.length) {
    const last = Number(String(rows[0].code).slice(-4));
    if (!Number.isNaN(last)) n = last + 1;
  }
  return `${prefix}${todayCompact()}${String(n).padStart(4,'0')}`;
}

module.exports = { nextCode };
