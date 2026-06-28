import { FastifyPluginAsync } from 'fastify';
import * as https from 'https';
import twilio from 'twilio';
import { activeOrchestrators } from './calls';
import { query, queryOne } from '../../db/client';
import { getMemoryPatterns, getIvrDecisionTree, recordCallOutcome, recordIvrDecisionNodes } from '../../services/memory';
import { decideLLMAction } from '../../services/llm-engine';
import { config } from '../../config';
import { CallContext, ActionRecord, CallStatus } from '../../types';
import { getLang, buildVoicemailMessage } from '../../languages';
import { isOutsideBusinessHours, isCallbackOffer, isVoicemailGreeting, isInvalidOrDisconnected, extractMenuKeys, isWrongNumber, extractSuggestedNumber, isOnHold, computeActionStreaks } from '../../services/human-detector';
import { generateCallSummary, getCompanyIvrNotes } from '../../services/call-summarizer';
import { emitCallStatus } from '../../services/call-events';
import { logDebug } from '../../services/debug-logger';

// Derive the public base URL (scheme + host, no path) from webhookBaseUrl for Twilio sig validation
const webhookOrigin = (() => {
  try { return new URL(config.app.webhookBaseUrl).origin; } catch { return ''; }
})();

// Validate X-Twilio-Signature so only real Twilio requests reach our webhooks.
// Only enforced when webhookOrigin is set (i.e. not localhost).
function validateTwilioSignature(request: any, reply: any, done: () => void) {
  if (!webhookOrigin || webhookOrigin.includes('localhost')) return done();
  const signature = (request.headers['x-twilio-signature'] as string) ?? '';
  const fullUrl = `${webhookOrigin}${request.url}`;
  const params = (request.body ?? {}) as Record<string, string>;
  const valid = twilio.validateRequest(config.twilio.authToken, signature, fullUrl, params);
  if (!valid) {
    console.warn(`[Webhooks] Invalid Twilio signature for ${request.url}`);
    reply.code(403).send({ error: 'Forbidden' });
    return;
  }
  done();
}

const webhooksPlugin: FastifyPluginAsync = async (fastify) => {
  // Twilio call status webhook
  fastify.post('/webhooks/twilio/status', { preHandler: validateTwilioSignature }, async (request, reply) => {
    const body = request.body as Record<string, string>;
    const { CallSid, CallStatus, ErrorCode } = body;

    const call = await query<{ id: string }>(
      `SELECT id FROM calls WHERE twilio_call_sid = $1`,
      [CallSid]
    );

    if (!call[0]) return reply.send('ok');

    const callId = call[0].id;
    const orchestrator = activeOrchestrators.get(callId);

    if (CallStatus === 'in-progress' && orchestrator) {
      console.log(`[Status] Call ${callId} answered — starting navigation`);
      await orchestrator.onCallConnected();
    } else if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
      console.log(`[Status] Call ${callId} ended — Twilio status: ${CallStatus}`);
      // Map Twilio ErrorCode to a more specific ended_reason when possible
      const INVALID_NUMBER_CODES = new Set(['13225','13212','13214','21217','21401','21614','15001','21219']);
      const derivedReason = CallStatus === 'completed' ? 'completed'
        : (CallStatus === 'failed' && ErrorCode && INVALID_NUMBER_CODES.has(ErrorCode)) ? 'invalid_number'
        : CallStatus === 'failed' ? 'dial_failed'
        : CallStatus; // 'busy', 'no-answer'
      await query(
        `UPDATE calls SET status = 'ENDED', ended_at = NOW(),
         ended_reason = COALESCE(ended_reason, $2)
         WHERE id = $1`,
        [callId, derivedReason]
      );
      emitCallStatus(callId, 'ENDED');
      activeOrchestrators.delete(callId);

      const callRow = await query<{
        company: string; phone_number: string; goal: string; human_reached: boolean;
        wait_duration_seconds: number | null; ended_reason: string | null;
      }>(`SELECT company, phone_number, goal, human_reached, wait_duration_seconds, ended_reason FROM calls WHERE id = $1`, [callId]);

      // Refine callback_offered into specific sub-reasons
      if (callRow[0]?.ended_reason === 'callback_offered') {
        const aiLines = await query<{ text: string }>(
          `SELECT text FROM transcripts WHERE call_id = $1 AND speaker = 'AI' ORDER BY timestamp`,
          [callId]
        );
        // Detect if AI said a phone number (7+ digit sequence, possibly spaced)
        const phonePattern = /(\d[\s\-]?){7,}\d/;
        const gaveNumber = aiLines.some(t => phonePattern.test(t.text));
        const refinedReason = gaveNumber ? 'callback_number_given' : 'callback_caller_id';
        await query(`UPDATE calls SET ended_reason = $1 WHERE id = $2`, [refinedReason, callId]);
        callRow[0].ended_reason = refinedReason; // sync in-memory so recording uses correct value
        console.log(`[Status] Callback refined to '${refinedReason}' for call ${callId}`);
      }

      // Record call outcome and IVR decision tree nodes for learning
      if (callRow[0]) {
        const endedReason = callRow[0].ended_reason; // now reflects refined reason
        const memParams = {
          callId,
          company: callRow[0].company,
          phoneNumber: callRow[0].phone_number,
          goal: callRow[0].goal,
          humanReached: callRow[0].human_reached,
          endedReason,
          waitDurationSeconds: callRow[0].wait_duration_seconds ?? undefined,
        };
        console.log(`[Memory:Write] call=${callId.slice(0,8)} phone=${callRow[0].phone_number} human=${callRow[0].human_reached} reason=${endedReason}`);
        recordCallOutcome(memParams).catch(err =>
          console.error(`[Memory:Write:FAIL] recordCallOutcome call=${callId.slice(0,8)}:`, err)
        );
        recordIvrDecisionNodes({ callId, company: callRow[0].company, phoneNumber: callRow[0].phone_number, humanReached: callRow[0].human_reached, endedReason }).catch(err =>
          console.error(`[Memory:Write:FAIL] recordIvrDecisionNodes call=${callId.slice(0,8)}:`, err)
        );
      }

      // Fire post-call summary in background
      generateCallSummary(callId).catch(console.error);
    } else {
      console.log(`[Status] Call ${callId} status: ${CallStatus}`);
    }

    return reply.send('ok');
  });

  // Twilio Gather webhook — main AI decision loop
  fastify.post('/webhooks/twilio/gather', { preHandler: validateTwilioSignature }, async (request, reply) => {
    const body = request.body as Record<string, string>;
    const query_params = request.query as Record<string, string>;
    const callId = query_params.callId;

    const spokenText = body.SpeechResult ?? '';
    const digits = body.Digits ?? '';
    const lowConf = parseInt((query_params.lowConf ?? '0'), 10);

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
      emitCallStatus(callId, 'ENDED');
      if (orchestrator) activeOrchestrators.delete(callId);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    // Wrong number — IVR is directing user to call a different number
    if (spokenText && isWrongNumber(spokenText)) {
      const suggested = extractSuggestedNumber(spokenText);
      console.log(`[Gather] Wrong number detected — suggested: ${suggested ?? 'unknown'} — ending call ${callId}`);
      await query(
        `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'wrong_number' WHERE id = $1`,
        [callId]
      );
      if (suggested) {
        await query(
          `INSERT INTO call_debug_logs (call_id, event_type, data) VALUES ($1, 'wrong_number', $2)`,
          [callId, JSON.stringify({ suggested_number: suggested, ivr_text: spokenText })]
        );
      }
      emitCallStatus(callId, 'ENDED');
      if (orchestrator) activeOrchestrators.delete(callId);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    // Invalid / disconnected number
    if (spokenText && isInvalidOrDisconnected(spokenText)) {
      console.log(`[Gather] Invalid/disconnected number detected — ending call ${callId}`);
      await query(
        `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'invalid_number' WHERE id = $1`,
        [callId]
      );
      emitCallStatus(callId, 'ENDED');
      if (orchestrator) activeOrchestrators.delete(callId);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    // Callback offer detected — mark in DB so mobile can show the right label;
    // the LLM will accept it via the CALLBACK RULE in the system prompt
    if (spokenText && isCallbackOffer(spokenText)) {
      console.log(`[Gather] Callback offer detected for call ${callId} — LLM will accept`);
      await query(
        `UPDATE calls SET ended_reason = 'callback_offered' WHERE id = $1 AND ended_reason IS NULL`,
        [callId]
      );
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

    // Keep the orchestrator's action cache in sync so prefetchDecision has real previousActions
    if (orchestrator) orchestrator.updateActionCache(previousActions);

    // Short-circuit: very first Gather with no speech — IVR hasn't spoken yet, just wait
    if (!spokenText && !digits && previousActions.length === 0) {
      console.log(`[Gather] First Gather empty — waiting for IVR to speak`);
      const gatherUrl = `${config.app.webhookBaseUrl}/webhooks/twilio/gather?callId=${callId}`;
      reply.type('text/xml').send(buildGatherTwiML(gatherUrl));
      return;
    }

    // Get call info
    const callRow = await query<{ company: string; goal: string; status: string; user_id: string; user_phone_number: string | null }>(
      `SELECT company, goal, status, user_id, user_phone_number FROM calls WHERE id = $1`,
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
    let userCompanyNote: string | null;
    const ivrNotesCached = orchestrator?.getCachedIvrNotes();
    const noteCached = orchestrator?.getCachedCompanyNote();

    const fetchPromises: Promise<any>[] = [];
    if (!memories) fetchPromises.push(getMemoryPatterns(company, goal).then(m => { memories = m; if (orchestrator) orchestrator['cachedMemories'] = m; }));
    if (!userRowData) fetchPromises.push(query<{ name: string; birthday: string; language: string }>(`SELECT name, birthday, language FROM users WHERE id = $1`, [user_id]).then(r => { userRowData = r[0] ?? null; if (orchestrator && r[0]) orchestrator.setCachedUserRow(r[0]); }));
    if (ivrNotesCached === undefined) fetchPromises.push(getCompanyIvrNotes(company).then(n => { companyIvrNotes = n; if (orchestrator) orchestrator.setCachedIvrNotes(n); }));
    else companyIvrNotes = ivrNotesCached;
    if (noteCached === undefined) fetchPromises.push(queryOne<{ note: string }>(`SELECT note FROM user_company_notes WHERE user_id = $1 AND LOWER(company) = LOWER($2)`, [user_id, company]).then(r => { userCompanyNote = r?.note ?? null; if (orchestrator) orchestrator.setCachedCompanyNote(userCompanyNote!); }));
    else userCompanyNote = noteCached;

    // Action patterns fetched fresh each turn (cheap aggregate query, changes across calls)
    const ivrDecisionTree = await getIvrDecisionTree(company);

    if (fetchPromises.length > 0) await Promise.all(fetchPromises);
    companyIvrNotes = companyIvrNotes! ?? ivrNotesCached ?? null;
    userCompanyNote = userCompanyNote! ?? noteCached ?? null;

    const langConfig = getLang((userRowData as any)?.language);

    // Voicemail detected — leave a message on behalf of the user then hang up.
    // Must happen after user data is loaded so we have their name and callback number.
    if (spokenText && isVoicemailGreeting(spokenText)) {
      const vmPhone = callRow[0].user_phone_number ?? null;
      const vmLang  = (userRowData as any)?.language ?? 'en';
      const vmMsg   = buildVoicemailMessage({
        lang: vmLang,
        name: (userRowData as any)?.name ?? undefined,
        company,
        goal,
        phone: vmPhone ?? undefined,
      });
      console.log(`[Gather] Voicemail detected — ${vmPhone ? 'leaving message' : 'hanging up (no callback number)'} for call ${callId}`);
      await Promise.all([
        query(`INSERT INTO transcripts (call_id, speaker, text) VALUES ($1, 'AI', $2)`, [callId, vmMsg]),
        query(`UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = $2 WHERE id = $1`,
              [callId, vmPhone ? 'voicemail_left' : 'voicemail']),
      ]);
      emitCallStatus(callId, 'ENDED');
      if (orchestrator) activeOrchestrators.delete(callId);
      reply.type('text/xml').send(
        vmPhone
          ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="3"/>
  <Say voice="${langConfig.ttsVoice}">${escapeXml(vmMsg)}</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`
          : `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
      );
      return;
    }

    const recentFailures = previousActions.filter(a => !a.success).map(a => `${a.action}(${a.value})`);
    const userInfoObj = userRowData ? { name: (userRowData as any).name ?? undefined, birthday: (userRowData as any).birthday ?? undefined } : undefined;

    const recentTranscriptText = transcripts.slice(-5).map(t => t.text).join(' ');
    const availableMenuKeys = extractMenuKeys(recentTranscriptText);

    // Loop/stuck streaks (shared with the orchestrator's prefetch so both see the same signals)
    const { consecutiveWaits, consecutiveSameKey, consecutiveSamePhrase } = computeActionStreaks(previousActions);

    // Is the IVR queuing us for a human right now? On hold, waiting is correct — see buildContextMessage.
    const onHold = !!spokenText && isOnHold(spokenText);

    // Short-circuit: if waited 3+ times with NO speech, skip LLM — return fresh Gather
    // Only when spokenText is empty — if IVR said something, always call LLM to respond
    if (consecutiveWaits >= 3 && !spokenText) {
      console.log(`[Gather] ${consecutiveWaits} consecutive waits w/ no speech — skipping LLM, returning Gather`);
      const gatherUrl = `${config.app.webhookBaseUrl}/webhooks/twilio/gather?callId=${callId}`;
      reply.type('text/xml').send(buildGatherTwiML(gatherUrl));
      return;
    }

    // Short-circuit: max navigation attempts reached — give up gracefully
    const totalActionsRow = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM action_history WHERE call_id = $1`,
      [callId]
    );
    const totalActions = parseInt(totalActionsRow[0]?.count ?? '0', 10);

    // Transition to EXPLORATION after 8 actions stuck in IVR_NAVIGATION
    if (callStatus === 'IVR_NAVIGATION' && totalActions >= 8 && orchestrator) {
      await orchestrator.startExploration();
    }

    // Re-read status in case startExploration just changed it
    const currentStatus: CallStatus = (orchestrator?.getStatus() ?? callStatus) as CallStatus;

    if (totalActions >= 20) {
      console.log(`[Gather] Max navigation attempts (${totalActions}) reached for call ${callId} — ending call`);
      await query(
        `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'max_attempts' WHERE id = $1`,
        [callId]
      );
      emitCallStatus(callId, 'ENDED');
      activeOrchestrators.delete(callId);
      reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${langConfig.ttsVoice}">We were unable to reach a representative after multiple attempts. Please try again later.</Say>
  <Hangup/>
</Response>`);
      return;
    }


    const context: CallContext = {
      callId,
      company,
      phoneNumber: '',
      goal,
      currentTranscript: fullTranscript || spokenText,
      historicalMemory: memories ?? [],
      currentCallState: currentStatus,
      previousActions,
      recentFailures,
      userInfo: userInfoObj,
      language: (userRowData as any)?.language ?? 'en',
      recentHumanConfidences,
      speakerChanged: orchestrator?.getSpeakerChanged() ?? false,
      availableMenuKeys: availableMenuKeys.length > 0 ? availableMenuKeys : undefined,
      companyIvrNotes: companyIvrNotes ?? undefined,
      userCompanyNote: userCompanyNote ?? undefined,
      currentIvrUtterance: spokenText || undefined,
      onHold,
      consecutiveWaits,
      consecutiveSameKey,
      consecutiveSamePhrase,
      audioAnalysis: orchestrator?.getAudioAnalysis() ?? null,
      ivrDecisionTree: ivrDecisionTree.length > 0 ? ivrDecisionTree : undefined,
      consecutiveLowConfidence: lowConf > 0 ? lowConf : undefined,
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

      // Lower detection threshold if a transfer was just announced or hold music is playing
      const TRANSFER_PHRASES = [
        'transferring you', 'connecting you', 'let me transfer', "i'll transfer",
        'one moment while i connect', 'connect you to', 'i would like to connect you',
        'let me connect you', 'i will connect you', 'transfer you to',
        // Hold phrases that precede a human pickup
        'moment please', 'thank you for holding', 'thank you for your patience',
        'please continue to hold', 'your call is very important',
        'next available', 'all right one moment', 'all right 1 moment',
      ];
      const recentIvrText = transcripts.slice(-4).map(t => t.text).join(' ').toLowerCase();
      const matchedPhrase = TRANSFER_PHRASES.find(p => recentIvrText.includes(p));
      const transferPending = !!matchedPhrase;
      const humanThreshold = transferPending ? 0.35 : 0.75;

      // Comprehensive per-turn reliability log — all signals in one line for easy grep
      const audio = context.audioAnalysis;
      const humanConf = action.humanConfidence ?? 0;
      console.log(
        `[Gather:SIGNALS] call=${callId.slice(0, 8)}` +
        ` | speech="${(spokenText ?? '').slice(0, 60).replace(/\n/g, ' ')}"` +
        ` | audio: frames=${audio?.framesAnalyzed ?? 0} conf=${audio ? Math.round(audio.confidence * 100) + '%' : 'N/A'} human=${audio?.isHuman ? 'Y' : 'N'} ring=${audio?.postRingPickup ? 'Y' : 'N'}` +
        ` | transfer: pending=${transferPending ? 'Y' : 'N'}${matchedPhrase ? ` phrase="${matchedPhrase}"` : ''} threshold=${humanThreshold}` +
        ` | llm: human_conf=${Math.round(humanConf * 100)}% action=${action.action}(${action.value ?? ''}) latency=${action.latencyMs ?? '?'}ms` +
        ` | speaker_changed=${orchestrator?.getSpeakerChanged() ? 'Y' : 'N'}`
      );

      const humanDetected = (action.isHuman || action.action === 'escalate_to_user') && humanConf >= humanThreshold;
      if (humanDetected) {
        console.log(`[Gather] Human detected! isHuman=${action.isHuman} action=${action.action} confidence=${humanConf}`);

        await query(
          `UPDATE calls SET status = 'HUMAN_DETECTED', human_reached = true,
           wait_duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER
           WHERE id = $1`,
          [callId]
        );
        emitCallStatus(callId, 'HUMAN_DETECTED');

        const conferenceName = `conf-${callId}`;

        // Fire bridge in background — don't block the TwiML response
        if (orchestrator) {
          orchestrator.onHumanDetected(conferenceName).catch(console.error);
        }

        // Put representative in a conference room with hold music while user is called.
        // Natural, first-person greeting + the user's name so the agent doesn't think it's a
        // robocall and hang up. Escape the dynamic name for the inline TwiML.
        const bridgeMsg = langConfig.humanBridgeMessage(context.userInfo?.name)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${langConfig.ttsVoice}">${bridgeMsg}</Say>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical">${conferenceName}</Conference>
  </Dial>
</Response>`);
        return;
      }

      // Confidence tracking — count consecutive low-confidence turns
      const newLowConf = (action.confidence ?? 0.5) < 0.45 ? lowConf + 1 : 0;
      if (newLowConf > 0) console.log(`[Gather] Low confidence turn ${newLowConf}/3 (conf=${action.confidence?.toFixed(2)})`);

      if (newLowConf >= 3) {
        if (currentStatus === 'IVR_NAVIGATION' && orchestrator) {
          // Confidence collapsed — jump to EXPLORATION without waiting for 8-action threshold
          console.log(`[Gather] 3 consecutive low-confidence turns — triggering EXPLORATION early`);
          await orchestrator.startExploration();
        } else if (currentStatus === 'EXPLORATION') {
          // Already exploring and still lost — give up
          console.log(`[Gather] Low confidence in EXPLORATION — ending call`);
          await query(
            `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'low_confidence' WHERE id = $1`,
            [callId]
          );
          emitCallStatus(callId, 'ENDED');
          activeOrchestrators.delete(callId);
          reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${langConfig.ttsVoice}">We were unable to navigate to a representative. Please try calling again later.</Say>
  <Hangup/>
</Response>`);
          return;
        }
      }

      const lowConfParam = newLowConf > 0 ? `&lowConf=${newLowConf}` : '';
      const gatherUrl = `${config.app.webhookBaseUrl}/webhooks/twilio/gather?callId=${callId}${lowConfParam}`;

      // escalate_to_user with low confidence means LLM is uncertain — don't hang up, just wait
      const safeAction = (action.action === 'escalate_to_user' && humanConf < 0.75) ? 'wait' : action.action;
      const safeValue  = safeAction === 'wait' ? '3' : action.value;
      if (safeAction !== action.action) {
        console.log(`[Gather] escalate_to_user downgraded to wait (humanConf=${humanConf.toFixed(2)} < 0.75)`);
      }

      logDebug(callId, 'llm_decision', {
        action: safeAction,
        value: safeValue ?? null,
        original_action: safeAction !== action.action ? action.action : null,
        reasoning: action.reasoning,
        confidence: action.confidence ?? null,
        is_human: action.isHuman ?? false,
        human_confidence: action.humanConfidence ?? null,
        ended_reason: action.endedReason ?? null,
        decision_source: prefetched ? 'prefetch' : 'fresh',
        latency_ms: action.latencyMs ?? null,
        state: currentStatus,
        ivr_utterance: spokenText || null,
        consecutive_waits: consecutiveWaits,
        consecutive_same_key: consecutiveSameKey ?? null,
        consecutive_same_phrase: consecutiveSamePhrase ?? null,
        consecutive_low_confidence: lowConf > 0 ? lowConf : null,
        available_menu_keys: availableMenuKeys.length > 0 ? availableMenuKeys : null,
        speaker_changed: orchestrator?.getSpeakerChanged() ?? false,
        recent_human_confidences: recentHumanConfidences.slice(-5),
        transfer_pending: transferPending,
        human_threshold: humanThreshold,
        total_actions_so_far: totalActions,
        downgraded: safeAction !== action.action,
        low_conf_counter_new: newLowConf,
        audio_frames: context.audioAnalysis?.framesAnalyzed ?? null,
        audio_confidence: context.audioAnalysis?.confidence ?? null,
        audio_is_human: context.audioAnalysis?.isHuman ?? null,
        audio_post_ring_pickup: context.audioAnalysis?.postRingPickup ?? null,
        audio_rms_variance: context.audioAnalysis?.rmsVariance ?? null,
        audio_pitch_variance: context.audioAnalysis?.pitchVariance ?? null,
        audio_has_disfluencies: context.audioAnalysis?.hasDisfluencies ?? null,
      });

      // Save AI action as transcript entry using the ACTUAL executed action (safeAction)
      const al = langConfig.actionLabels;
      const actionText = safeAction === 'say_phrase'        ? safeValue ?? ''
                       : safeAction === 'press_key'         ? al.pressKey(safeValue ?? '')
                       : safeAction === 'wait'              ? al.wait(safeValue ?? '')
                       : safeAction === 'end_call'          ? al.endCall
                       : safeAction === 'escalate_to_user'  ? al.escalate
                       : `[${safeAction}]`;
      await query(
        `INSERT INTO transcripts (call_id, speaker, text) VALUES ($1, 'AI', $2)`,
        [callId, actionText]
      );

      // When LLM ends the call, use LLM's own ended_reason first (scalable),
      // then fall back to regex for cases LLM may miss.
      if (safeAction === 'end_call') {
        const llmReason = action.endedReason ?? null;
        const recentText = transcripts.slice(-5).map(t => t.text).join(' ');
        const regexReason = !llmReason
          ? (isVoicemailGreeting(recentText)       ? 'voicemail'
            : isOutsideBusinessHours(recentText)   ? 'outside_hours'
            : isInvalidOrDisconnected(recentText)  ? 'invalid_number'
            : null)
          : null;
        const endReason = llmReason ?? regexReason;
        if (endReason) {
          await query(
            `UPDATE calls SET ended_reason = $1 WHERE id = $2 AND ended_reason IS NULL`,
            [endReason, callId]
          );
          console.log(`[Gather] end_call reason='${endReason}' (source: ${llmReason ? 'LLM' : 'regex'}) for call ${callId}`);
        }
      }

      twiml = buildActionTwiML(safeAction, safeValue, gatherUrl, langConfig.ttsVoice);
    } catch (err) {
      console.error('[Gather] LLM error:', err);
      const retries = parseInt((query_params.retries ?? '0'), 10);
      if (retries >= 4) {
        // 3 consecutive LLM failures — end the call rather than loop forever
        await query(
          `UPDATE calls SET status = 'ENDED', ended_at = NOW(), ended_reason = 'llm_error' WHERE id = $1`,
          [callId]
        );
        emitCallStatus(callId, 'ENDED');
        activeOrchestrators.delete(callId);
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${langConfig.ttsVoice}">Sorry, we encountered a technical issue. Please try again later.</Say>
  <Hangup/>
</Response>`;
      } else {
        const gatherUrl = `${config.app.webhookBaseUrl}/webhooks/twilio/gather?callId=${callId}&retries=${retries + 1}&lowConf=${lowConf}`;
        twiml = buildGatherTwiML(gatherUrl);
      }
    }

    reply.type('text/xml').send(twiml);
  });
};

function buildActionTwiML(action: string, value: string | undefined, gatherUrl: string, voice = 'Google.en-US-Chirp3-HD-Fenrir'): string {
  let innerXml = '';

  switch (action) {
    case 'press_key':
      // 'w' adds a 500ms pause after the digit for cleaner IVR recognition
      innerXml = `<Pause length="1"/><Play digits="w${value ?? '0'}w"/>`;
      break;
    case 'say_phrase':
      innerXml = `<Say voice="${voice}">${escapeXml(value ?? 'representative')}</Say>`;
      break;
    case 'wait': {
      const rawSecs = parseInt(value ?? '3', 10);
      const cappedSecs = isNaN(rawSecs) ? 3 : Math.min(Math.max(rawSecs, 1), 8);
      // Pause INSIDE the Gather so we keep listening while waiting
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="8" speechTimeout="1" action="${gatherUrl}" method="POST">
    <Pause length="${cappedSecs}"/>
  </Gather>
  <Redirect method="POST">${gatherUrl}</Redirect>
</Response>`;
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
  <Gather input="speech dtmf" timeout="8" speechTimeout="1" action="${gatherUrl}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Redirect method="POST">${gatherUrl}</Redirect>
</Response>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildGatherTwiML(gatherUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="8" speechTimeout="1" action="${gatherUrl}" method="POST">
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
