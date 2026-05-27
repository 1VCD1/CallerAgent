import { db } from './src/db/client';

async function migrate() {
  // HNSW index for fast cosine similarity search on memory embeddings
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_patterns_embedding
    ON memory_patterns USING hnsw (strategy_embedding vector_cosine_ops)
  `);

  console.log('Migration 5 complete');
  await db.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
