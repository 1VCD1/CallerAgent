import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { CallOrchestrator } from '../../services/call-orchestrator';
import { query, queryOne } from '../../db/client';
import { sendPushNotification } from '../../services/notifications';
import { sendSMS } from '../../services/telephony';

// In-memory registry of active orchestrators
const activeOrchestrators = new Map<string, CallOrchestrator>();

const createCallSchema = z.object({
  company: z.string().min(1),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  userPhoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  goal: z.string().optional(),
  userId: z.string().uuid(),
  ivrLanguage: z.enum(['en', 'zh-TW', 'zh-CN']).optional(), // language of the IVR being called
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
  fastify.post('/users', async (request, reply) => {
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
      `SELECT id, email, name, phone_number, birthday FROM users WHERE id = $1`,
      [request.params.id]
    );
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return user;
  });

  // PATCH /users/:id — update user profile
  fastify.patch<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
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

    const user = await queryOne(`SELECT id, email, name, phone_number, birthday FROM users WHERE id = $1`, [id]);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return user;
  });

  // POST /calls — create and start a new AI call
  fastify.post('/calls', async (request, reply) => {
    const body = createCallSchema.parse(request.body);

    // Guard: reject if user already has an active call
    const activeCall = await queryOne<{ id: string }>(
      `SELECT id FROM calls WHERE user_id = $1 AND status NOT IN ('ENDED','FAILED') LIMIT 1`,
      [body.userId]
    );
    if (activeCall) {
      return reply.status(409).send({ error: 'You already have an active call in progress.', callId: activeCall.id });
    }

    // Resolve user profile for callback number, language, and AI context
    const user = await queryOne<{ phone_number: string; name: string; birthday: string; language: string }>(
      `SELECT phone_number, name, birthday, language FROM users WHERE id = $1`,
      [body.userId]
    );
    const userPhoneNumber = body.userPhoneNumber ?? user?.phone_number ?? undefined;

    const orchestrator = await CallOrchestrator.create({
      company: body.company,
      phoneNumber: body.phoneNumber,
      userPhoneNumber,
      userInfo: { name: user?.name ?? undefined, birthday: user?.birthday ?? undefined },
      language: body.ivrLanguage ?? user?.language ?? 'en',
      goal: body.goal,
      userId: body.userId,
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
          [body.userId]
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
  fastify.get<{ Querystring: { userId: string; limit?: string } }>(
    '/calls',
    async (request, reply) => {
      const { userId, limit = '20' } = request.query;
      const calls = await query(
        `SELECT * FROM calls WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
        [userId, parseInt(limit, 10)]
      );
      return calls;
    }
  );

  // POST /calls/:id/bridge — bridge user into call
  fastify.post<{ Params: { id: string } }>('/calls/:id/bridge', async (request, reply) => {
    const { id } = request.params;
    const body = bridgeCallSchema.parse(request.body);

    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) {
      return reply.status(404).send({ error: 'Active call not found' });
    }

    await orchestrator.bridgeUser(body.userPhoneNumber);
    return { success: true, callId: id };
  });

  // DELETE /calls/:id — end a call
  fastify.delete<{ Params: { id: string } }>('/calls/:id', async (request, reply) => {
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
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const orchestrator = activeOrchestrators.get(id);
    if (orchestrator) {
      sendEvent('status', { callId: id, status: orchestrator.getStatus() });
    }

    const interval = setInterval(async () => {
      const call = await queryOne<{ status: string }>(
        `SELECT status FROM calls WHERE id = $1`,
        [id]
      );
      if (call) sendEvent('status', { callId: id, status: call.status });
    }, 2000);

    request.raw.on('close', () => clearInterval(interval));
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
