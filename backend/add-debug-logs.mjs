import pg from 'pg';
import { config } from 'dotenv';
config();

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(`
  CREATE TABLE IF NOT EXISTS call_debug_logs (
    id          BIGSERIAL PRIMARY KEY,
    call_id     UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    timestamp   TIMESTAMPTZ DEFAULT NOW(),
    event_type  VARCHAR(40) NOT NULL,
    data        JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_call_debug_logs_call_id ON call_debug_logs (call_id, timestamp);
`);
console.log('Done: call_debug_logs table created');
await client.end();
