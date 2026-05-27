import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import path from 'path';
import { WebSocket } from 'ws';
import { config } from './config';

if (config.app.sentryDsn) {
  Sentry.init({ dsn: config.app.sentryDsn, environment: config.nodeEnv });
  console.log('[Sentry] Error tracking enabled');
}
import callsPlugin from './api/routes/calls';
import webhooksPlugin, { registerRecordingRoutes } from './api/routes/webhooks';
import analyticsPlugin from './api/routes/analytics';
import { activeOrchestrators } from './api/routes/calls';

// Registry of browser monitor clients: callId → set of WebSocket connections
export const monitorSockets = new Map<string, Set<WebSocket>>();

export function broadcastToMonitors(callId: string, data: Buffer): void {
  const clients = monitorSockets.get(callId);
  if (!clients || clients.size === 0) return;
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch (e) {
      console.error(`[Monitor] send error:`, e);
    }
  }
}

// mulaw codec for mixing IVR + AI audio
function mulawDecode(u: number): number {
  u = ~u & 0xFF;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  let sample = ((mantissa << 1) + 33) << exp;
  sample -= 33;
  return sign ? -sample : sample;
}

function mulawEncode(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  sample = Math.min(sample, 32767) + 33;
  let exp = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const mantissa = (sample >> (exp + 1)) & 0x0F;
  return ~(sign | (exp << 4) | mantissa) & 0xFF;
}

function mixMulaw(a: Buffer, b: Buffer): Buffer {
  const len = Math.max(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    const sa = i < a.length ? mulawDecode(a[i]) : 0;
    const sb = i < b.length ? mulawDecode(b[i]) : 0;
    out[i] = mulawEncode(Math.max(-32768, Math.min(32767, sa + sb)));
  }
  return out;
}

// Pending outbound chunks queued until the matching inbound arrives
const outboundQueues = new Map<string, Buffer[]>();

const fastify = Fastify({
  logger: {
    level: 'warn',
    transport: config.nodeEnv !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
});

async function cleanupStaleCalls() {
  const { query } = await import('./db/client');
  const { getTwilioClient } = await import('./services/telephony');

  // Find all calls that are still active in DB (orchestrators are gone after restart)
  const staleCalls = await query<{ id: string; twilio_call_sid: string | null }>(
    `SELECT id, twilio_call_sid FROM calls WHERE status NOT IN ('ENDED', 'FAILED')`
  );

  if (staleCalls.length === 0) return;

  console.log(`[Startup] Found ${staleCalls.length} active call(s) — terminating via Twilio API...`);

  const twilio = getTwilioClient();
  await Promise.allSettled(
    staleCalls.map(async (c) => {
      if (c.twilio_call_sid) {
        try {
          await twilio.calls(c.twilio_call_sid).update({ status: 'completed' });
          console.log(`[Startup] Hung up Twilio call ${c.twilio_call_sid}`);
        } catch (err: any) {
          // Call may already be ended on Twilio's side — safe to ignore
          console.log(`[Startup] Twilio call ${c.twilio_call_sid} already ended: ${err.message}`);
        }
      }
    })
  );

  await query(
    `UPDATE calls SET status = 'ENDED', ended_at = COALESCE(ended_at, NOW()), ended_reason = 'server_restart'
     WHERE status NOT IN ('ENDED', 'FAILED')`
  );
  console.log(`[Startup] Cleaned up ${staleCalls.length} stale call(s)`);
}

async function bootstrap() {
  await cleanupStaleCalls();

  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(formbody);
  await fastify.register(websocket);

  // WebSocket endpoint for Twilio audio stream
  fastify.register(async (app) => {
    app.get('/ws/audio/:callId', { websocket: true }, (socket, request) => {
      const { callId } = request.params as { callId: string };
      const orchestrator = activeOrchestrators.get(callId);

      if (!orchestrator) {
        socket.close(1008, 'Unknown call');
        return;
      }

      console.log(`[WS] Audio stream connected for call ${callId}`);

      socket.on('message', (rawMsg) => {
        // Twilio sends JSON-wrapped audio events
        try {
          const msg = JSON.parse(rawMsg.toString());

          if (msg.event === 'media') {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            const track = msg.media.track as string;

            if (track === 'inbound_track') {
              orchestrator.handleAudioChunk(audioBuffer);
              // Mix with any queued outbound (AI TTS) chunk
              const outQueue = outboundQueues.get(callId);
              const outChunk = outQueue?.shift();
              broadcastToMonitors(callId, outChunk ? mixMulaw(audioBuffer, outChunk) : audioBuffer);
            } else if (track === 'outbound_track') {
              if (!outboundQueues.has(callId)) outboundQueues.set(callId, []);
              const q = outboundQueues.get(callId)!;
              q.push(audioBuffer);
              if (q.length > 10) q.shift(); // prevent unbounded growth
            }
          } else if (msg.event === 'start') {
            console.log(`[WS] Stream started for call ${callId}`);
          } else if (msg.event === 'stop') {
            console.log(`[WS] Stream stopped for call ${callId}`);
          }
        } catch {
          // Raw audio buffer (non-Twilio client)
          if (rawMsg instanceof Buffer) {
            orchestrator.handleAudioChunk(rawMsg);
          }
        }
      });

      socket.on('close', () => {
        outboundQueues.delete(callId);
        monitorSockets.delete(callId);
        console.log(`[WS] Audio stream disconnected for call ${callId}`);
      });

      socket.on('error', (err) => {
        console.error(`[WS] Error for call ${callId}:`, err);
      });
    });

    // WebSocket endpoint for browser live monitor
    app.get('/ws/monitor/:callId', { websocket: true }, (socket, request) => {
      const { callId } = request.params as { callId: string };
      const ws = socket as unknown as WebSocket;

      if (!monitorSockets.has(callId)) monitorSockets.set(callId, new Set());
      monitorSockets.get(callId)!.add(ws);
      console.log(`[Monitor] Browser connected for call ${callId} (clients: ${monitorSockets.get(callId)!.size})`);
      // Send a silent mulaw byte to verify binary data path
      ws.send(Buffer.from([0x7F]));

      socket.on('close', () => {
        monitorSockets.get(callId)?.delete(ws);
        console.log(`[Monitor] Browser disconnected for call ${callId}`);
      });
    });
  });

  await fastify.register(staticFiles, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  await fastify.register(callsPlugin);
  await fastify.register(webhooksPlugin);
  await fastify.register(analyticsPlugin);
  registerRecordingRoutes(fastify);

  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/dashboard', async (_request, reply) => reply.redirect('/dashboard.html'));

  // Redirect to monitor page for the current active call
  fastify.get('/monitor/active', async (request, reply) => {
    const { query: dbQuery } = await import('./db/client');
    const rows = await dbQuery<{ id: string }>(
      `SELECT id FROM calls WHERE status NOT IN ('ENDED', 'FAILED') ORDER BY started_at DESC LIMIT 1`
    );
    if (!rows[0]) {
      return reply.type('text/html').send('<h2>No active call right now.</h2>');
    }
    return reply.redirect(`/monitor.html?callId=${rows[0].id}`);
  });

  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server running on port ${config.port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  if (config.app.sentryDsn) Sentry.captureException(err);
  process.exit(1);
});
