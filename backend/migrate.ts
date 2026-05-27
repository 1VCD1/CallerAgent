import { db } from './src/db/client';

async function migrate() {
  await db.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'`);
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS human_confidence FLOAT DEFAULT 0`);
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS user_phone_number TEXT`);
  await db.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS human_confidence FLOAT`);
  console.log('Migration complete');
  await db.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
