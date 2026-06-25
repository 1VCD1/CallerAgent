import OpenAI from 'openai';
import { query, queryOne } from '../db/client';
import { MemoryPattern, ActionRecord } from '../types';
import { config } from '../config';

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

// Ranking score the agent uses to pick which historical paths to inject. Three factors:
//   1. success — Laplace-smoothed (success + 1)/(total + 2), so a lucky 1/1 scores ~0.67
//      instead of a misleading 1.0 and can't outrank a robust 18/20 path.
//   2. wait penalty — divide by (1 + wait/120), prefer faster paths.
//   3. recency decay — exp(-age / 90 days). IVR menus get rebuilt; a path verified 3 months
//      ago is worth ~37% of a fresh one, ~13% at 6 months. last_verified_at drives this.
// Kept as one shared SQL fragment so the formula lives in exactly one place
// (referenced by memory.ts, analytics.ts, debug.ts).
const RECENCY_DECAY_DAYS = 90;
export const STRATEGY_SCORE_SQL =
  `(((success_rate * sample_count + 1.0) / (sample_count + 2.0))`
  + ` / (1.0 + COALESCE(avg_wait_seconds, 300) / 120.0)`
  + ` * EXP(-EXTRACT(EPOCH FROM (NOW() - COALESCE(last_verified_at, NOW()))) / (86400.0 * ${RECENCY_DECAY_DAYS}.0)))`;

// ended_reasons we record as neither success nor failure — they say nothing about the AI's
// navigation quality, so counting them would unfairly drag down a path/node's success_rate.
// Two kinds:
//   - environmental: closed office, busy line, dial failure — outside the AI's control.
//   - callback_caller_id: navigation DID reach a callback offer, but the company would call
//     back on our Twilio caller-id (never reaches the user). The path worked; only delivery
//     failed — so stay neutral rather than punish the node. (callback_number_given = success.)
const NON_NAVIGATION_ENDED_REASONS = new Set([
  'outside_hours', 'busy', 'no-answer', 'dial_failed', 'invalid_number', 'server_restart',
  'callback_caller_id',
]);

// Single source of truth for "did navigation succeed?" — used by both learning layers
// AND the live agent so L1 (whole paths) and L2 (per-node) never disagree.
//   - human_reached: the goal, reached a live person.
//   - callback_number_given: AI proactively gave the user's callback number → company will
//     reach the user. Reliable, counts as success.
// NOT success: callback_caller_id (company would call back on our Twilio caller-id, which
// never reaches the user) and callback_offered (transient/unrefined — refined at call end).
export function isNavigationSuccess(humanReached: boolean, endedReason: string | null | undefined): boolean {
  return humanReached || endedReason === 'callback_number_given';
}

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
              ${STRATEGY_SCORE_SQL} AS strategy_score
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
              ${STRATEGY_SCORE_SQL} AS strategy_score
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
              ${STRATEGY_SCORE_SQL} AS strategy_score
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
            ${STRATEGY_SCORE_SQL} AS strategy_score
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
            ${STRATEGY_SCORE_SQL} AS strategy_score
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
  endedReason?: string | null;
  waitDurationSeconds?: number;
}): Promise<void> {
  // Environmental outcomes (closed office, busy line, dial failure) are not navigation
  // failures — recording success_rate=0 against the path would punish good navigation for
  // something it had no control over. Skip the update so the path's stats stay clean.
  if (!params.humanReached && params.endedReason && NON_NAVIGATION_ENDED_REASONS.has(params.endedReason)) {
    console.log(`[Memory:Skip] call=${params.callId.slice(0, 8)} reason=${params.endedReason} — neutral outcome, leaving path success_rate untouched`);
    return;
  }

  const actions = await query<{ action: string; value: string; success: boolean }>(
    `SELECT action, value, success FROM action_history WHERE call_id = $1 ORDER BY timestamp ASC`,
    [params.callId]
  );

  if (actions.length === 0) return;

  const path = actions.filter((a) => a.success).map((a) => formatPathStep(a.action, a.value));
  if (path.length === 0) return;

  const succeeded = isNavigationSuccess(params.humanReached, params.endedReason);

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
    const successDelta = succeeded ? 1 : 0;
    const newSuccessRate = (existing.success_rate * existing.sample_count + successDelta) / newCount;

    await query(
      `UPDATE memory_patterns
       SET success_rate = $1,
           sample_count = $2,
           avg_wait_seconds = CASE WHEN $3::INTEGER IS NOT NULL
             THEN (COALESCE(avg_wait_seconds, $3::INTEGER) * $6 + $3::INTEGER) / $2
             ELSE avg_wait_seconds END,
           strategy_embedding = COALESCE($5::vector, strategy_embedding),
           last_verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [newSuccessRate, newCount, params.waitDurationSeconds ?? null, existing.id, embeddingLiteral, existing.sample_count]
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
        succeeded ? 1.0 : 0.0,
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
  recent7Success: number; // successes within the last 7 days (rolling window)
  recent7Total: number;   // total calls within the last 7 days
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
  // Environmental outcomes (closed office, busy, dial failure) say nothing about whether the
  // node's action was right. Recording them as node failures is what wrongly sends good nodes
  // to AVOID after a few unlucky after-hours calls — so skip, same guard as recordCallOutcome.
  if (!params.humanReached && params.endedReason && NON_NAVIGATION_ENDED_REASONS.has(params.endedReason)) {
    console.log(`[Memory:Skip:L2] call=${params.callId.slice(0, 8)} reason=${params.endedReason} — neutral outcome, not punishing nodes`);
    return;
  }

  const decisions = await query<{ data: Record<string, any> }>(
    `SELECT data FROM call_debug_logs WHERE call_id = $1 AND event_type = 'llm_decision' ORDER BY timestamp`,
    [params.callId]
  );
  if (decisions.length === 0) return;

  const successDelta = isNavigationSuccess(params.humanReached, params.endedReason) ? 1 : 0;
  // One rolling-log entry per node this call, so we can later compute a recent-window rate.
  const outcomeEntry = JSON.stringify([{ t: new Date().toISOString(), s: successDelta }]);

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
         (phone_number, company, ivr_text, ai_action, ai_value, calls_success, calls_total, recent_outcomes)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb)
       ON CONFLICT (phone_number, ivr_text, ai_action, ai_value)
       DO UPDATE SET
         calls_success = ivr_decision_nodes.calls_success + $6,
         calls_total   = ivr_decision_nodes.calls_total   + 1,
         last_seen_at  = NOW(),
         -- append this outcome, dropping the oldest once we hit 20 entries (bounded log)
         recent_outcomes = (
           CASE WHEN jsonb_array_length(ivr_decision_nodes.recent_outcomes) >= 20
                THEN ivr_decision_nodes.recent_outcomes - 0
                ELSE ivr_decision_nodes.recent_outcomes END
         ) || $7::jsonb`,
      [params.phoneNumber, params.company, ivrKey, data.action, aiValue, successDelta, outcomeEntry]
    );
  }
}

export async function getIvrDecisionTree(phoneNumber: string): Promise<IvrDecisionNode[]> {
  const rows = await query<{
    ivr_text: string; ai_action: string; ai_value: string;
    calls_success: string; calls_total: string; success_pct: string;
    recent7_success: string; recent7_total: string;
  }>(
    `SELECT ivr_text, ai_action, ai_value, calls_success, calls_total,
            ROUND(calls_success::numeric / calls_total * 100) AS success_pct,
            COALESCE((SELECT COUNT(*) FILTER (WHERE (e->>'s')::int = 1)
                      FROM jsonb_array_elements(recent_outcomes) e
                      WHERE (e->>'t')::timestamptz > NOW() - INTERVAL '7 days'), 0) AS recent7_success,
            COALESCE((SELECT COUNT(*)
                      FROM jsonb_array_elements(recent_outcomes) e
                      WHERE (e->>'t')::timestamptz > NOW() - INTERVAL '7 days'), 0) AS recent7_total
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
    recent7Success: parseInt(r.recent7_success, 10),
    recent7Total:   parseInt(r.recent7_total,   10),
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
    sampleCount: parseInt(r.sample_count ?? '0', 10),
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
