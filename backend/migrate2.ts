import { db } from './src/db/client';

async function migrate() {
  // #3: ended_reason for clear call termination tracking
  await db.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS ended_reason TEXT`);

  // #1: success column default fix
  await db.query(`ALTER TABLE action_history ALTER COLUMN success SET DEFAULT true`);

  // #2: company IVR notes for post-call learning
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_ivr_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ivr_notes_company ON company_ivr_notes(company)`);

  console.log('Migration 2 complete');
  await db.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
