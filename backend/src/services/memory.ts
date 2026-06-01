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

export interface IvrDecisionNode {
  ivrText: string;
  action: string;
  value: string;
  callsSuccess: number;
  callsTotal: number;
  successPct: number;
}

function normalizeIvr(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export async function recordIvrDecisionNodes(params: {
  callId: string;
  company: string;
  humanReached: boolean;
  endedReason: string | null;
}): Promise<void> {
  const decisions = await query<{ data: Record<string, any> }>(
    `SELECT data FROM call_debug_logs WHERE call_id = $1 AND event_type = 'llm_decision' ORDER BY timestamp`,
    [params.callId]
  );
  if (decisions.length === 0) return;

  const success = params.humanReached ||
    ['callback_number_given', 'callback_offered'].includes(params.endedReason ?? '');
  const successDelta = success ? 1 : 0;

  for (const { data } of decisions) {
    if (!data.ivr_utterance || !data.action) continue;
    const ivrKey = normalizeIvr(data.ivr_utterance);
    const aiValue = data.value ?? '';

    await query(
      `INSERT INTO ivr_decision_nodes
         (company, ivr_text, ai_action, ai_value, calls_success, calls_total)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (company, ivr_text, ai_action, ai_value)
       DO UPDATE SET
         calls_success = ivr_decision_nodes.calls_success + $5,
         calls_total   = ivr_decision_nodes.calls_total   + 1,
         last_seen_at  = NOW()`,
      [params.company, ivrKey, data.action, aiValue, successDelta]
    );
  }
}

export async function getIvrDecisionTree(company: string): Promise<IvrDecisionNode[]> {
  const rows = await query<{
    ivr_text: string; ai_action: string; ai_value: string;
    calls_success: string; calls_total: string; success_pct: string;
  }>(
    `SELECT ivr_text, ai_action, ai_value, calls_success, calls_total,
            ROUND(calls_success::numeric / calls_total * 100) AS success_pct
     FROM ivr_decision_nodes
     WHERE LOWER(company) = LOWER($1) AND calls_total >= 2
     ORDER BY calls_total DESC, ivr_text, success_pct DESC
     LIMIT 30`,
    [company]
  );

  return rows.map(r => ({
    ivrText:      r.ivr_text,
    action:       r.ai_action,
    value:        r.ai_value,
    callsSuccess: parseInt(r.calls_success, 10),
    callsTotal:   parseInt(r.calls_total,   10),
    successPct:   parseInt(r.success_pct,   10),
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
