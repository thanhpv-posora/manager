const mysql = require('mysql2/promise');
require('dotenv').config();
const { resolveDbConfig } = require('./dbConfig');

// CR-3: the connection settings no longer fall back to root@127.0.0.1 with an
// empty password in production — see dbConfig.js. createPool() does not open a
// socket, so nothing connects here; startupValidator.validateStartupConfig()
// runs before ensureSchema() and app.listen() and fails the boot closed when a
// required DB_* variable is missing in production.
const pool = mysql.createPool(resolveDbConfig());

module.exports = pool;
