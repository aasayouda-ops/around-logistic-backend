import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './pool.js';

const __dir = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');
    const sql = readFileSync(join(__dir, 'schema.sql'), 'utf8');
    await client.query(sql);
    console.log('✅ Database schema applied successfully');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
