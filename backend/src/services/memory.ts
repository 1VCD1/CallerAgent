import OpenAI from 'openai';
import { query, queryOne } from '../db/client';
import { MemoryPattern, ActionRecord } from '../types';
import { config } from '../config';

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

async function generateEmbedding(company: string, goal: string): Promise<number[] | null> {
  if (!openai) return null;
  try {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: `company: ${company} | goal: ${goal}`,
    });
    return res.data[0].embedding;
  } catch (err) {
    console.error('[Memory] Embedding generation failed:', err);
    return null;
  }
}

export async function getMemoryPatterns(company: string, goal: string): Promise<MemoryPattern[]> {
  // Primary: exact company + goal match
  const exact = await query<{
    id: string; company: string; goal: string; path: string[];
    success_rate: number; sample_count: number; avg_wait_seconds: number; last_verified_at: Date;
  }>(
    `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
            (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
     FROM memory_patterns
     WHERE LOWER(company) = LOWER($1) AND LOWER(goal) = LOWER($2)
     ORDER BY strategy_score DESC, sample_count DESC
     LIMIT 5`,
    [company, goal]
  );

  if (exact.length >= 3) return exact.map(toMemoryPattern);

  // Fallback: semantic similarity search using pgvector
  const embedding = await generateEmbedding(company, goal);
  if (!embedding) return exact.map(toMemoryPattern);

  const semantic = await query<{
    id: string; company: string; goal: string; path: string[];
    success_rate: number; sample_count: number; avg_wait_seconds: number;
    last_verified_at: Date; distance: number;
  }>(
    `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
            (strategy_embedding <=> $1::vector) AS distance,
            (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
     FROM memory_patterns
     WHERE strategy_embedding IS NOT NULL
       AND id != ALL($2::uuid[])
     ORDER BY distance ASC, strategy_score DESC
     LIMIT $3`,
    [
      `[${embedding.join(',')}]`,
      exact.map(r => r.id),
      5 - exact.length,
    ]
  );

  const combined = [...exact.map(toMemoryPattern), ...semantic.map(toMemoryPattern)];
  console.log(`[Memory] ${exact.length} exact + ${semantic.length} semantic matches for "${company}"`);
  return combined;
}

export async function recordCallOutcome(params: {
  callId: string;
  company: string;
  goal: string;
  humanReached: boolean;
  waitDurationSeconds?: number;
}): Promise<void> {
  const actions = await query<{ action: string; value: string; success: boolean }>(
    `SELECT action, value, success FROM action_history WHERE call_id = $1 ORDER BY timestamp ASC`,
    [params.callId]
  );

  if (actions.length === 0) return;

  const path = actions.filter((a) => a.success).map((a) => formatPathStep(a.action, a.value));
  if (path.length === 0) return;

  const pathKey = JSON.stringify(path);
  const existing = await queryOne<{ id: string; sample_count: number; success_rate: number }>(
    `SELECT id, sample_count, success_rate FROM memory_patterns
     WHERE company = $1 AND goal = $2 AND path::text = $3`,
    [params.company, params.goal, pathKey]
  );

  const embedding = await generateEmbedding(params.company, params.goal);
  const embeddingLiteral = embedding ? `[${embedding.join(',')}]` : null;

  if (existing) {
    const newCount = existing.sample_count + 1;
    const successDelta = params.humanReached ? 1 : 0;
    const newSuccessRate = (existing.success_rate * existing.sample_count + successDelta) / newCount;

    await query(
      `UPDATE memory_patterns
       SET success_rate = $1,
           sample_count = $2,
           avg_wait_seconds = CASE WHEN $3::INTEGER IS NOT NULL
             THEN (COALESCE(avg_wait_seconds, 0) + $3::INTEGER) / 2
             ELSE avg_wait_seconds END,
           strategy_embedding = COALESCE($5::vector, strategy_embedding),
           last_verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [newSuccessRate, newCount, params.waitDurationSeconds ?? null, existing.id, embeddingLiteral]
    );
  } else {
    await query(
      `INSERT INTO memory_patterns (company, goal, path, success_rate, sample_count, avg_wait_seconds, strategy_embedding, last_verified_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6::vector, NOW())`,
      [
        params.company,
        params.goal,
        pathKey,
        params.humanReached ? 1.0 : 0.0,
        params.waitDurationSeconds ?? null,
        embeddingLiteral,
      ]
    );
  }
}

export interface ActionPattern {
  action: string;
  value: string | null;
  total: number;
  successPct: number;
}

export async function getActionPatterns(company: string): Promise<ActionPattern[]> {
  const rows = await query<{
    action: string; value: string | null;
    total: string; success_pct: string;
  }>(
    `SELECT ah.action, ah.value,
            COUNT(*) AS total,
            ROUND(AVG(CASE WHEN ah.success THEN 1 ELSE 0 END) * 100) AS success_pct
     FROM action_history ah
     JOIN calls c ON c.id = ah.call_id
     WHERE LOWER(c.company) = LOWER($1)
     GROUP BY ah.action, ah.value
     HAVING COUNT(*) >= 2
     ORDER BY total DESC
     LIMIT 15`,
    [company]
  );

  return rows.map(r => ({
    action: r.action,
    value: r.value,
    total: parseInt(r.total, 10),
    successPct: parseInt(r.success_pct, 10),
  }));
}

export async function markActionSuccess(
  callId: string,
  action: string,
  success: boolean
): Promise<void> {
  await query(
    `UPDATE action_history SET success = $1 WHERE call_id = $2 AND action = $3
     AND id = (SELECT id FROM action_history WHERE call_id = $2 AND action = $3 ORDER BY timestamp DESC LIMIT 1)`,
    [success, callId, action]
  );
}

function toMemoryPattern(r: any): MemoryPattern {
  return {
    id: r.id,
    company: r.company,
    goal: r.goal,
    path: r.path,
    successRate: r.success_rate,
    avgWaitSeconds: r.avg_wait_seconds,
    strategyScore: parseFloat(r.strategy_score ?? '0'),
    lastVerifiedAt: r.last_verified_at,
  };
}

function formatPathStep(action: string, value: string): string {
  if (action === 'press_key') return `press ${value}`;
  if (action === 'say_phrase') return `say "${value}"`;
  if (action === 'wait') return `wait ${value}s`;
  return action;
}
