import { db } from './src/db/client';

async function migrate() {
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_sid TEXT`);
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT`);
  console.log('Migration 3 complete');
  await db.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
