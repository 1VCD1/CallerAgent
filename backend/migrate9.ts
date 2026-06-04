import { db } from './src/db/client';

async function migrate() {
  await db.query(`
    ALTER TABLE test_results ALTER COLUMN passed DROP NOT NULL;
  `);
  console.log('migrate9: test_results.passed now nullable (NULL = neutral/uncontrollable outcome)');
  await db.end();
}

migrate().catch(err => { console.error(err); process.exit(1); });
