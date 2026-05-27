import { query } from './src/db/client';

async function main() {
  const result = await query(
    `INSERT INTO users (email) VALUES ('test@test.com') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`
  );
  console.log('User ID:', result[0]?.id);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
