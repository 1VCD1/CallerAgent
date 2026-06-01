import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://postgres:ipFYqAMiWFsiyYHezkxXEkpxWupVfCkF@zephyr.proxy.rlwy.net:25776/railway' });
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
