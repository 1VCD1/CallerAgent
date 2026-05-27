import { db } from './src/db/client';

async function migrate() {
  // users: email is optional (phone-only signup), add profile fields
  await db.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'`);

  // calls: confidence score + user phone for bridge
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS human_confidence FLOAT`);
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS user_phone_number TEXT`);

  // transcripts: per-utterance human confidence score
  await db.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS human_confidence FLOAT`);

  console.log('Migration 4 complete');
  await db.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
