import { FastifyPluginAsync } from 'fastify';
import { query, queryOne } from '../../db/client';

const debugPlugin: FastifyPluginAsync = async (fastify) => {

  // Aggregated KPIs + outcome breakdown + company table (last 7 days)
  fastify.get('/debug/overview', async () => {
    const [kpis, outcomes, companies] = await Promise.all([
      queryOne<any>(`
        SELECT
          COUNT(DISTINCT c.id)                                                          AS total_calls,
          COUNT(DISTINCT c.id) FILTER (WHERE c.human_reached)                          AS successful,
          ROUND(COUNT(DISTINCT c.id) FILTER (WHERE c.human_reached)::numeric /
            NULLIF(COUNT(DISTINCT c.id), 0) * 100)                                     AS success_pct,
          ROUND(AVG((dl.data->>'latency_ms')::int) FILTER (
            WHERE dl.event_type = 'llm_decision' AND dl.data->>'latency_ms' IS NOT NULL
          ))                                                                            AS avg_latency_ms,
          ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY (dl.data->>'latency_ms')::int
          ) FILTER (WHERE dl.event_type = 'llm_decision' AND dl.data->>'latency_ms' IS NOT NULL)) AS p95_latency_ms,
          ROUND(
            COUNT(dl.id) FILTER (WHERE dl.event_type = 'llm_decision' AND dl.data->>'decision_source' = 'prefetch')::numeric /
            NULLIF(COUNT(dl.id) FILTER (WHERE dl.event_type = 'llm_decision'), 0) * 100
          )                                                                            AS prefetch_pct,
          COUNT(DISTINCT c.id) FILTER (WHERE c.started_at > NOW() - INTERVAL '24 hours') AS calls_24h
        FROM calls c
        LEFT JOIN call_debug_logs dl ON dl.call_id = c.id
        WHERE c.started_at > NOW() - INTERVAL '7 days'
      `),
      query<any>(`
        SELECT
          CASE WHEN human_reached THEN 'human_reached'
               ELSE COALESCE(ended_reason, status)
          END AS outcome,
          COUNT(*) AS count
        FROM calls
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY outcome ORDER BY count DESC LIMIT 12
      `),
      query<any>(`
        SELECT
          company,
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE human_reached)              AS successful,
          ROUND(COUNT(*) FILTER (WHERE human_reached)::numeric /
            NULLIF(COUNT(*), 0) * 100)                       AS success_pct,
          ROUND(AVG(wait_duration_seconds) FILTER (WHERE human_reached)) AS avg_wait_secs
        FROM calls
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY company
        ORDER BY total DESC LIMIT 15
      `)
    ]);
    return { kpis, outcomes, companies };
  });

  // Paginated call list with per-call debug flags
  fastify.get('/debug/calls', async (request) => {
    const { company = '', outcome = '', limit = '60' } = request.query as Record<string, string>;

    const rows = await query<any>(`
      SELECT
        c.id,
        c.company,
        c.started_at,
        c.ended_at,
        c.status,
        c.human_reached,
        c.ended_reason,
        EXTRACT(EPOCH FROM (COALESCE(c.ended_at, NOW()) - c.started_at))::int     AS duration_secs,
        COUNT(dl.id) FILTER (WHERE dl.event_type = 'llm_decision')                AS decision_count,
        ROUND(AVG((dl.data->>'latency_ms')::int) FILTER (
          WHERE dl.event_type = 'llm_decision' AND dl.data->>'latency_ms' IS NOT NULL
        ))                                                                         AS avg_latency_ms,
        BOOL_OR(COALESCE((dl.data->'consecutive_same_phrase'->>'count')::int, 0) >= 2)
          FILTER (WHERE dl.event_type = 'llm_decision')                           AS had_phrase_loop,
        BOOL_OR(COALESCE((dl.data->'consecutive_same_key'->>'count')::int, 0) >= 2)
          FILTER (WHERE dl.event_type = 'llm_decision')                           AS had_dtmf_stuck,
        BOOL_OR((dl.data->>'downgraded')::bool)
          FILTER (WHERE dl.event_type = 'llm_decision')                           AS had_downgrade,
        BOOL_OR(COALESCE((dl.data->>'low_conf_counter_new')::int, 0) >= 2)
          FILTER (WHERE dl.event_type = 'llm_decision')                           AS had_low_conf
      FROM calls c
      LEFT JOIN call_debug_logs dl ON dl.call_id = c.id
      WHERE ($1 = '' OR LOWER(c.company) LIKE '%' || LOWER($1) || '%')
        AND ($2 = '' OR (
          CASE
            WHEN $2 = 'human_reached' THEN c.human_reached = true
            WHEN $2 = 'failed'        THEN NOT c.human_reached AND c.status IN ('ENDED','FAILED')
            ELSE COALESCE(c.ended_reason, c.status) = $2
          END
        ))
      GROUP BY c.id
      ORDER BY c.started_at DESC
      LIMIT $3
    `, [company, outcome, parseInt(limit, 10)]);

    return rows;
  });

  // Full call detail: metadata + all debug events + transcripts + memory flag
  fastify.get('/debug/calls/:callId', async (request) => {
    const { callId } = request.params as { callId: string };

    const call = await queryOne<any>(`SELECT * FROM calls WHERE id = $1`, [callId]);
    if (!call) return { error: 'Call not found' };

    const [debugEvents, transcripts, memCount] = await Promise.all([
      query<any>(
        `SELECT event_type, timestamp, data FROM call_debug_logs WHERE call_id = $1 ORDER BY timestamp`,
        [callId]
      ),
      query<any>(
        `SELECT speaker, text, timestamp, human_confidence FROM transcripts WHERE call_id = $1 ORDER BY timestamp`,
        [callId]
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memory_patterns WHERE LOWER(company) = LOWER($1)`,
        [call.company]
      ),
    ]);

    return {
      call,
      debugEvents,
      transcripts,
      hasMemoryPatterns: parseInt(memCount?.count ?? '0', 10) > 0,
    };
  });
};

export default debugPlugin;
