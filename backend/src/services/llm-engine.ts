import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { LLMAction, CallContext, ActionRecord, MemoryPattern, UserInfo } from '../types';
import { query } from '../db/client';
import { getLang } from '../languages';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
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
  "reasoning": "<brief explanation>",
  "confidence": <0.0-1.0>
}

If is_human is true, set action to "escalate_to_user" and human_confidence >= 0.7.

Available actions:
- press_key: Press a DTMF key (value: "0"-"9", "*", "#")
- say_phrase: Speak a phrase (value: the phrase to say)
- wait: Wait for more audio (value: seconds as string, e.g. "5")
- retry: Restart navigation attempt
- end_call: Give up and end this call
- escalate_to_user: Human detected — stop navigating

IVR navigation principles:
1. Prioritize historically successful paths (high success_rate)
2. "0" or "say representative" often escalates to human agents
3. If stuck in a loop, try a different approach
4. If hold music plays, use the wait action`;

export async function decideLLMAction(context: CallContext): Promise<LLMAction> {
  const userMessage = buildContextMessage(context);

  const langConfig = getLang(context.language);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 180,
    system: langConfig.systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected LLM response type');

  const action = parseAction(content.text);
  await persistAction(context.callId, action);
  return action;
}

function buildContextMessage(ctx: CallContext): string {
  const recentActions = ctx.previousActions.slice(-10).map(formatAction).join('\n');
  const topMemories = ctx.historicalMemory
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 3)
    .map(formatMemory)
    .join('\n');

  const userInfoBlock = ctx.userInfo && (ctx.userInfo.name || ctx.userInfo.birthday)
    ? `\n⚡ USER INFO — USE THIS PROACTIVELY to answer IVR questions. Do NOT wait to be asked twice.
${ctx.userInfo.name ? `  Name: ${ctx.userInfo.name}` : ''}
${ctx.userInfo.birthday ? `  Date of birth: ${ctx.userInfo.birthday}` : ''}`.trim()
    : '';

  const confidenceHistory = ctx.recentHumanConfidences && ctx.recentHumanConfidences.length > 0
    ? ctx.recentHumanConfidences.map(c => `${Math.round(c * 100)}%`).join(', ')
    : null;

  const avgPastConfidence = confidenceHistory && ctx.recentHumanConfidences!.length > 1
    ? ctx.recentHumanConfidences!.slice(0, -1).reduce((a, b) => a + b, 0) / (ctx.recentHumanConfidences!.length - 1)
    : null;

  const consistencyWarning = ctx.speakerChanged
    ? `🔔 SPEAKER CHANGE DETECTED: Deepgram's audio diarization has detected a NEW VOICE on the line. This is a strong signal that a human agent has joined the call. Set is_human=true with high confidence.`
    : avgPastConfidence !== null && avgPastConfidence < 0.2
    ? `⚠️  VOICE CONSISTENCY WARNING: The last ${ctx.recentHumanConfidences!.length - 1} turns all had low human confidence (avg ${Math.round(avgPastConfidence * 100)}%). The voice and rhythm have been consistent — almost certainly the same IVR. Do NOT flag as human unless there is a clear speaker change.`
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

  const ivrNotesBlock = ctx.companyIvrNotes
    ? `\n📋 PRIOR CALL NOTES FOR ${ctx.company.toUpperCase()} (learn from these):\n${ctx.companyIvrNotes}`
    : '';

  const utteranceBlock = ctx.currentIvrUtterance
    ? `\n🎙 IVR JUST SAID (respond to THIS):\n"${ctx.currentIvrUtterance}"`
    : `\n🎙 IVR JUST SAID: (nothing — IVR is processing your last action. Use wait.)`;

  return `COMPANY: ${ctx.company}
GOAL: ${ctx.goal}
CURRENT STATE: ${ctx.currentCallState}
${userInfoBlock}
${menuKeysBlock}
${waitWarning}
${sameKeyWarning}
${ivrNotesBlock}
${utteranceBlock}

CONVERSATION HISTORY (last 500 chars):
${ctx.currentTranscript.slice(-500)}

HUMAN CONFIDENCE HISTORY (most recent last):
${confidenceHistory ?? 'No history yet.'}
${consistencyWarning}

HISTORICAL SUCCESSFUL PATHS:
${topMemories || 'No history available — explore freely.'}

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
  return `Path: ${m.path.join(' → ')} | Success: ${(m.successRate * 100).toFixed(0)}% | Avg wait: ${m.avgWaitSeconds}s`;
}

function parseAction(text: string): LLMAction {
  const stripped = text.replace(/```json\n?|\n?```/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in LLM response');
  const parsed = JSON.parse(match[0]);

  const validActions = ['press_key', 'say_phrase', 'wait', 'retry', 'end_call', 'escalate_to_user'];
  if (!validActions.includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }

  return {
    action: parsed.action,
    value: parsed.value,
    reasoning: parsed.reasoning ?? '',
    confidence: parsed.confidence ?? 0.5,
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
