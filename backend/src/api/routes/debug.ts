import { FastifyPluginAsync } from 'fastify';
import { query, queryOne } from '../../db/client';
import { runAllTests, startTestRun } from '../../services/test-runner';
import OpenAI from 'openai';
import { config } from '../../config';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

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

  // Weekly time series for overview charts
  fastify.get('/debug/weekly', async () => {
    const rows = await query<any>(`
      SELECT
        DATE_TRUNC('week', started_at)::date                                            AS week,
        COUNT(*)                                                                         AS total,
        COUNT(*) FILTER (WHERE human_reached
          OR ended_reason IN ('callback_number_given','callback_offered'))               AS successful,
        COUNT(*) FILTER (WHERE status IN ('ENDED','FAILED','BRIDGED')
          AND COALESCE(ended_reason,'') NOT IN
            ('server_restart','dial_failed','busy','no-answer',
             'outside_hours','voicemail','voicemail_left','invalid_number',
             'callback_caller_id','user_cancelled'))                                     AS navigable,
        ROUND(AVG(wait_duration_seconds) FILTER (WHERE human_reached))::int             AS avg_wait_secs,
        COUNT(*) FILTER (WHERE human_reached = true AND user_confirmed = false)          AS fp_count,
        COUNT(*) FILTER (WHERE human_reached = false AND user_confirmed = true)          AS fn_count,
        COUNT(*) FILTER (WHERE human_reached = true AND user_confirmed = true)           AS tp_count
      FROM calls
      WHERE started_at > NOW() - INTERVAL '8 weeks'
      GROUP BY week
      ORDER BY week
    `);
    return rows.map(r => ({
      week: r.week,
      total: parseInt(r.total),
      successful: parseInt(r.successful),
      navigable: parseInt(r.navigable),
      avgWaitSecs: r.avg_wait_secs ? parseInt(r.avg_wait_secs) : null,
      successRate: parseInt(r.navigable) > 0 ? Math.round(parseInt(r.successful) / parseInt(r.navigable) * 100) : null,
      fpRate: (parseInt(r.tp_count) + parseInt(r.fp_count)) > 0
        ? Math.round(parseInt(r.fp_count) / (parseInt(r.tp_count) + parseInt(r.fp_count)) * 100) : null,
      fnRate: (parseInt(r.tp_count) + parseInt(r.fn_count)) > 0
        ? Math.round(parseInt(r.fn_count) / (parseInt(r.tp_count) + parseInt(r.fn_count)) * 100) : null,
    }));
  });

  // Detection quality: false positives and false negatives based on user feedback
  fastify.get('/debug/detection-quality', async () => {
    const [summary, falsePosRows, falseNegRows] = await Promise.all([
      queryOne<any>(`
        SELECT
          COUNT(*) FILTER (WHERE human_reached = true  AND user_confirmed = false)              AS false_positives,
          COUNT(*) FILTER (WHERE human_reached = false AND user_confirmed = true)               AS false_negatives,
          COUNT(*) FILTER (WHERE human_reached = true  AND user_confirmed = true)                 AS true_positives,
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

  // Memory tab: all phone numbers with any learning data
  fastify.get('/debug/memory', async () => {
    const [patterns, nodes] = await Promise.all([
      query<any>(`
        SELECT phone_number, company, COUNT(*) AS patterns,
               ROUND(MAX(success_rate) * 100) AS best_success_rate,
               MAX(updated_at) AS last_updated
        FROM memory_patterns
        WHERE phone_number IS NOT NULL
        GROUP BY phone_number, company ORDER BY patterns DESC
      `),
      query<any>(`
        SELECT phone_number, company, COUNT(*) AS nodes
        FROM ivr_decision_nodes WHERE phone_number IS NOT NULL
        GROUP BY phone_number, company
      `),
    ]);

    const map = new Map<string, any>();
    for (const p of patterns) {
      map.set(p.phone_number, {
        phoneNumber: p.phone_number,
        company: p.company,
        patterns: parseInt(p.patterns),
        nodes: 0,
        bestSuccessRate: parseInt(p.best_success_rate ?? 0),
        lastUpdated: p.last_updated,
      });
    }
    for (const n of nodes) {
      const existing = map.get(n.phone_number);
      if (existing) existing.nodes = parseInt(n.nodes);
      else map.set(n.phone_number, { phoneNumber: n.phone_number, company: n.company, patterns: 0, nodes: parseInt(n.nodes), bestSuccessRate: 0 });
    }
    return [...map.values()].sort((a, b) => (b.patterns + b.nodes) - (a.patterns + a.nodes));
  });

  // Per-phone: all 3 learning layers
  fastify.get('/debug/memory/:phoneNumber', async (request) => {
    const { phoneNumber } = request.params as { phoneNumber: string };
    const [patterns, nodes, ivrNote, userNotes, companyName] = await Promise.all([
      query<any>(`
        SELECT path, success_rate, sample_count, avg_wait_seconds, last_verified_at
        FROM memory_patterns WHERE phone_number = $1
        ORDER BY success_rate DESC, sample_count DESC
      `, [phoneNumber]),
      query<any>(`
        SELECT ivr_text, ai_action, ai_value, calls_success, calls_total,
               ROUND(calls_success::numeric / NULLIF(calls_total, 0) * 100) AS success_pct,
               last_seen_at
        FROM ivr_decision_nodes WHERE phone_number = $1
        ORDER BY calls_total DESC LIMIT 60
      `, [phoneNumber]),
      queryOne<any>(`
        SELECT summary, outcome, updated_at FROM company_ivr_notes
        WHERE phone_number = $1 ORDER BY updated_at DESC LIMIT 1
      `, [phoneNumber]),
      query<any>(`
        SELECT note, updated_at FROM user_company_notes
        WHERE phone_number = $1
      `, [phoneNumber]),
      queryOne<any>(`SELECT DISTINCT company FROM calls WHERE phone_number = $1 LIMIT 1`, [phoneNumber]),
    ]);
    return { patterns, nodes, ivrNote, userNotes, company: companyName?.company ?? phoneNumber };
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
        c.user_confirmed,
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

  // ── Eval / Test Framework ─────────────────────────────────────────────────

  // List all scenarios
  fastify.get('/debug/test/scenarios', async () => {
    return query<any>(`SELECT * FROM test_scenarios ORDER BY created_at`);
  });

  // Create a scenario
  fastify.post('/debug/test/scenarios', async (request) => {
    const b = request.body as any;
    return queryOne<any>(
      `INSERT INTO test_scenarios (name, company, goal, ivr_persona, expected_outcome, has_human, max_turns, tags, user_info, reference_call_ids, phone_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name, b.company, b.goal ?? 'reach_human', b.ivr_persona ?? '',
       b.expected_outcome, b.has_human ?? false, b.max_turns ?? 20, b.tags ?? [],
       b.user_info ?? null, b.reference_call_ids ?? [], b.phone_number ?? null]
    );
  });

  // Update a scenario
  fastify.patch('/debug/test/scenarios/:id', async (request) => {
    const { id } = request.params as { id: string };
    const b = request.body as any;
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const key of ['name','company','goal','ivr_persona','expected_outcome','has_human','max_turns','tags','user_info','reference_call_ids','phone_number']) {
      if (key in b) { fields.push(`${key} = $${i++}`); values.push(b[key]); }
    }
    if (!fields.length) return { ok: true };
    values.push(id);
    return queryOne<any>(`UPDATE test_scenarios SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  });

  // Delete a scenario
  fastify.delete('/debug/test/scenarios/:id', async (request) => {
    const { id } = request.params as { id: string };
    await query(`DELETE FROM test_scenarios WHERE id = $1`, [id]);
    return { ok: true };
  });

  // Trigger a test run — creates run record immediately, returns runId, runs in background
  fastify.post('/debug/test/run', async () => {
    const runId = await startTestRun('manual');
    runAllTests('manual', runId).catch(err => console.error('[TestRunner] Run failed:', err));
    return { status: 'started', runId };
  });

  // Auto-generate a test scenario from a real call transcript
  fastify.post('/debug/test/generate-scenario', async (request) => {
    const { callId, transcript, company, goal, outcome, hasHuman } = request.body as any;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'system',
        content: `Given a real phone call transcript, generate a short descriptive name for this test scenario. Output JSON only: {"name": "..."}`
      }, {
        role: 'user',
        content: `Company: ${company}\nGoal: ${goal}\nActual outcome: ${outcome}\nHas human at end: ${hasHuman}\n\nTranscript:\n${transcript.slice(0, 1000)}`
      }],
      response_format: { type: 'json_object' },
    });

    const generated = JSON.parse(resp.choices[0]?.message?.content ?? '{}');
    return queryOne<any>(
      `INSERT INTO test_scenarios (name, company, goal, ivr_persona, expected_outcome, has_human, max_turns, tags, reference_call_ids)
       VALUES ($1, $2, $3, $4, $5, $6, 20, $7, $8) RETURNING *`,
      [
        generated.name ?? `${company} — ${outcome}`,
        company, goal ?? 'reach_human',
        '',
        outcome, hasHuman,
        [`auto-generated`, `call:${callId.slice(0,8)}`],
        callId ? [callId] : [],
      ]
    );
  });

  // List past runs
  fastify.get('/debug/test/runs', async () => {
    return query<any>(`SELECT * FROM test_runs ORDER BY started_at DESC LIMIT 20`);
  });

  // Results for a specific run
  fastify.get('/debug/test/runs/:runId', async (request) => {
    const { runId } = request.params as { runId: string };
    const [run, results] = await Promise.all([
      queryOne<any>(`SELECT * FROM test_runs WHERE id = $1`, [runId]),
      query<any>(`
        SELECT tr.*, ts.name AS scenario_name, ts.company, ts.has_human, ts.tags
        FROM test_results tr
        JOIN test_scenarios ts ON ts.id = tr.scenario_id
        WHERE tr.run_id = $1
        ORDER BY tr.created_at
      `, [runId]),
    ]);
    return { run, results };
  });

  // Latest run summary (for dashboard polling)
  fastify.get('/debug/test/latest', async () => {
    const run = await queryOne<any>(`SELECT * FROM test_runs ORDER BY started_at DESC LIMIT 1`);
    if (!run) return null;
    const results = await query<any>(`
      SELECT tr.*, ts.name AS scenario_name, ts.company, ts.has_human, ts.tags
      FROM test_results tr
      JOIN test_scenarios ts ON ts.id = tr.scenario_id
      WHERE tr.run_id = $1
      ORDER BY tr.created_at
    `, [run.id]);
    return { run, results };
  });
};

export default debugPlugin;
