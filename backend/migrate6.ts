import { db } from './src/db/client';

async function migrate() {
  // users: push token for FCM/Expo notifications
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT`);

  // calls: outcome fields added after initial schema
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS ended_reason TEXT`);
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_sid TEXT`);
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT`);

  // company_ivr_notes: post-call LLM summaries per company
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_ivr_notes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      company TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ivr_notes_company ON company_ivr_notes(company)
  `);

  console.log('Migration 6 complete');
  await db.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
