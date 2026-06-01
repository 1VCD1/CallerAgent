import { db } from './src/db/client';

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ivr_decision_nodes (
      id            BIGSERIAL PRIMARY KEY,
      company       TEXT NOT NULL,
      ivr_text      TEXT NOT NULL,
      ai_action     TEXT NOT NULL,
      ai_value      TEXT NOT NULL DEFAULT '',
      calls_success INT  NOT NULL DEFAULT 0,
      calls_total   INT  NOT NULL DEFAULT 0,
      last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (company, ivr_text, ai_action, ai_value)
    );
    CREATE INDEX IF NOT EXISTS idx_ivr_nodes_company ON ivr_decision_nodes (company, ivr_text);
  `);
  console.log('migrate7: ivr_decision_nodes created');
  await db.end();
}

migrate().catch(err => { console.error(err); process.exit(1); });
