import { FastifyPluginAsync } from 'fastify';
import { query, queryOne } from '../../db/client';

const debugPlugin: FastifyPluginAsync = async (fastify) => {

  // Aggregated KPIs + funnel + guard rails + outcome breakdown + company table (last 7 days)
  fastify.get('/debug/overview', async () => {
    const [kpis, funnel, guardRails, outcomes, companies] = await Promise.all([
      queryOne<any>(`
        SELECT
          COUNT(DISTINCT c.id) FILTER (WHERE c.started_at > NOW() - INTERVAL '24 hours') AS calls_24h,
          ROUND(AVG(c.wait_duration_seconds) FILTER (
            WHERE c.human_reached AND c.wait_duration_seconds IS NOT NULL
          )) AS avg_time_to_human_secs,
          -- Debug-log-dependent metrics: null when no debug data exists
          ROUND(AVG((dl.data->>'latency_ms')::int) FILTER (
            WHERE dl.event_type = 'llm_decision' AND dl.data->>'latency_ms' IS NOT NULL
          )) AS avg_latency_ms,
          ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY (dl.data->>'latency_ms')::int
          ) FILTER (WHERE dl.event_type = 'llm_decision' AND dl.data->>'latency_ms' IS NOT NULL)) AS p95_latency_ms,
          ROUND(
            COUNT(dl.id) FILTER (WHERE dl.event_type = 'llm_decision' AND dl.data->>'decision_source' = 'prefetch')::numeric /
            NULLIF(COUNT(dl.id) FILTER (WHERE dl.event_type = 'llm_decision'), 0) * 100
          ) AS prefetch_pct,
          COUNT(dl.id) FILTER (WHERE dl.event_type = 'llm_decision') AS debug_decision_count
        FROM calls c
        LEFT JOIN call_debug_logs dl ON dl.call_id = c.id
        WHERE c.started_at > NOW() - INTERVAL '7 days'
      `),
      queryOne<any>(`
        SELECT
          -- Stage 1: all call attempts
          COUNT(*)                                                                      AS initiated,
          -- Stage 2: phone actually picked up (not busy/no-answer/invalid/dial_failed)
          COUNT(*) FILTER (WHERE COALESCE(ended_reason,'') NOT IN
            ('dial_failed','busy','no-answer','invalid_number'))                       AS connected,
          -- Stage 3: calls that completed normally (AI had a chance to navigate)
          COUNT(*) FILTER (WHERE status IN ('ENDED','FAILED','BRIDGED')
            AND COALESCE(ended_reason,'') NOT IN
              ('server_restart','dial_failed','busy','no-answer'))                     AS navigated,
          -- Stage 4: human reached OR callback with number given (both count as success)
          COUNT(*) FILTER (WHERE human_reached
            OR ended_reason IN ('callback_number_given','callback_offered'))           AS human_reached,
          -- AI performance denominator: navigated calls where success was theoretically possible
          -- excludes impossible outcomes AND user_cancelled (user chose to stop, not AI failure)
          COUNT(*) FILTER (WHERE status IN ('ENDED','FAILED','BRIDGED')
            AND COALESCE(ended_reason,'') NOT IN
              ('server_restart','dial_failed','busy','no-answer',
               'outside_hours','voicemail','voicemail_left','invalid_number',
               'callback_caller_id','user_cancelled'))                                 AS navigable
        FROM calls
        WHERE started_at > NOW() - INTERVAL '7 days'
      `),
      queryOne<any>(`
        SELECT
          -- % navigated calls that had a phrase loop
          ROUND(
            COUNT(DISTINCT c.id) FILTER (WHERE loop_flag.call_id IS NOT NULL)::numeric /
            NULLIF(COUNT(DISTINCT c.id) FILTER (WHERE nav_flag.call_id IS NOT NULL), 0) * 100
          ) AS phrase_loop_pct,
          -- % navigated calls with low confidence collapse
          ROUND(
            COUNT(DISTINCT c.id) FILTER (WHERE lowconf_flag.call_id IS NOT NULL)::numeric /
            NULLIF(COUNT(DISTINCT c.id) FILTER (WHERE nav_flag.call_id IS NOT NULL), 0) * 100
          ) AS low_conf_pct,
          -- callback_caller_id count (callback but no number given)
          COUNT(DISTINCT c.id) FILTER (WHERE c.ended_reason = 'callback_caller_id') AS callback_caller_id_count
        FROM calls c
        LEFT JOIN LATERAL (
          SELECT c2.id AS call_id FROM calls c2
          WHERE c2.id = c.id
            AND c2.status IN ('ENDED','FAILED','BRIDGED')
            AND COALESCE(c2.ended_reason,'') NOT IN ('server_restart','dial_failed','busy','no-answer','user_cancelled')
          LIMIT 1
        ) nav_flag ON true
        LEFT JOIN LATERAL (
          SELECT call_id FROM call_debug_logs dl
          WHERE dl.call_id = c.id AND dl.event_type = 'llm_decision'
            AND COALESCE((dl.data->'consecutive_same_phrase'->>'count')::int, 0) >= 2
          LIMIT 1
        ) loop_flag ON true
        LEFT JOIN LATERAL (
          SELECT call_id FROM call_debug_logs dl
          WHERE dl.call_id = c.id AND dl.event_type = 'llm_decision'
            AND COALESCE((dl.data->>'low_conf_counter_new')::int, 0) >= 2
          LIMIT 1
        ) lowconf_flag ON true
        WHERE c.started_at > NOW() - INTERVAL '7 days'
      `),
      query<any>(`
        SELECT
          company,
          CASE
            WHEN human_reached                          THEN 'human_reached'
            WHEN ended_reason = 'callback_number_given' THEN 'callback_number_given'
            WHEN ended_reason = 'callback_caller_id'    THEN 'callback_caller_id'
            WHEN ended_reason = 'completed'             THEN 'no_human_path'
            ELSE COALESCE(ended_reason, status)
          END AS outcome,
          COUNT(*) AS count
        FROM calls
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY company, outcome ORDER BY company, count DESC
      `),
      query<any>(`
        SELECT
          company,
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE human_reached
            OR ended_reason IN ('callback_number_given','callback_offered')) AS successful,
          ROUND(COUNT(*) FILTER (WHERE human_reached
            OR ended_reason IN ('callback_number_given','callback_offered'))::numeric /
            NULLIF(COUNT(*) FILTER (WHERE status IN ('ENDED','FAILED','BRIDGED')
              AND COALESCE(ended_reason,'') NOT IN ('server_restart','dial_failed')), 0) * 100) AS success_pct,
          ROUND(AVG(wait_duration_seconds) FILTER (WHERE human_reached)) AS avg_wait_secs
        FROM calls
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY company
        ORDER BY total DESC LIMIT 15
      `)
    ]);
    return { kpis, funnel, guardRails, outcomes, companies };
  });

  // Detection quality: false positives and false negatives based on user feedback
  fastify.get('/debug/detection-quality', async () => {
    const [summary, falsePosRows, falseNegRows] = await Promise.all([
      queryOne<any>(`
        SELECT
          COUNT(*) FILTER (WHERE human_reached = true  AND user_confirmed = false)              AS false_positives,
          COUNT(*) FILTER (WHERE human_reached = false AND user_confirmed = true)               AS false_negatives,
          COUNT(*) FILTER (WHERE human_reached = true  AND user_confirmed IS DISTINCT FROM false) AS true_positives,
          COUNT(*) FILTER (WHERE user_confirmed IS NOT NULL)                                    AS with_feedback,
          COUNT(*)                                                                               AS total
        FROM calls
        WHERE started_at > NOW() - INTERVAL '30 days'
      `),
      // False positives: AI thought human, user said no — show what IVR said
      query<any>(`
        SELECT
          c.id, c.company, c.started_at, c.human_confidence,
          c.ended_reason,
          (SELECT text FROM transcripts
           WHERE call_id = c.id AND speaker = 'IVR'
           ORDER BY timestamp DESC LIMIT 1) AS last_ivr_text,
          (SELECT text FROM transcripts
           WHERE call_id = c.id AND speaker = 'IVR' AND human_confidence IS NOT NULL
           ORDER BY human_confidence DESC LIMIT 1) AS highest_conf_ivr_text
        FROM calls c
        WHERE c.human_reached = true AND c.user_confirmed = false
          AND c.started_at > NOW() - INTERVAL '30 days'
        ORDER BY c.started_at DESC
        LIMIT 20
      `),
      // False negatives: AI missed human, user confirmed
      query<any>(`
        SELECT
          c.id, c.company, c.started_at, c.ended_reason,
          MAX(t.human_confidence) AS max_human_conf_seen,
          (SELECT text FROM transcripts t2
           WHERE t2.call_id = c.id AND t2.speaker = 'IVR' AND t2.human_confidence IS NOT NULL
           ORDER BY t2.human_confidence DESC LIMIT 1) AS closest_human_text
        FROM calls c
        LEFT JOIN transcripts t ON t.call_id = c.id
        WHERE c.human_reached = false AND c.user_confirmed = true
          AND c.started_at > NOW() - INTERVAL '30 days'
        GROUP BY c.id, c.company, c.started_at, c.ended_reason
        ORDER BY c.started_at DESC
        LIMIT 20
      `)
    ]);
    return { summary, falsePosRows, falseNegRows };
  });

  // Memory tab: companies with any learning data
  fastify.get('/debug/memory', async () => {
    const [patterns, nodes] = await Promise.all([
      query<any>(`
        SELECT company, COUNT(*) AS patterns,
               ROUND(MAX(success_rate) * 100) AS best_success_rate,
               MAX(updated_at) AS last_updated
        FROM memory_patterns GROUP BY company ORDER BY patterns DESC
      `),
      query<any>(`SELECT company, COUNT(*) AS nodes FROM ivr_decision_nodes GROUP BY company`),
    ]);

    const map = new Map<string, any>();
    for (const p of patterns) {
      map.set(p.company.toLowerCase(), {
        company: p.company,
        patterns: parseInt(p.patterns),
        nodes: 0,
        bestSuccessRate: parseInt(p.best_success_rate ?? 0),
        lastUpdated: p.last_updated,
      });
    }
    for (const n of nodes) {
      const key = n.company.toLowerCase();
      const existing = map.get(key);
      if (existing) existing.nodes = parseInt(n.nodes);
      else map.set(key, { company: n.company, patterns: 0, nodes: parseInt(n.nodes), bestSuccessRate: 0 });
    }
    return [...map.values()].sort((a, b) => (b.patterns + b.nodes) - (a.patterns + a.nodes));
  });

  // Per-company: all 3 learning layers
  fastify.get('/debug/memory/:company', async (request) => {
    const { company } = request.params as { company: string };
    const [patterns, nodes, ivrNote, userNotes] = await Promise.all([
      query<any>(`
        SELECT path, success_rate, sample_count, avg_wait_seconds, last_verified_at
        FROM memory_patterns WHERE LOWER(company) = LOWER($1)
        ORDER BY success_rate DESC, sample_count DESC
      `, [company]),
      query<any>(`
        SELECT ivr_text, ai_action, ai_value, calls_success, calls_total,
               ROUND(calls_success::numeric / NULLIF(calls_total, 0) * 100) AS success_pct,
               last_seen_at
        FROM ivr_decision_nodes WHERE LOWER(company) = LOWER($1)
        ORDER BY calls_total DESC LIMIT 60
      `, [company]),
      queryOne<any>(`
        SELECT summary, outcome, updated_at FROM company_ivr_notes
        WHERE LOWER(company) = LOWER($1) ORDER BY updated_at DESC LIMIT 1
      `, [company]),
      query<any>(`
        SELECT note, updated_at FROM user_company_notes WHERE LOWER(company) = LOWER($1)
      `, [company]),
    ]);
    return { patterns, nodes, ivrNote, userNotes };
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
