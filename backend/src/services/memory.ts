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

export async function getMemoryPatterns(company: string, goal: string, phoneNumber?: string): Promise<MemoryPattern[]> {
  type Row = {
    id: string; company: string; goal: string; path: string[];
    success_rate: number; sample_count: number; avg_wait_seconds: number; last_verified_at: Date;
    strategy_score?: string;
  };

  // Primary: exact phone_number match (most specific — different numbers = different IVR trees)
  if (phoneNumber) {
    const byPhone = await query<Row>(
      `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
              (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
       FROM memory_patterns
       WHERE phone_number = $1 AND LOWER(goal) = LOWER($2)
       ORDER BY strategy_score DESC, sample_count DESC
       LIMIT 5`,
      [phoneNumber, goal]
    );
    if (byPhone.length >= 3) return byPhone.map(toMemoryPattern);

    // Some phone-specific patterns + fill remainder with company patterns
    const usedIds = byPhone.map(r => r.id);
    const byCompany = await query<Row>(
      `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
              (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
       FROM memory_patterns
       WHERE LOWER(company) = LOWER($1) AND LOWER(goal) = LOWER($2)
         AND id != ALL($3::uuid[])
       ORDER BY strategy_score DESC, sample_count DESC
       LIMIT $4`,
      [company, goal, usedIds, 5 - byPhone.length]
    );
    const combined = [...byPhone, ...byCompany];
    if (combined.length >= 3) {
      console.log(`[Memory] ${byPhone.length} phone-exact + ${byCompany.length} company for "${phoneNumber}"`);
      return combined.map(toMemoryPattern);
    }

    // Fall through to semantic search with remaining slots
    const embedding = await generateEmbedding(company, goal);
    if (!embedding) return combined.map(toMemoryPattern);
    const allUsed = combined.map(r => r.id);
    const semantic = await query<Row & { distance: number }>(
      `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
              (strategy_embedding <=> $1::vector) AS distance,
              (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
       FROM memory_patterns
       WHERE strategy_embedding IS NOT NULL AND id != ALL($2::uuid[])
       ORDER BY distance ASC, strategy_score DESC LIMIT $3`,
      [`[${embedding.join(',')}]`, allUsed, 5 - combined.length]
    );
    console.log(`[Memory] ${byPhone.length} phone + ${byCompany.length} company + ${semantic.length} semantic for "${phoneNumber}"`);
    return [...combined, ...semantic].map(toMemoryPattern);
  }

  // No phone number: company match + semantic search
  const exact = await query<Row>(
    `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
            (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
     FROM memory_patterns
     WHERE LOWER(company) = LOWER($1) AND LOWER(goal) = LOWER($2)
     ORDER BY strategy_score DESC, sample_count DESC
     LIMIT 5`,
    [company, goal]
  );
  if (exact.length >= 3) return exact.map(toMemoryPattern);

  const embedding = await generateEmbedding(company, goal);
  if (!embedding) return exact.map(toMemoryPattern);
  const semantic = await query<Row & { distance: number }>(
    `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at,
            (strategy_embedding <=> $1::vector) AS distance,
            (success_rate / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)) AS strategy_score
     FROM memory_patterns
     WHERE strategy_embedding IS NOT NULL AND id != ALL($2::uuid[])
     ORDER BY distance ASC, strategy_score DESC LIMIT $3`,
    [`[${embedding.join(',')}]`, exact.map(r => r.id), 5 - exact.length]
  );
  console.log(`[Memory] ${exact.length} exact + ${semantic.length} semantic for "${company}"`);
  return [...exact, ...semantic].map(toMemoryPattern);
}

export async function recordCallOutcome(params: {
  callId: string;
  company: string;
  phoneNumber: string;
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
  // Look up by phone_number (most specific key) — fall back to company for old records
  const existing = await queryOne<{ id: string; sample_count: number; success_rate: number }>(
    `SELECT id, sample_count, success_rate FROM memory_patterns
     WHERE phone_number = $1 AND goal = $2 AND path::text = $3`,
    [params.phoneNumber, params.goal, pathKey]
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
      `INSERT INTO memory_patterns (phone_number, company, goal, path, success_rate, sample_count, avg_wait_seconds, strategy_embedding, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7::vector, NOW())`,
      [
        params.phoneNumber,
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

// For DTMF menus: extract sorted (key→label) pairs as a stable fingerprint
// regardless of what's cut off at the beginning or end of the transcript.
// Returns null if fewer than 2 DTMF options are detected (not clearly a menu).
function extractDtmfFingerprint(text: string): string | null {
  const wordToDigit: Record<string, string> = {
    one:'1', two:'2', three:'3', four:'4', five:'5',
    six:'6', seven:'7', eight:'8', nine:'9', zero:'0',
  };
  // Note: input is already normalizeIvr'd — punctuation replaced with spaces.
  // Use \s{2,} (double space from comma→space) or \s+(?:press|or|and) as delimiters.
  const matches = [...text.matchAll(
    /press\s+(\d|one|two|three|four|five|six|seven|eight|nine|zero)\s+(?:for\s+)?([a-z][a-z\s]{2,25}?)(?=\s{2,}|\s+(?:press|or|and)|$)/gi
  )];
  if (matches.length < 2) return null;
  const options = matches.map(m => {
    const key   = wordToDigit[m[1].toLowerCase()] ?? m[1];
    const label = m[2].toLowerCase().trim().split(/\s+/).slice(0, 2).join('_');
    return `${key}:${label}`;
  }).sort().join('|');
  return `menu:${options}`;
}

// Jaccard word overlap: fraction of shared meaningful words (length > 3).
// Handles partial transcriptions — if one is a substring of the other, similarity is high.
function jaccardWords(a: string, b: string): number {
  const sig = (s: string) => new Set(s.split(/\s+/).filter(w => w.length > 3));
  const wA = sig(a), wB = sig(b);
  const intersection = [...wA].filter(w => wB.has(w)).length;
  const union = new Set([...wA, ...wB]).size;
  return union > 0 ? intersection / union : 0;
}

export async function recordIvrDecisionNodes(params: {
  callId: string;
  company: string;
  phoneNumber: string;
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

  // Fetch existing nodes keyed by phone_number for similarity matching
  const existingNodes = await query<{ ivr_text: string; ai_action: string; ai_value: string }>(
    `SELECT ivr_text, ai_action, ai_value FROM ivr_decision_nodes WHERE phone_number = $1`,
    [params.phoneNumber]
  );

  for (const { data } of decisions) {
    if (!data.ivr_utterance || !data.action) continue;

    const normalized = normalizeIvr(data.ivr_utterance);
    const aiValue    = data.value ?? '';

    const dtmfKey = extractDtmfFingerprint(normalized);
    let ivrKey: string;
    if (dtmfKey) {
      ivrKey = dtmfKey;
    } else {
      const candidates = existingNodes.filter(
        n => n.ai_action === data.action && n.ai_value === aiValue
      );
      const best = candidates
        .map(n => ({ text: n.ivr_text, sim: jaccardWords(normalized, n.ivr_text) }))
        .filter(n => n.sim > 0.55)
        .sort((a, b) => b.sim - a.sim)[0];
      ivrKey = best ? best.text : normalized;
    }

    await query(
      `INSERT INTO ivr_decision_nodes
         (phone_number, company, ivr_text, ai_action, ai_value, calls_success, calls_total)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT (phone_number, ivr_text, ai_action, ai_value)
       DO UPDATE SET
         calls_success = ivr_decision_nodes.calls_success + $6,
         calls_total   = ivr_decision_nodes.calls_total   + 1,
         last_seen_at  = NOW()`,
      [params.phoneNumber, params.company, ivrKey, data.action, aiValue, successDelta]
    );
  }
}

export async function getIvrDecisionTree(phoneNumber: string): Promise<IvrDecisionNode[]> {
  const rows = await query<{
    ivr_text: string; ai_action: string; ai_value: string;
    calls_success: string; calls_total: string; success_pct: string;
  }>(
    `SELECT ivr_text, ai_action, ai_value, calls_success, calls_total,
            ROUND(calls_success::numeric / calls_total * 100) AS success_pct
     FROM ivr_decision_nodes
     WHERE phone_number = $1 AND calls_total >= 1
     ORDER BY calls_total DESC, ivr_text, success_pct DESC
     LIMIT 30`,
    [phoneNumber]
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
