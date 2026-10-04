const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function initDb() {
  // Prisma will connect automatically. We don't need to run schema.sql anymore, 
  // as the db is already created, but if it wasn't, Prisma Migrate would handle it.
  console.log(JSON.stringify({ msg: 'Database initialized via Prisma', event: 'db_init' }));
}

module.exports = { prisma, initDb };
