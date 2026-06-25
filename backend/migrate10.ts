import { db } from './src/db/client';

async function migrate() {
  // Per-node rolling outcome log: capped array of {t: ISO timestamp, s: 0|1}.
  // Lets us compute a recent (e.g. 7-day) success rate to recover AVOID nodes when an
  // IVR menu changes, without storing one row per call. Trimmed to last 20 on write.
  await db.query(`
    ALTER TABLE ivr_decision_nodes
      ADD COLUMN IF NOT EXISTS recent_outcomes JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
  console.log('migrate10: ivr_decision_nodes.recent_outcomes added');
  await db.end();
}

migrate().catch(err => { console.error(err); process.exit(1); });
