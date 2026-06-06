import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { CallOrchestrator } from '../../services/call-orchestrator';
import { query, queryOne } from '../../db/client';
import { sendPushNotification } from '../../services/notifications';
import { sendSMS } from '../../services/telephony';
import { callEvents, emitCallStatus } from '../../services/call-events';
import { config } from '../../config';
import { requireAuth } from '../middleware/auth';

// Simple in-memory rate limiter: max 5 POST /calls per IP per minute
const callRateLimiter = new Map<string, { count: number; resetAt: number }>();
function checkCallRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = callRateLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    callRateLimiter.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// API key check for write operations
function requireApiKey(request: any, reply: any, done: () => void) {
  if (!config.app.apiKey) return done(); // auth disabled if no key configured
  const provided = request.headers['x-api-key'] ?? request.headers['authorization']?.replace(/^Bearer /, '');
  if (provided !== config.app.apiKey) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  done();
}

// In-memory registry of active orchestrators
const activeOrchestrators = new Map<string, CallOrchestrator>();

const createCallSchema = z.object({
  company: z.string().min(1),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  userPhoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  goal: z.string().optional(),
  userId: z.string().uuid().optional(), // optional when auth token provides it
  ivrLanguage: z.enum(['en', 'zh-TW', 'zh-CN']).optional(),
});

const updateUserSchema = z.object({
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD
  pushToken: z.string().optional(),
  language: z.enum(['en', 'zh-TW', 'zh-CN']).optional(),
});

const bridgeCallSchema = z.object({
  userPhoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/),
});

const callsPlugin: FastifyPluginAsync = async (fastify) => {
  // POST /users — create a new user profile
  fastify.post('/users', { preHandler: requireApiKey }, async (request, reply) => {
    const body = updateUserSchema.parse(request.body);
    const id = uuidv4();
    await query(
      `INSERT INTO users (id, email, name, phone_number, birthday)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, body.email ?? null, body.name ?? null, body.phoneNumber ?? null, body.birthday ?? null]
    );
    const user = await queryOne(`SELECT id, email, name, phone_number, birthday FROM users WHERE id = $1`, [id]);
    return reply.status(201).send(user);
  });

  // GET /users/:id — get user profile
  fastify.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const user = await queryOne(
      `SELECT id, email, name, phone_number, birthday, language FROM users WHERE id = $1`,
      [request.params.id]
    );
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return user;
  });

  // PATCH /users/:id — update user profile
  fastify.patch<{ Params: { id: string } }>('/users/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params;
    const body = updateUserSchema.parse(request.body);

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (body.phoneNumber !== undefined) { fields.push(`phone_number = $${idx++}`); values.push(body.phoneNumber); }
    if (body.email !== undefined)       { fields.push(`email = $${idx++}`); values.push(body.email); }
    if (body.name !== undefined)        { fields.push(`name = $${idx++}`); values.push(body.name); }
    if (body.birthday !== undefined)    { fields.push(`birthday = $${idx++}`); values.push(body.birthday); }

    if (body.pushToken !== undefined)  { fields.push(`push_token = $${idx++}`);  values.push(body.pushToken); }
    if (body.language !== undefined)   { fields.push(`language = $${idx++}`);    values.push(body.language); }

    if (fields.length > 0) {
      values.push(id);
      await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    }

    const user = await queryOne(`SELECT id, email, name, phone_number, birthday, language FROM users WHERE id = $1`, [id]);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return user;
  });

  // POST /calls — create and start a new AI call
  fastify.post('/calls', { preHandler: requireAuth }, async (request, reply) => {
    const body = createCallSchema.parse(request.body);

    // userId from auth token takes precedence over body
    const userId = (request as any).userId ?? body.userId;
    if (!userId) return reply.status(401).send({ error: 'Not authenticated' });

    // Rate limit: max 5 new calls per IP per minute
    const ip = request.ip ?? '0.0.0.0';
    if (!checkCallRateLimit(ip)) {
      return reply.status(429).send({ error: 'Too many calls. Please wait a minute.' });
    }

    // Guard: reject if user already has an active call
    const activeCall = await queryOne<{ id: string }>(
      `SELECT id FROM calls WHERE user_id = $1 AND status NOT IN ('ENDED','FAILED') LIMIT 1`,
      [userId]
    );
    if (activeCall) {
      return reply.status(409).send({ error: 'You already have an active call in progress.', callId: activeCall.id });
    }

    // Guard: per-user daily call limit
    const DAILY_CALL_LIMIT = 999;
    const usageRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM calls WHERE user_id = $1 AND started_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    const dailyUsed = parseInt(usageRow?.count ?? '0', 10);
    if (dailyUsed >= DAILY_CALL_LIMIT) {
      return reply.status(429).send({
        error: `You've reached the daily limit of ${DAILY_CALL_LIMIT} calls. Try again in a few hours.`,
        code: 'DAILY_LIMIT_REACHED',
        limit: DAILY_CALL_LIMIT,
        used: dailyUsed,
      });
    }

    // Detect IVR language from country code — most reliable signal for what language the phone system uses
    function detectIvrLanguage(phone: string): 'en' | 'zh-TW' | 'zh-CN' {
      const d = phone.replace(/\D/g, '');
      if (d.startsWith('886')) return 'zh-TW';  // Taiwan
      if (d.startsWith('852') || d.startsWith('853')) return 'zh-TW';  // Hong Kong / Macau
      if (d.startsWith('86'))  return 'zh-CN';  // China (after 886 check)
      return 'en';
    }

    // Resolve user profile for callback number, language, and AI context
    const user = await queryOne<{ phone_number: string; name: string; birthday: string; language: string }>(
      `SELECT phone_number, name, birthday, language FROM users WHERE id = $1`,
      [userId]
    );
    const userPhoneNumber = body.userPhoneNumber ?? user?.phone_number ?? undefined;

    // Reject early if no callback phone — the bridge will fail silently without one
    if (!userPhoneNumber) {
      return reply.status(400).send({
        error: 'No callback phone number set. Add one in your profile before starting a call.',
        code: 'MISSING_CALLBACK_PHONE',
      });
    }

    const orchestrator = await CallOrchestrator.create({
      company: body.company,
      phoneNumber: body.phoneNumber,
      userPhoneNumber,
      userInfo: { name: user?.name ?? undefined, birthday: user?.birthday ?? undefined, phoneNumber: userPhoneNumber },
      language: body.ivrLanguage ?? detectIvrLanguage(body.phoneNumber),
      goal: body.goal,
      userId,
      onUserNotify: async (callId) => {
        // SMS: fires immediately so user knows to answer the incoming Twilio call
        if (userPhoneNumber) {
          await sendSMS(
            userPhoneNumber,
            `Your AI agent reached a live ${body.company} representative! Answer the incoming call to be connected.`
          ).catch(err => console.error('[SMS] Failed:', err));
        }

        // Push notification for when mobile app is ready
        const user = await queryOne<{ push_token: string }>(
          `SELECT push_token FROM users WHERE id = $1`,
          [userId]
        );
        if (user?.push_token) {
          await sendPushNotification(user.push_token, {
            title: 'Human Agent Connected!',
            body: `A live representative is on the line for your ${body.company} call. Tap to join.`,
            data: { callId, action: 'JOIN_CALL' },
          });
        }
      },
    });

    const callId = orchestrator.getCallId();
    activeOrchestrators.set(callId, orchestrator);

    await orchestrator.start();

    return reply.status(201).send({ callId, status: 'DIALING' });
  });

  // GET /calls/:id — get call status
  fastify.get<{ Params: { id: string } }>('/calls/:id', async (request, reply) => {
    const { id } = request.params;

    const call = await queryOne(
      `SELECT c.*,
        COALESCE(json_agg(t ORDER BY t.timestamp ASC) FILTER (WHERE t.id IS NOT NULL), '[]') as transcripts
       FROM calls c
       LEFT JOIN transcripts t ON t.call_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [id]
    );

    if (!call) return reply.status(404).send({ error: 'Call not found' });
    return call;
  });

  // GET /calls — list calls for a user
  fastify.get<{ Querystring: { userId?: string; limit?: string } }>(
    '/calls',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId: queryUserId, limit = '20' } = request.query;
      const userId = (request as any).userId ?? queryUserId;
      if (!userId) return reply.status(401).send({ error: 'Not authenticated' });
      const calls = await query(
        `SELECT * FROM calls WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
        [userId, parseInt(limit, 10)]
      );
      return calls;
    }
  );

  // POST /calls/:id/bridge — bridge user into call
  fastify.post<{ Params: { id: string } }>('/calls/:id/bridge', { preHandler: requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const body = bridgeCallSchema.parse(request.body);

    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) {
      return reply.status(404).send({ error: 'Active call not found' });
    }

    await orchestrator.bridgeUser(body.userPhoneNumber);
    return { success: true, callId: id };
  });

  // PATCH /calls/:id/feedback — user confirms or rejects human detection result
  fastify.patch<{ Params: { id: string }; Body: { confirmed: boolean } }>(
    '/calls/:id/feedback',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      const { confirmed } = request.body as { confirmed: boolean };
      if (typeof confirmed !== 'boolean') return reply.status(400).send({ error: 'confirmed must be boolean' });
      await query(`UPDATE calls SET user_confirmed = $1 WHERE id = $2`, [confirmed, id]);
      // If user marks as false positive, regenerate IVR notes with correction
      if (!confirmed) {
        const { generateFeedbackCorrection } = await import('../../services/call-summarizer');
        generateFeedbackCorrection(id).catch(err =>
          console.error('[Feedback] Failed to generate correction:', err)
        );
      }
      return { ok: true };
    }
  );

  // DELETE /calls/:id — end a call
  fastify.delete<{ Params: { id: string } }>('/calls/:id', { preHandler: requireApiKey }, async (request, reply) => {
    const { id } = request.params;

    // Get Twilio call SID before deleting orchestrator
    const callRow = await queryOne<{ twilio_call_sid: string | null; user_call_sid: string | null }>(
      `SELECT twilio_call_sid, user_call_sid FROM calls WHERE id = $1`,
      [id]
    );

    const orchestrator = activeOrchestrators.get(id);
    if (orchestrator) activeOrchestrators.delete(id);

    // Actually hang up via Twilio API — stops billing and disconnects both parties
    const { getTwilioClient } = await import('../../services/telephony');
    const twilio = getTwilioClient();
    await Promise.allSettled([
      callRow?.twilio_call_sid
        ? twilio.calls(callRow.twilio_call_sid).update({ status: 'completed' })
        : Promise.resolve(),
      callRow?.user_call_sid
        ? twilio.calls(callRow.user_call_sid).update({ status: 'completed' })
        : Promise.resolve(),
    ]);

    await query(
      `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'user_cancelled' WHERE id = $1`,
      [id]
    );
    emitCallStatus(id, 'ENDED');
    return { success: true };
  });

  // GET /calls/:id/events — SSE for realtime call state updates
  fastify.get<{ Params: { id: string } }>('/calls/:id/events', async (request, reply) => {
    const { id } = request.params;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendEvent = (event: string, data: unknown) => {
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    // Send current status immediately
    const orchestrator = activeOrchestrators.get(id);
    if (orchestrator) {
      sendEvent('status', { callId: id, status: orchestrator.getStatus() });
    } else {
      const call = await queryOne<{ status: string }>(`SELECT status FROM calls WHERE id = $1`, [id]);
      if (call) sendEvent('status', { callId: id, status: call.status });
    }

    // Event-driven: push instantly whenever orchestrator or Gather webhook emits a status change
    const onStatus = (status: string) => sendEvent('status', { callId: id, status });
    callEvents.on(`call:${id}`, onStatus);

    // Fallback poll every 5s in case an event was missed (e.g. after server restart)
    const interval = setInterval(async () => {
      const call = await queryOne<{ status: string }>(`SELECT status FROM calls WHERE id = $1`, [id]);
      if (call) sendEvent('status', { callId: id, status: call.status });
    }, 5000);

    request.raw.on('close', () => {
      callEvents.off(`call:${id}`, onStatus);
      clearInterval(interval);
    });
    return reply;
  });

  // GET /memory/:company — get adaptive memory for a company
  fastify.get<{ Params: { company: string } }>('/memory/:company', async (request, reply) => {
    const patterns = await query(
      `SELECT * FROM memory_patterns WHERE company = $1 ORDER BY success_rate DESC LIMIT 20`,
      [request.params.company]
    );
    return patterns;
  });

  // GET /company-suggestions — autocomplete from all calls, user's own history ranked first
  fastify.get<{ Querystring: { q?: string; userId?: string } }>(
    '/company-suggestions',
    async (request, reply) => {
      const userId = (request as any).userId ?? request.query.userId;
      const q = (request.query.q ?? '').trim();
      if (q.length < 2) return reply.send([]);
      const rows = await query<{ company: string; phone_number: string }>(
        `SELECT company, phone_number FROM (
           SELECT DISTINCT ON (LOWER(company)) company, phone_number,
             CASE WHEN user_id = $1 THEN 0 ELSE 1 END AS priority,
             started_at
           FROM calls
           WHERE LOWER(company) LIKE '%' || LOWER($2) || '%'
              OR LOWER($2) LIKE '%' || LOWER(company) || '%'
           ORDER BY LOWER(company), CASE WHEN user_id = $1 THEN 0 ELSE 1 END ASC, started_at DESC
         ) sub
         ORDER BY priority ASC, started_at DESC
         LIMIT 5`,
        [userId ?? null, q]
      );
      return rows.map(r => ({ company: r.company, phone: r.phone_number }));
    }
  );

  // GET /company-stats/:company — user's historical call stats for a specific company
  fastify.get<{ Params: { company: string }; Querystring: { userId?: string } }>(
    '/company-stats/:company',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = (request as any).userId ?? request.query.userId;
      if (!userId) return reply.send(null);
      const { company } = request.params;
      const row = await queryOne<{ total: string; successful: string; avg_wait_secs: string | null }>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('ENDED','FAILED')) AS total,
           COUNT(*) FILTER (WHERE
             CASE WHEN user_confirmed IS NOT NULL THEN user_confirmed ELSE human_reached END = true
           ) AS successful,
           ROUND(AVG(wait_duration_seconds) FILTER (WHERE
             CASE WHEN user_confirmed IS NOT NULL THEN user_confirmed ELSE human_reached END = true
           )::numeric)::integer AS avg_wait_secs
         FROM calls
         WHERE user_id = $1 AND (
           LOWER(company) = LOWER($2)
           OR LOWER(company) LIKE '%' || LOWER($2) || '%'
           OR LOWER($2) LIKE '%' || LOWER(company) || '%'
         )`,
        [userId, company]
      );
      const total = parseInt(row?.total ?? '0', 10);
      if (total === 0) return reply.send(null);
      const successful = parseInt(row?.successful ?? '0', 10);
      return {
        total,
        successful,
        successPct: Math.round(successful / total * 100),
        avgWaitSecs: row?.avg_wait_secs ? parseInt(row.avg_wait_secs, 10) : null,
      };
    }
  );

  // GET /company-notes/:company — fetch user's tip for a company
  fastify.get<{ Params: { company: string }; Querystring: { userId?: string } }>(
    '/company-notes/:company',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = (request as any).userId ?? request.query.userId;
      if (!userId) return reply.send(null);
      const row = await queryOne<{ note: string }>(
        `SELECT note FROM user_company_notes
         WHERE user_id = $1 AND (
           LOWER(company) = LOWER($2)
           OR LOWER(company) LIKE '%' || LOWER($2) || '%'
           OR LOWER($2) LIKE '%' || LOWER(company) || '%'
         ) LIMIT 1`,
        [userId, request.params.company]
      );
      return row ?? null;
    }
  );

  // PUT /company-notes/:company — upsert (or delete if empty) user's tip for a company
  fastify.put<{ Params: { company: string }; Body: { note: string } & { userId?: string } }>(
    '/company-notes/:company',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = (request as any).userId ?? (request.body as any).userId;
      if (!userId) return reply.status(401).send({ error: 'Not authenticated' });
      const { company } = request.params;
      const { note } = request.body as { note: string };
      if (!note?.trim()) {
        await query(
          `DELETE FROM user_company_notes WHERE user_id = $1 AND LOWER(company) = LOWER($2)`,
          [userId, company]
        );
        return { deleted: true };
      }
      await query(
        `INSERT INTO user_company_notes (user_id, company, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, company) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`,
        [userId, company, note.trim()]
      );
      return { saved: true };
    }
  );

  // GET /ivr-notes/:company — get IVR learning notes for a company
  fastify.get<{ Params: { company: string } }>('/ivr-notes/:company', async (request, reply) => {
    const rows = await query(
      `SELECT summary, outcome, updated_at FROM company_ivr_notes
       WHERE LOWER(company) = LOWER($1) ORDER BY updated_at DESC LIMIT 1`,
      [request.params.company]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'No notes found' });
    return rows[0];
  });
};

export { activeOrchestrators };
export default callsPlugin;
