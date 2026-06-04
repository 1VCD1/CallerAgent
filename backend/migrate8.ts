import { db } from './src/db/client';

async function migrate() {
  await db.query(`
    ALTER TABLE test_results ADD COLUMN IF NOT EXISTS human_appeared_in_ivr BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('migrate8: human_appeared_in_ivr column added to test_results');
  await db.end();
}

migrate().catch(err => { console.error(err); process.exit(1); });
