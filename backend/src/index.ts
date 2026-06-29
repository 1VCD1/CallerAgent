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
import debugPlugin from './api/routes/debug';
import authPlugin from './api/routes/auth';
import { activeOrchestrators } from './api/routes/calls';
import { getFirebaseAdmin } from './services/firebase-admin';

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
  // Initialize Firebase Admin early so auth middleware is ready
  getFirebaseAdmin();

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

  await fastify.register(authPlugin);
  await fastify.register(callsPlugin);
  await fastify.register(webhooksPlugin);
  await fastify.register(debugPlugin);
  registerRecordingRoutes(fastify);

  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/googlef5d64b292d1527bf.html', async (_req, reply) => {
    reply.type('text/html').send('google-site-verification: googlef5d64b292d1527bf.html');
  });

  fastify.get('/debug', async (_request, reply) => reply.redirect('/debug.html'));

  fastify.get('/privacy', async (_request, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CallerAgent – Privacy Policy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    h2 { font-size: 18px; margin-top: 36px; }
    p, li { font-size: 15px; color: #333; }
    a { color: #3b82f6; }
    .updated { color: #888; font-size: 13px; margin-bottom: 40px; }
  </style>
</head>
<body>
  <h1>CallerAgent Privacy Policy</h1>
  <p class="updated">Last updated: May 27, 2026</p>
  <p>CallerAgent ("we", "our", or "us") is committed to protecting your privacy. This policy explains how we collect, use, and safeguard your information when you use the CallerAgent mobile application.</p>
  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Account information:</strong> When you sign in with Google, we receive your name and email address.</li>
    <li><strong>Call data:</strong> We store records of calls you initiate, including the company name, phone number, goal, and call transcripts.</li>
    <li><strong>Device token:</strong> We collect your device's push notification token to notify you when a live representative is reached.</li>
    <li><strong>Personal information:</strong> Information you optionally provide in your profile (callback phone number, date of birth) used to assist the AI during calls.</li>
  </ul>
  <h2>How We Use Your Information</h2>
  <ul>
    <li>To authenticate you and provide access to the service.</li>
    <li>To navigate automated phone systems (IVR) on your behalf.</li>
    <li>To send you push notifications about your active calls.</li>
    <li>To improve the AI's ability to navigate phone systems over time.</li>
  </ul>
  <h2>Data Sharing</h2>
  <p>We do not sell or share your personal information with third parties, except as required to operate the service:</p>
  <ul>
    <li><strong>Twilio:</strong> Used to place phone calls on your behalf.</li>
    <li><strong>Deepgram:</strong> Used for real-time speech transcription during calls.</li>
    <li><strong>OpenAI:</strong> Used to power AI decision-making during calls.</li>
    <li><strong>Firebase (Google):</strong> Used for authentication and push notifications.</li>
  </ul>
  <h2>Data Retention</h2>
  <p>Call records and transcripts are retained to improve service quality. You may request deletion of your data by contacting us.</p>
  <h2>Security</h2>
  <p>We use industry-standard security measures to protect your data. All communication is encrypted via HTTPS.</p>
  <h2>Children's Privacy</h2>
  <p>CallerAgent is not intended for users under the age of 13.</p>
  <h2>Contact Us</h2>
  <p>Questions? Contact us at: <a href="mailto:toulio84@gmail.com">toulio84@gmail.com</a></p>
</body>
</html>`);
  });

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

  // Auto-run tests on new deploy (only if commit SHA changed)
  const currentSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  if (currentSha) {
    const { getLastTestedCommit, runAllTests } = await import('./services/test-runner');
    const lastSha = await getLastTestedCommit();
    if (lastSha !== currentSha) {
      console.log(`[TestRunner] New deploy detected (${lastSha ?? 'none'} → ${currentSha}) — auto-running tests in 30s`);
      setTimeout(() => {
        runAllTests('deploy').catch(err => console.error('[TestRunner] Auto-run failed:', err));
      }, 30_000); // 30s delay so server is fully warmed up
    } else {
      console.log(`[TestRunner] Same commit ${currentSha} — skipping auto-run`);
    }
  }
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  if (config.app.sentryDsn) Sentry.captureException(err);
  process.exit(1);
});
