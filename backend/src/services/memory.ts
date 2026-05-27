import { query, queryOne } from '../db/client';
import { MemoryPattern, ActionRecord } from '../types';

export async function getMemoryPatterns(company: string, goal: string): Promise<MemoryPattern[]> {
  const rows = await query<{
    id: string;
    company: string;
    goal: string;
    path: string[];
    success_rate: number;
    sample_count: number;
    avg_wait_seconds: number;
    last_verified_at: Date;
  }>(
    `SELECT id, company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at
     FROM memory_patterns
     WHERE company = $1 AND goal = $2
     ORDER BY success_rate DESC, sample_count DESC
     LIMIT 10`,
    [company, goal]
  );

  return rows.map((r) => ({
    id: r.id,
    company: r.company,
    goal: r.goal,
    path: r.path,
    successRate: r.success_rate,
    avgWaitSeconds: r.avg_wait_seconds,
    lastVerifiedAt: r.last_verified_at,
  }));
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

  if (existing) {
    const newCount = existing.sample_count + 1;
    const successDelta = params.humanReached ? 1 : 0;
    const newSuccessRate =
      (existing.success_rate * existing.sample_count + successDelta) / newCount;

    await query(
      `UPDATE memory_patterns
       SET success_rate = $1,
           sample_count = $2,
           avg_wait_seconds = CASE WHEN $3::INTEGER IS NOT NULL
             THEN (COALESCE(avg_wait_seconds, 0) + $3::INTEGER) / 2
             ELSE avg_wait_seconds END,
           last_verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [newSuccessRate, newCount, params.waitDurationSeconds ?? null, existing.id]
    );
  } else {
    await query(
      `INSERT INTO memory_patterns (company, goal, path, success_rate, sample_count, avg_wait_seconds, last_verified_at)
       VALUES ($1, $2, $3, $4, 1, $5, NOW())`,
      [
        params.company,
        params.goal,
        pathKey,
        params.humanReached ? 1.0 : 0.0,
        params.waitDurationSeconds ?? null,
      ]
    );
  }
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

function formatPathStep(action: string, value: string): string {
  if (action === 'press_key') return `press ${value}`;
  if (action === 'say_phrase') return `say "${value}"`;
  if (action === 'wait') return `wait ${value}s`;
  return action;
}
