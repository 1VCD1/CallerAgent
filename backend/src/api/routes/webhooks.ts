import { FastifyPluginAsync } from 'fastify';
import * as https from 'https';
import { activeOrchestrators } from './calls';
import { query } from '../../db/client';
import { getMemoryPatterns } from '../../services/memory';
import { decideLLMAction } from '../../services/llm-engine';
import { config } from '../../config';
import { CallContext, ActionRecord } from '../../types';
import { getLang } from '../../languages';
import { isOutsideBusinessHours, extractMenuKeys } from '../../services/human-detector';
import { generateCallSummary, getCompanyIvrNotes } from '../../services/call-summarizer';

const webhooksPlugin: FastifyPluginAsync = async (fastify) => {
  // Twilio call status webhook
  fastify.post('/webhooks/twilio/status', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const { CallSid, CallStatus } = body;

    const call = await query<{ id: string }>(
      `SELECT id FROM calls WHERE twilio_call_sid = $1`,
      [CallSid]
    );

    if (!call[0]) return reply.send('ok');

    const callId = call[0].id;
    const orchestrator = activeOrchestrators.get(callId);

    if (CallStatus === 'in-progress' && orchestrator) {
      await orchestrator.onCallConnected();
    } else if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
      await query(
        `UPDATE calls SET status = 'ENDED', ended_at = NOW(),
         ended_reason = COALESCE(ended_reason, $2)
         WHERE id = $1`,
        [callId, CallStatus === 'completed' ? 'completed' : CallStatus]
      );
      activeOrchestrators.delete(callId);
      // Fire post-call summary in background
      generateCallSummary(callId).catch(console.error);
    }

    return reply.send('ok');
  });

  // Twilio Gather webhook — main AI decision loop
  fastify.post('/webhooks/twilio/gather', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const query_params = request.query as Record<string, string>;
    const callId = query_params.callId;

    const spokenText = body.SpeechResult ?? '';
    const digits = body.Digits ?? '';

    console.log(`[Gather] callId=${callId} speech="${spokenText}" digits="${digits}"`);

    // Persist transcript if we got speech; capture ID to update with confidence later
    let transcriptId: string | null = null;
    if (spokenText) {
      const rows = await query<{ id: string }>(
        `INSERT INTO transcripts (call_id, speaker, text) VALUES ($1, 'IVR', $2) RETURNING id`,
        [callId, spokenText]
      );
      transcriptId = rows[0]?.id ?? null;
    }

    const orchestrator = activeOrchestrators.get(callId);

    // Outside business hours — end call immediately, no point navigating
    if (spokenText && isOutsideBusinessHours(spokenText)) {
      console.log(`[Gather] Outside business hours detected — ending call ${callId}`);
      await query(
        `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'outside_hours' WHERE id = $1`,
        [callId]
      );
      if (orchestrator) activeOrchestrators.delete(callId);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    // Get full transcript and recent confidence history
    const transcripts = await query<{ text: string; human_confidence: number | null }>(
      `SELECT text, human_confidence FROM transcripts WHERE call_id = $1 ORDER BY timestamp ASC`,
      [callId]
    );
    const fullTranscript = transcripts.map(t => t.text).join(' ');
    const recentHumanConfidences = transcripts
      .map(t => t.human_confidence)
      .filter((c): c is number => c !== null)
      .slice(-10);

    // Get action history
    const actions = await query<{ action: string; value: string; success: boolean; timestamp: Date }>(
      `SELECT action, value, success, timestamp FROM action_history WHERE call_id = $1 ORDER BY timestamp DESC LIMIT 20`,
      [callId]
    );
    const previousActions: ActionRecord[] = actions.map(a => ({
      action: a.action as ActionRecord['action'],
      value: a.value,
      success: a.success,
      timestamp: a.timestamp,
    }));

    // Get call info
    const callRow = await query<{ company: string; goal: string; status: string; user_id: string }>(
      `SELECT company, goal, status, user_id FROM calls WHERE id = $1`,
      [callId]
    );
    if (!callRow[0]) {
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    const { company, goal, status: callStatus, user_id } = callRow[0];

    // Short-circuit: human already detected — don't call LLM, conference is already set up
    if (['HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'].includes(callStatus)) {
      console.log(`[Gather] Call ${callId} already in ${callStatus} — ignoring Gather`);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      return;
    }
    // ENDED/FAILED: call is over, just return empty — don't actively Hangup
    // (avoids race condition where status callback arrives slightly before Gather)
    if (['ENDED', 'FAILED'].includes(callStatus)) {
      console.log(`[Gather] Call ${callId} already ${callStatus} — ignoring Gather`);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      return;
    }

    // Use orchestrator cache for data that doesn't change mid-call
    // Falls back to DB queries on first call or when orchestrator is absent
    let memories = orchestrator?.getCachedMemories() ?? null;
    let userRowData = orchestrator?.getCachedUserRow() ?? null;
    let companyIvrNotes: string | null;
    const ivrNotesCached = orchestrator?.getCachedIvrNotes();

    const fetchPromises: Promise<any>[] = [];
    if (!memories) fetchPromises.push(getMemoryPatterns(company, goal).then(m => { memories = m; if (orchestrator) orchestrator['cachedMemories'] = m; }));
    if (!userRowData) fetchPromises.push(query<{ name: string; birthday: string; language: string }>(`SELECT name, birthday, language FROM users WHERE id = $1`, [user_id]).then(r => { userRowData = r[0] ?? null; if (orchestrator && r[0]) orchestrator.setCachedUserRow(r[0]); }));
    if (ivrNotesCached === undefined) fetchPromises.push(getCompanyIvrNotes(company).then(n => { companyIvrNotes = n; if (orchestrator) orchestrator.setCachedIvrNotes(n); }));
    else companyIvrNotes = ivrNotesCached;

    if (fetchPromises.length > 0) await Promise.all(fetchPromises);
    companyIvrNotes = companyIvrNotes! ?? ivrNotesCached ?? null;

    const langConfig = getLang((userRowData as any)?.language);
    const recentFailures = previousActions.filter(a => !a.success).map(a => `${a.action}(${a.value})`);
    const userInfoObj = userRowData ? { name: (userRowData as any).name ?? undefined, birthday: (userRowData as any).birthday ?? undefined } : undefined;

    const recentTranscriptText = transcripts.slice(-5).map(t => t.text).join(' ');
    const availableMenuKeys = extractMenuKeys(recentTranscriptText);

    // Compute consecutive waits (previousActions is DESC order)
    let consecutiveWaits = 0;
    for (const a of previousActions) {
      if (a.action === 'wait') consecutiveWaits++;
      else break;
    }

    // Compute consecutive same DTMF key
    let consecutiveSameKey: { key: string; count: number } | undefined;
    if (previousActions.length > 0 && previousActions[0].action === 'press_key') {
      const key = previousActions[0].value;
      let count = 0;
      for (const a of previousActions) {
        if (a.action === 'press_key' && a.value === key) count++;
        else break;
      }
      if (count >= 2) consecutiveSameKey = { key: key!, count };
    }

    // Short-circuit: if waited 3+ times with NO speech, skip LLM — return fresh Gather
    // Only when spokenText is empty — if IVR said something, always call LLM to respond
    if (consecutiveWaits >= 3 && !spokenText) {
      console.log(`[Gather] ${consecutiveWaits} consecutive waits w/ no speech — skipping LLM, returning Gather`);
      const gatherUrl = `${config.app.webhookBaseUrl}/twilio/gather?callId=${callId}`;
      reply.type('text/xml').send(buildGatherTwiML(gatherUrl));
      return;
    }


    const context: CallContext = {
      callId,
      company,
      phoneNumber: '',
      goal,
      currentTranscript: fullTranscript || spokenText,
      historicalMemory: memories ?? [],
      currentCallState: 'IVR_NAVIGATION',
      previousActions,
      recentFailures,
      userInfo: userInfoObj,
      language: (userRowData as any)?.language ?? 'en',
      recentHumanConfidences,
      speakerChanged: orchestrator?.getSpeakerChanged() ?? false,
      availableMenuKeys: availableMenuKeys.length > 0 ? availableMenuKeys : undefined,
      companyIvrNotes: companyIvrNotes ?? undefined,
      currentIvrUtterance: spokenText || undefined,
      consecutiveWaits,
      consecutiveSameKey,
      audioAnalysis: orchestrator?.getAudioAnalysis() ?? null,
    };

    let twiml: string;
    try {
      // Use pre-fetched decision if started within last 4s (time-based, not text-based)
      const prefetched = orchestrator?.consumePendingDecision();
      const action = prefetched ? await prefetched : await decideLLMAction(context);
      console.log(`[Gather] decision source: ${prefetched ? 'prefetch' : 'fresh'}`)
      console.log(`[Gather] LLM: isHuman=${action.isHuman}(${action.humanConfidence?.toFixed(2)}) action=${action.action}(${action.value}) — ${action.reasoning}`);

      // Only update human_confidence when there's actual IVR/HUMAN speech to assess
      if (spokenText) {
        const conf = action.humanConfidence ?? 0;
        await query(`UPDATE calls SET human_confidence = $1 WHERE id = $2`, [conf, callId]);
        if (transcriptId) {
          await query(`UPDATE transcripts SET human_confidence = $1 WHERE id = $2`, [conf, transcriptId]);
        }
      }

      // LLM-based human detection
      // Require EITHER: is_human: true with confidence >= 0.6
      // OR: action === escalate_to_user with confidence >= 0.6
      // (LLM sometimes returns escalate_to_user with is_human: false — tolerate if confidence high enough)
      const humanConf = action.humanConfidence ?? 0;
      const humanDetected = (action.isHuman || action.action === 'escalate_to_user') && humanConf >= 0.75;
      if (humanDetected) {
        console.log(`[Gather] Human detected! isHuman=${action.isHuman} action=${action.action} confidence=${humanConf}`);

        await query(
          `UPDATE calls SET status = 'HUMAN_DETECTED', human_reached = true,
           wait_duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER
           WHERE id = $1`,
          [callId]
        );

        const conferenceName = `conf-${callId}`;

        // Fire bridge in background — don't block the TwiML response
        if (orchestrator) {
          orchestrator.onHumanDetected(conferenceName).catch(console.error);
        }

        // Put representative in a conference room with hold music while user is called
        reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${langConfig.ttsVoice}">${langConfig.humanBridgeMessage}</Say>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical">${conferenceName}</Conference>
  </Dial>
</Response>`);
        return;
      }

      const gatherUrl = `${config.app.webhookBaseUrl}/twilio/gather?callId=${callId}`;
      // escalate_to_user with low confidence means LLM is uncertain — don't hang up, just wait
      const safeAction = (action.action === 'escalate_to_user' && humanConf < 0.75) ? 'wait' : action.action;
      const safeValue  = safeAction === 'wait' ? '3' : action.value;
      if (safeAction !== action.action) {
        console.log(`[Gather] escalate_to_user downgraded to wait (humanConf=${humanConf.toFixed(2)} < 0.75)`);
      }

      // Save AI action as transcript entry using the ACTUAL executed action (safeAction)
      const actionText = safeAction === 'say_phrase'        ? safeValue ?? ''
                       : safeAction === 'press_key'         ? `[按鍵 ${safeValue}]`
                       : safeAction === 'wait'              ? `[等待 ${safeValue ?? ''}s]`
                       : safeAction === 'end_call'          ? `[結束通話]`
                       : safeAction === 'escalate_to_user'  ? `[轉接給使用者]`
                       : `[${safeAction}]`;
      await query(
        `INSERT INTO transcripts (call_id, speaker, text) VALUES ($1, 'AI', $2)`,
        [callId, actionText]
      );

      twiml = buildActionTwiML(safeAction, safeValue, gatherUrl, langConfig.ttsVoice);
    } catch (err) {
      console.error('[Gather] LLM error:', err);
      const retries = parseInt((query_params.retries ?? '0'), 10);
      if (retries >= 2) {
        // 3 consecutive LLM failures — end the call rather than loop forever
        await query(
          `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'llm_error' WHERE id = $1`,
          [callId]
        );
        activeOrchestrators.delete(callId);
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${langConfig.ttsVoice}">Sorry, we encountered a technical issue. Please try again later.</Say>
  <Hangup/>
</Response>`;
      } else {
        const gatherUrl = `${config.app.webhookBaseUrl}/twilio/gather?callId=${callId}&retries=${retries + 1}`;
        twiml = buildGatherTwiML(gatherUrl);
      }
    }

    reply.type('text/xml').send(twiml);
  });
};

function buildActionTwiML(action: string, value: string | undefined, gatherUrl: string, voice = 'alice'): string {
  let innerXml = '';

  switch (action) {
    case 'press_key':
      innerXml = `<Play digits="${value ?? '0'}"/>`;
      break;
    case 'say_phrase':
      innerXml = `<Say voice="${voice}">${value ?? 'representative'}</Say>`;
      break;
    case 'wait': {
      const rawSecs = parseInt(value ?? '5', 10);
      const cappedSecs = isNaN(rawSecs) ? 5 : Math.min(Math.max(rawSecs, 1), 20);
      innerXml = `<Pause length="${cappedSecs}"/>`;
      break;
    }
    case 'end_call':
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    case 'escalate_to_user':
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">I was unable to reach a representative automatically. Please try calling manually.</Say>
  <Hangup/>
</Response>`;
    default:
      innerXml = `<Pause length="3"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${innerXml}
  <Gather input="speech dtmf" timeout="3" speechTimeout="auto" action="${gatherUrl}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Redirect method="POST">${gatherUrl}</Redirect>
</Response>`;
}

function buildGatherTwiML(gatherUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="3" speechTimeout="auto" action="${gatherUrl}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Redirect method="POST">${gatherUrl}</Redirect>
</Response>`;
}

// Add recording and proxy routes to the main app (not inside webhooksPlugin)
export function registerRecordingRoutes(fastify: any) {
  // Twilio posts here when recording is ready (usually ~30s after call ends)
  fastify.post('/webhooks/twilio/recording', async (request: any, reply: any) => {
    const body = request.body as Record<string, string>;
    const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = body;

    if (RecordingStatus !== 'completed') return reply.send('ok');

    const call = await query<{ id: string }>(
      `SELECT id FROM calls WHERE twilio_call_sid = $1`,
      [CallSid]
    );
    if (!call[0]) return reply.send('ok');

    await query(
      `UPDATE calls SET recording_sid = $1, recording_url = $2 WHERE id = $3`,
      [RecordingSid, RecordingUrl, call[0].id]
    );

    console.log(`[Recording] Saved recording ${RecordingSid} for call ${call[0].id}`);
    return reply.send('ok');
  });

  // Proxy Twilio recording audio — keeps Twilio credentials server-side
  fastify.get('/api/calls/:callId/recording', async (request: any, reply: any) => {
    const { callId } = request.params as { callId: string };

    const rows = await query<{ recording_url: string }>(
      `SELECT recording_url FROM calls WHERE id = $1`,
      [callId]
    );
    const recordingUrl = rows[0]?.recording_url;
    if (!recordingUrl) {
      return reply.code(404).send({ error: 'No recording available' });
    }

    // Twilio recording URL needs .mp3 suffix and Basic Auth
    const mp3Url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`;
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');

    return new Promise<void>((resolve, reject) => {
      const req = https.get(mp3Url, {
        headers: { Authorization: `Basic ${auth}` },
      }, (res) => {
        reply.code(res.statusCode ?? 200);
        reply.header('Content-Type', 'audio/mpeg');
        reply.header('Accept-Ranges', 'bytes');
        if (res.headers['content-length']) {
          reply.header('Content-Length', res.headers['content-length']);
        }
        res.pipe(reply.raw);
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  });
}

export default webhooksPlugin;
