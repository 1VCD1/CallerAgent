import { FastifyPluginAsync } from 'fastify';
import { query } from '../../db/client';
import { STRATEGY_SCORE_SQL } from '../../services/memory';

const analyticsPlugin: FastifyPluginAsync = async (fastify) => {

  fastify.get('/analytics/overview', async () => {
    const rows = await query<{
      total_calls: string;
      successful: string;
      avg_wait_secs: string | null;
      success_pct: string | null;
    }>(
      `SELECT
         COUNT(*) AS total_calls,
         COUNT(*) FILTER (WHERE human_reached = true) AS successful,
         ROUND(AVG(wait_duration_seconds) FILTER (WHERE human_reached = true)::numeric)::integer AS avg_wait_secs,
         CASE WHEN COUNT(*) > 0
           THEN ROUND(COUNT(*) FILTER (WHERE human_reached = true)::numeric / COUNT(*) * 100)::integer
           ELSE NULL
         END AS success_pct
       FROM calls`
    );
    const r = rows[0] ?? { total_calls: '0', successful: '0', avg_wait_secs: null, success_pct: null };
    return {
      totalCalls: parseInt(r.total_calls, 10),
      successful: parseInt(r.successful, 10),
      avgWaitSecs: r.avg_wait_secs !== null ? parseInt(r.avg_wait_secs, 10) : null,
      successPct: r.success_pct !== null ? parseInt(r.success_pct, 10) : null,
    };
  });

  fastify.get('/analytics/outcomes', async () => {
    const rows = await query<{ outcome: string; count: string }>(
      `SELECT
         CASE WHEN human_reached = true THEN 'human_reached'
              ELSE COALESCE(ended_reason, status)
         END AS outcome,
         COUNT(*) AS count
       FROM calls
       GROUP BY outcome
       ORDER BY count DESC`
    );
    return rows.map(r => ({ outcome: r.outcome, count: parseInt(r.count, 10) }));
  });

  fastify.get('/analytics/companies', async () => {
    const rows = await query<{
      company: string;
      total: string;
      successful: string;
      success_pct: string | null;
      avg_wait_secs: string | null;
    }>(
      `SELECT
         company,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE human_reached = true) AS successful,
         ROUND(COUNT(*) FILTER (WHERE human_reached = true)::numeric / COUNT(*) * 100)::integer AS success_pct,
         ROUND(AVG(wait_duration_seconds) FILTER (WHERE human_reached = true)::numeric)::integer AS avg_wait_secs
       FROM calls
       GROUP BY company
       ORDER BY total DESC
       LIMIT 20`
    );
    return rows.map(r => ({
      company: r.company,
      total: parseInt(r.total, 10),
      successful: parseInt(r.successful, 10),
      successPct: r.success_pct !== null ? parseInt(r.success_pct, 10) : null,
      avgWaitSecs: r.avg_wait_secs !== null ? parseInt(r.avg_wait_secs, 10) : null,
    }));
  });

  fastify.get('/analytics/patterns', async () => {
    const rows = await query<{
      company: string;
      goal: string;
      path: string | string[];
      success_rate: number;
      sample_count: number;
      avg_wait_seconds: number | null;
      strategy_score: number;
    }>(
      `SELECT company, goal, path, success_rate, sample_count, avg_wait_seconds,
              ${STRATEGY_SCORE_SQL} AS strategy_score
       FROM memory_patterns
       ORDER BY strategy_score DESC, sample_count DESC
       LIMIT 20`
    );
    return rows.map(r => ({
      company: r.company,
      goal: r.goal,
      path: Array.isArray(r.path) ? r.path : JSON.parse(r.path as string),
      successRate: Math.round(r.success_rate * 100),
      sampleCount: r.sample_count,
      avgWaitSecs: r.avg_wait_seconds,
      strategyScore: parseFloat(Number(r.strategy_score).toFixed(2)),
    }));
  });

};

export default analyticsPlugin;
