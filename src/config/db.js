const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ticket_service',
  max: 50, // connection pool limit
});

async function initDb() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  console.log(JSON.stringify({ msg: 'Database initialized', event: 'db_init' }));
}

module.exports = { pool, initDb };
