import OpenAI from 'openai';
import { config } from '../config';
import { LLMAction, CallContext, ActionRecord, MemoryPattern, UserInfo } from '../types';
import { query } from '../db/client';
import { getLang } from '../languages';

const openai = new OpenAI({
  apiKey: config.openai.apiKey!,
});

const SYSTEM_PROMPT = `You are an adaptive customer service navigation agent.

Your PRIMARY task on EVERY turn is to determine if you are now speaking with a LIVE HUMAN (not an automated IVR/TTS system).

Humans say things like:
- Greetings with their name: "This is Sharma.", "Hi, this is John."
- Questions directed at you: "Who is this?", "Who's calling?", "How may I help you?"
- Casual conversation: "Hello, how are you?", "Yeah?"
- Commands or reactions: "Stop pressing keys!", "Hey, what's going on?"
- Disfluencies: "Um...", "Uh...", "Let me check..."
- Anything expressing confusion, frustration, or natural conversational cadence

IVR systems say things like:
- "Thank you for calling [Company]..."
- "Please press 1 for...", "For billing, press 2..."
- "Your estimated wait time is..."
- "This call may be recorded..."
- "Please say or enter your account number..."
- They speak in unnaturally smooth, consistent sentences with no disfluencies.

You must respond with ONLY valid JSON in this exact format:
{
  "is_human": <true|false>,
  "human_confidence": <0.0-1.0>,
  "action": "<action_type>",
  "value": "<value_if_applicable>",
  "ended_reason": "<reason_if_ending>",
  "reasoning": "<brief explanation>",
  "confidence": <0.0-1.0>
}

If is_human is true, set action to "escalate_to_user" and human_confidence >= 0.7.

Available actions:
- press_key: Press a DTMF key (value: "0"-"9", "*", "#")
- say_phrase: Speak a phrase (value: the phrase to say)
- wait: Wait for more audio (value: seconds as string, e.g. "5")
- retry: Restart navigation attempt
- end_call: Give up and end this call — MUST set ended_reason (see below)
- escalate_to_user: Human detected — stop navigating

When action is "end_call", set ended_reason to ONE of:
- "outside_hours"     — office/representatives closed or not on duty
- "voicemail"         — call went to voicemail, did not leave message
- "voicemail_left"    — left a voicemail on their behalf
- "callback_offered"  — IVR offered a callback option
- "busy"              — line was busy
- "no-answer"         — rang but nobody answered
- "invalid_number"    — number disconnected or invalid
- "no_human_path"     — navigated extensively but no path to a human exists
- "failed"            — technical error or unknown reason

IVR navigation principles:
1. Prioritize historically successful paths (high success_rate)
2. "0" or "say representative" often escalates to human agents
3. If stuck in a loop, try a different approach
4. If hold music plays, use the wait action

After a transfer announcement ("transferring you", "connecting you to an agent", "one moment while I connect you"), the next person who speaks is likely a live human. A brief wait of 2-3 seconds max is appropriate — do not wait longer than 3 seconds when a transfer was just announced.

TERMINAL SIGNALS — use end_call IMMEDIATELY when you detect any of these, regardless of what you've tried:
- No agents available: "representatives aren't on duty", "no agents available", "our office is closed", "outside of business hours", "closed for the evening/weekend", "not currently on duty", "unavailable at this time"
- Voicemail: "leave a message after the tone/beep", "you've reached voicemail", "unable to take your call"
- Invalid number: "this number is not in service", "disconnected", "no longer in service"
- Busy / no answer signals confirmed by IVR

These are DEAD ENDS — do not retry, do not wait, do not try a different phrase. End immediately.
The above list is illustrative, not exhaustive — use judgment for similar signals you haven't seen before.`;

export async function decideLLMAction(context: CallContext, dryRun = false): Promise<LLMAction> {
  const userMessage = buildContextMessage(context);
  const langConfig = getLang(context.language);

  const RETRY_DELAYS = [0, 1000, 3000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (RETRY_DELAYS[attempt] > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    try {
      const llmStart = Date.now();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 320,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: langConfig.systemPrompt },
          { role: 'user',   content: userMessage },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      const action = parseAction(text);
      action.latencyMs = Date.now() - llmStart;
      if (!dryRun) await persistAction(context.callId, action);
      return action;
    } catch (err: any) {
      lastErr = err;
      const isTransient = (err?.status === 503) ||
        (err?.status === 429 && err?.error?.type !== 'insufficient_quota');
      if (!isTransient) throw err;
      console.warn(`[LLM:RETRY] call=${context.callId.slice(0,8)} attempt=${attempt + 1} status=${err.status} — retrying in ${RETRY_DELAYS[attempt + 1] ?? 0}ms`);
    }
  }
  throw lastErr;
}

function buildContextMessage(ctx: CallContext): string {
  const recentActions = ctx.previousActions.slice(-10).map(formatAction).join('\n');
  const topMemories = ctx.historicalMemory
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 3)
    .map(formatMemory)
    .join('\n');

  const userInfoBlock = ctx.userInfo && (ctx.userInfo.name || ctx.userInfo.birthday || ctx.userInfo.phoneNumber)
    ? `\n⚡ USER INFO — USE THIS PROACTIVELY to answer IVR questions. Do NOT wait to be asked twice.
${ctx.userInfo.name ? `  Name: ${ctx.userInfo.name}` : ''}
${ctx.userInfo.birthday ? `  Date of birth: ${ctx.userInfo.birthday}` : ''}
${ctx.userInfo.phoneNumber ? `  Callback phone: ${ctx.userInfo.phoneNumber} ← say this if IVR asks for a callback number` : ''}`.trim()
    : '';

  const confidenceHistory = ctx.recentHumanConfidences && ctx.recentHumanConfidences.length > 0
    ? ctx.recentHumanConfidences.map(c => `${Math.round(c * 100)}%`).join(', ')
    : null;

  const avgPastConfidence = confidenceHistory && ctx.recentHumanConfidences!.length > 1
    ? ctx.recentHumanConfidences!.slice(0, -1).reduce((a, b) => a + b, 0) / (ctx.recentHumanConfidences!.length - 1)
    : null;

  // Detect undeniable human signals in the current utterance — override all history
  const undeniableSignal = (() => {
    const t = ctx.currentIvrUtterance ?? '';
    if (/\bmy name is\b.{1,50}(may i|can i|could i).{0,20}(your name|name)\b/i.test(t))
      return 'name intro + asking for caller\'s name';
    if (/\byou'?ve reached\b.{2,60}\bat\b.{2,40}(how can i|what can i|how may i)\b/i.test(t))
      return 'name + company intro + help offer';
    if (/\b(you'?re|you are) (currently )?speaking (to|with) (a |the )?(live |human )?(representative|rep|agent)\b/i.test(t))
      return 'explicit statement: speaking to a representative';
    if (/\b(may i|can i|could i) (have|get) your (full |first )?name\b/i.test(t))
      return 'agent asking for caller\'s name';
    if (/\bwho (am i|are you) speaking (with|to)\b/i.test(t))
      return 'agent asking who they\'re speaking with';
    if (/\bmy name is\b.{1,30}(,|\.) (how can i|what can i|how may i)\b/i.test(t))
      return 'name intro + help offer';
    return null;
  })();

  if (undeniableSignal) {
    console.log(`[LLM:UNDENIABLE] call=${ctx.callId.slice(0,8)} signal="${undeniableSignal}" utterance="${(ctx.currentIvrUtterance ?? '').slice(0,80)}"`);
  }

  const humanOverrideBlock = undeniableSignal
    ? `\n🚨🚨🚨 MANDATORY OVERRIDE — LIVE HUMAN DETECTED 🚨🚨🚨
Current utterance matches: "${undeniableSignal}"
This pattern is produced ONLY by live human agents, NOT automated IVR/TTS systems.
Previous low-confidence history is IRRELEVANT — IVRs don't ask for your name or introduce themselves with a real name + role.
You MUST respond with: is_human=true, human_confidence=0.95, action="escalate_to_user"
Do NOT speak. Do NOT answer their question. Escalate immediately.`
    : '';

  const consistencyWarning = ctx.speakerChanged
    ? `🔔 SPEAKER CHANGE DETECTED: Deepgram detected a NEW VOICE. Strong signal of a human agent. Set is_human=true with high confidence.`
    : avgPastConfidence !== null && avgPastConfidence < 0.2
    ? `📋 VOICE HISTORY: Previous ${ctx.recentHumanConfidences!.length - 1} turns had low human confidence (avg ${Math.round(avgPastConfidence * 100)}%). Likely still in IVR — but DO NOT ignore these clear human signals if you see them:
- Person states their own name ("My name is Sean", "This is Josie")
- Person asks for YOUR name ("May I have your name?", "Who is calling?", "Who am I speaking with?")
- Person says "you're speaking to a representative/agent"
- Person reacts with confusion to your keypresses
These OVERRIDE the history. Conversational phrasing alone ("Of course", "How can I help?") is NOT sufficient — modern AI IVRs say these too. But name introductions + asking for caller info are ALWAYS human.`
    : '';

  const menuKeysBlock = ctx.availableMenuKeys && ctx.availableMenuKeys.length > 0
    ? `\n⛔ VALID MENU KEYS RIGHT NOW: [${ctx.availableMenuKeys.join(', ')}] — ONLY press these keys. Do NOT press any other key.`
    : '';

  const waitWarning = ctx.consecutiveWaits && ctx.consecutiveWaits >= 2
    ? `\n🚨 WAIT LIMIT: You have waited ${ctx.consecutiveWaits} times in a row. The IVR is likely waiting for YOUR response. You MUST take a non-wait action this turn. Answer the last question or try press_key("0") to escalate.`
    : '';

  const sameKeyWarning = ctx.consecutiveSameKey
    ? `\n🚨 DTMF STUCK: You pressed key "${ctx.consecutiveSameKey.key}" ${ctx.consecutiveSameKey.count} times and the IVR still said "didn't get that". This IVR does NOT accept DTMF for this question — it only accepts voice. Switch to say_phrase("yes") or say_phrase("no") immediately. Do NOT press this key again.`
    : '';

  const samePhraseWarning = ctx.consecutiveSamePhrase && ctx.consecutiveSamePhrase.count >= 2
    ? `\n🚨 PHRASE LOOP (${ctx.consecutiveSamePhrase.count}x): You have said "${ctx.consecutiveSamePhrase.phrase}" ${ctx.consecutiveSamePhrase.count} times in a row. The IVR is NOT routing you to a human with this phrase — it is keeping you in the conversation. You MUST try a completely different strategy this turn:
  - Try press_key("0") to force operator transfer
  - Try say_phrase("speak to a representative")
  - Try say_phrase("agent")
  - Try say_phrase("human")
  Do NOT repeat the same phrase again.`
    : '';

  const lowConfWarning = ctx.consecutiveLowConfidence && ctx.consecutiveLowConfidence >= 2
    ? `\n⚠️ LOW CONFIDENCE (${ctx.consecutiveLowConfidence} turns): You have been uncertain for multiple turns. Pick a decisive action this turn — press "0", say "representative", or try a completely different key. Do NOT wait or retry. Your next action must have confidence >= 0.6.`
    : '';

  const explorationBlock = ctx.currentCallState === 'EXPLORATION'
    ? `\n🔍 EXPLORATION MODE — Standard menu paths exhausted. Try unconventional approaches:
  - Press "0" repeatedly to force an operator transfer
  - Try "#" or "*" to return to main menu, then take a different path
  - Say "operator", "agent", "representative", or "help"
  - If the IVR offers a callback option, consider accepting it (say "yes")
  - Try any untried numeric keys from the main menu
  You MUST try something different from your previous actions.`
    : '';

  const ivrNotesBlock = ctx.companyIvrNotes
    ? `\n📋 PRIOR CALL NOTES FOR ${ctx.company.toUpperCase()} (learn from these):\n${ctx.companyIvrNotes}`
    : '';

  const userNoteBlock = ctx.userCompanyNote
    ? `\n💬 USER TIP FOR ${ctx.company.toUpperCase()}:\n"${ctx.userCompanyNote}"\n← Follow this hint — the user learned it from a previous call.`
    : '';

  const patternBlock = ctx.ivrDecisionTree && ctx.ivrDecisionTree.length > 0
    ? (() => {
        // Group nodes by IVR utterance to build a readable decision tree
        const byIvr = new Map<string, typeof ctx.ivrDecisionTree>();
        for (const node of ctx.ivrDecisionTree!) {
          if (!byIvr.has(node.ivrText)) byIvr.set(node.ivrText, []);
          byIvr.get(node.ivrText)!.push(node);
        }
        const lines: string[] = [];
        for (const [ivrText, nodes] of byIvr) {
          lines.push(`  IVR: "${ivrText.slice(0, 80)}${ivrText.length > 80 ? '...' : ''}"`);
          for (const n of nodes) {
            const action = n.action === 'press_key'  ? `press [${n.value}]`
                         : n.action === 'say_phrase' ? `say "${n.value}"`
                         : n.action === 'wait'       ? `wait ${n.value}s`
                         : n.action;
            const icon   = n.successPct >= 60 ? '✅' : n.successPct >= 30 ? '⚠️' : '❌';
            const avoid  = n.successPct < 30 && n.callsTotal >= 3 ? ' — AVOID' : '';
            lines.push(`    → ${action}: ${icon} ${n.successPct}% (${n.callsSuccess}/${n.callsTotal} calls)${avoid}`);
          }
        }
        return `\n📊 IVR DECISION TREE FOR ${ctx.company.toUpperCase()} (learned from past calls):\n${lines.join('\n')}`;
      })()
    : '';

  const ringToneBlock = ctx.audioAnalysis?.postRingPickup
    ? `\n🔔 TRANSFER RING DETECTED: Ring-back tones (嘟嘟嘟) were heard in the audio stream before this utterance, then someone picked up. An IVR never rings before speaking — this is a LIVE HUMAN AGENT answering the phone. Set is_human=true with confidence >= 0.95 and action=escalate_to_user.`
    : '';

  const audioBlock = ctx.audioAnalysis && ctx.audioAnalysis.framesAnalyzed >= 10
    ? (() => {
        const a = ctx.audioAnalysis!;
        const signal = a.confidence >= 0.75 ? '🔴 STRONG HUMAN SIGNAL'
                     : a.confidence >= 0.55 ? '🟡 POSSIBLE HUMAN SIGNAL'
                     : '🟢 LIKELY IVR/TTS';
        return `\n🔊 AUDIO ANALYSIS (${a.framesAnalyzed} frames of live audio):
  ${signal} — audio confidence: ${(a.confidence * 100).toFixed(0)}%
  Voice naturalness (RMS variance): ${a.rmsVariance.toFixed(0)} ${a.rmsVariance > 2000000 ? '← HIGH (human-like)' : '← LOW (smooth/TTS-like)'}
  Pitch variation: ${a.pitchVariance.toFixed(2)} ${a.pitchVariance > 0.65 ? '← HIGH (human-like)' : '← LOW (TTS-like)'}${a.hasDisfluencies ? '\n  ✓ Disfluencies detected (um/uh) — strong human signal' : ''}
  Use this alongside the transcript — audio does not lie, transcript can be misheard.`;
      })()
    : '';

  const utteranceBlock = ctx.currentIvrUtterance
    ? `\n🎙 IVR JUST SAID (respond to THIS):\n"${ctx.currentIvrUtterance}"${humanOverrideBlock}`
    : `\n🎙 IVR JUST SAID: (nothing — IVR is processing your last action. Use wait.)`;

  return `COMPANY: ${ctx.company}
GOAL: ${ctx.goal}
CURRENT STATE: ${ctx.currentCallState}
${userInfoBlock}
${menuKeysBlock}
${waitWarning}
${sameKeyWarning}
${samePhraseWarning}
${lowConfWarning}
${explorationBlock}
${userNoteBlock}
${patternBlock}
${ringToneBlock}
${audioBlock}
${utteranceBlock}

CONVERSATION HISTORY (last 500 chars):
${ctx.currentTranscript.slice(-500)}

HUMAN CONFIDENCE HISTORY (most recent last):
${confidenceHistory ?? 'No history yet.'}
${consistencyWarning}

HISTORICAL SUCCESSFUL PATHS:
${topMemories || 'No history available — explore freely.'}
${ivrNotesBlock}

RECENT ACTIONS THIS CALL:
${recentActions || 'None yet.'}

RECENT FAILURES:
${ctx.recentFailures.slice(-5).join('\n') || 'None.'}

What is your next action?`;
}

function formatAction(a: ActionRecord): string {
  const status = a.success ? '✓' : '✗';
  return `${status} ${a.action}${a.value ? `(${a.value})` : ''}`;
}

function formatMemory(m: MemoryPattern): string {
  const waitStr = m.avgWaitSeconds
    ? m.avgWaitSeconds < 60 ? `${m.avgWaitSeconds}s` : `${(m.avgWaitSeconds / 60).toFixed(1)}min`
    : 'unknown';
  const speedTag = m.avgWaitSeconds
    ? m.avgWaitSeconds <= 60 ? '⚡fast' : m.avgWaitSeconds <= 180 ? '🕐medium' : '🐢slow'
    : '';
  return `[score:${m.strategyScore.toFixed(2)}] ${m.path.join(' → ')} | ${(m.successRate * 100).toFixed(0)}% success | ${waitStr} wait ${speedTag}`;
}

function parseAction(text: string): LLMAction {
  const stripped = text.replace(/```json\n?|\n?```/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn(`[LLM] No JSON in response, defaulting to wait. Raw: ${text.slice(0, 200)}`);
    return { action: 'wait', value: '4', reasoning: 'parse_fallback', confidence: 0.5, isHuman: false, humanConfidence: 0 };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.warn(`[LLM] JSON parse failed, defaulting to wait. Raw: ${text.slice(0, 200)}`);
    return { action: 'wait', value: '4', reasoning: 'parse_fallback', confidence: 0.5, isHuman: false, humanConfidence: 0 };
  }

  const validActions = ['press_key', 'say_phrase', 'wait', 'retry', 'end_call', 'escalate_to_user'];
  if (!validActions.includes(parsed.action)) {
    console.warn(`[LLM] Invalid action "${parsed.action}", defaulting to wait`);
    return { action: 'wait', value: '4', reasoning: 'invalid_action_fallback', confidence: 0.5, isHuman: false, humanConfidence: 0 };
  }

  return {
    action: parsed.action,
    value: parsed.value,
    endedReason: parsed.ended_reason ?? undefined,
    reasoning: parsed.reasoning ?? '',
    confidence: parsed.confidence > 0 ? parsed.confidence : 0.5,
    isHuman: parsed.is_human ?? false,
    humanConfidence: parsed.human_confidence ?? 0.0,
  };
}

async function persistAction(callId: string, action: LLMAction): Promise<void> {
  await query(
    `INSERT INTO action_history (call_id, action, value, reasoning, success) VALUES ($1, $2, $3, $4, true)`,
    [callId, action.action, action.value ?? null, action.reasoning]
  );
}
