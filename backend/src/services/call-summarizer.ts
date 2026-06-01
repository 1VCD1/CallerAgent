import OpenAI from 'openai';
import { config } from '../config';
import { query } from '../db/client';

const openai = new OpenAI({ apiKey: config.openai.apiKey! });

export async function generateCallSummary(callId: string): Promise<void> {
  const callRow = await query<{ company: string; goal: string; status: string; ended_reason: string | null }>(
    `SELECT company, goal, status, ended_reason FROM calls WHERE id = $1`,
    [callId]
  );
  if (!callRow[0]) return;

  const { company, goal, status, ended_reason } = callRow[0];

  const [transcripts, debugEvents] = await Promise.all([
    query<{ speaker: string; text: string }>(
      `SELECT speaker, text FROM transcripts WHERE call_id = $1 ORDER BY timestamp ASC`,
      [callId]
    ),
    query<{ event_type: string; data: Record<string, any> }>(
      `SELECT event_type, data FROM call_debug_logs WHERE call_id = $1 ORDER BY timestamp ASC`,
      [callId]
    ),
  ]);

  if (transcripts.length === 0) return;

  const transcript = transcripts.map(t => `[${t.speaker}] ${t.text}`).join('\n');

  const outcome = status === 'HUMAN_DETECTED' || status === 'BRIDGED'
    ? 'human_reached'
    : ended_reason ?? 'failed';

  // Build structured failure analysis from debug logs
  const failureAnalysis = buildFailureAnalysis(debugEvents);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `You analyze phone call transcripts and AI decision data to extract precise, actionable IVR navigation knowledge. Focus on WHY things failed and WHAT to do differently next time. Be specific — quote actual IVR phrases and key sequences.`,
      },
      {
        role: 'user',
        content: `Company: ${company}
Goal: ${goal}
Outcome: ${outcome}

TRANSCRIPT:
${transcript}

AI DECISION ANALYSIS (from internal debug logs):
${failureAnalysis}

Write a concise IVR navigation note (4-7 bullet points) covering:
- Exact IVR menu structure observed (which key leads where)
- What failed and WHY (based on AI decision analysis — be specific about loops, wrong keys, missed callbacks)
- What to try differently next time (concrete key sequences or phrases)
- Any timing/availability info (outside hours, hold music patterns)
- If human was reached: the exact path that worked

Format: plain bullet points starting with "-". Be specific and actionable. Quote IVR phrases when relevant.`,
      },
    ],
  });

  const summary = response.choices[0]?.message?.content?.trim() ?? '';
  if (!summary) return;

  // Upsert: update existing note or insert new one for this company
  const existing = await query<{ id: string; summary: string }>(
    `SELECT id, summary FROM company_ivr_notes WHERE LOWER(company) = LOWER($1) ORDER BY updated_at DESC LIMIT 1`,
    [company]
  );

  if (existing[0]) {
    const consolidated = await consolidateNotes(existing[0].summary, summary, company);
    await query(
      `UPDATE company_ivr_notes SET summary = $1, outcome = $2, updated_at = NOW() WHERE id = $3`,
      [consolidated, outcome, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO company_ivr_notes (company, summary, outcome) VALUES ($1, $2, $3)`,
      [company, summary, outcome]
    );
  }

  console.log(`[Summarizer] Saved IVR note for ${company} (outcome: ${outcome})`);
}

function buildFailureAnalysis(debugEvents: { event_type: string; data: Record<string, any> }[]): string {
  const decisions  = debugEvents.filter(e => e.event_type === 'llm_decision').map(e => e.data);
  const detections = debugEvents.filter(e => e.event_type === 'human_detection').map(e => e.data);
  const summary    = debugEvents.find(e => e.event_type === 'call_summary')?.data;

  if (decisions.length === 0) return '(no AI decision data available)';

  const lines: string[] = [];

  // Decision sequence — give LLM a clear picture of what the AI did turn by turn
  lines.push('DECISION SEQUENCE:');
  decisions.forEach((d, i) => {
    const action = d.action === 'press_key'  ? `press [${d.value}]`
                 : d.action === 'say_phrase' ? `say "${d.value}"`
                 : d.action === 'wait'       ? `wait ${d.value}s`
                 : d.action === 'end_call'   ? `end_call (${d.ended_reason ?? 'unknown reason'})`
                 : d.action;
    const ivr     = d.ivr_utterance ? `IVR: "${d.ivr_utterance.slice(0, 80)}"` : 'IVR: (silent)';
    const keys    = d.available_menu_keys?.length ? ` [valid keys: ${d.available_menu_keys.join(',')}]` : '';
    const conf    = d.confidence != null ? ` conf:${(d.confidence * 100).toFixed(0)}%` : '';
    lines.push(`  Turn ${i + 1}: ${ivr}${keys} → AI: ${action}${conf} — ${d.reasoning?.slice(0, 100) ?? ''}`);
  });

  lines.push('');
  lines.push('FAILURE PATTERNS DETECTED:');

  // Phrase loops
  const phraseLoops = decisions.filter(d => d.consecutive_same_phrase?.count >= 2);
  if (phraseLoops.length) {
    const worst = phraseLoops.reduce((a, b) => a.consecutive_same_phrase.count > b.consecutive_same_phrase.count ? a : b);
    lines.push(`  ⚠ PHRASE LOOP: AI said "${worst.consecutive_same_phrase.phrase}" ${worst.consecutive_same_phrase.count} times with no result — this phrase does NOT work here`);
  }

  // DTMF stuck
  const dtmfStuck = decisions.filter(d => d.consecutive_same_key?.count >= 2);
  if (dtmfStuck.length) {
    const worst = dtmfStuck.reduce((a, b) => a.consecutive_same_key.count > b.consecutive_same_key.count ? a : b);
    lines.push(`  ⚠ DTMF STUCK: AI pressed [${worst.consecutive_same_key.key}] ${worst.consecutive_same_key.count} times — IVR may require voice input here, not DTMF`);
  }

  // Menu key misses
  const keyMisses = decisions.filter(d =>
    d.action === 'press_key' &&
    d.available_menu_keys?.length > 0 &&
    !d.available_menu_keys.includes(String(d.value))
  );
  if (keyMisses.length) {
    keyMisses.forEach(d => {
      lines.push(`  ⚠ WRONG KEY: AI pressed [${d.value}] but valid options were [${d.available_menu_keys.join(', ')}] — navigation went off-track`);
    });
  }

  // Escalation downgrades (AI thought it found a human but wasn't confident enough)
  const downgrades = decisions.filter(d => d.downgraded);
  if (downgrades.length) {
    lines.push(`  ⚠ NEAR-MISS ESCALATION: AI attempted to escalate ${downgrades.length} time(s) but was held back (human_confidence below threshold)`);
  }

  // Near-miss human detection (Deepgram path)
  const nearMiss = detections.filter(d => d.confidence >= 0.45 && d.confidence < 0.75);
  if (nearMiss.length) {
    nearMiss.forEach(d => {
      lines.push(`  ⚠ POSSIBLE HUMAN MISSED: "${(d.transcript ?? '').slice(0, 80)}" scored ${(d.confidence * 100).toFixed(0)}% human confidence (threshold 75%) — may be a natural-sounding IVR bot`);
    });
  }

  // Action breakdown
  if (summary?.actions_breakdown) {
    const breakdown = Object.entries(summary.actions_breakdown as Record<string, number>)
      .map(([a, c]) => `${a}×${c}`).join(', ');
    lines.push(`  Actions taken: ${breakdown} over ${decisions.length} turns`);
  }

  if (lines[lines.length - 1] === 'FAILURE PATTERNS DETECTED:') {
    lines.push('  (no specific failure patterns detected)');
  }

  return lines.join('\n');
}

async function consolidateNotes(existing: string, fresh: string, company: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `You consolidate IVR navigation knowledge. Synthesize old and new observations into a single updated knowledge base. Be concise, factual, and actionable.`,
      },
      {
        role: 'user',
        content: `Company: ${company}

EXISTING KNOWLEDGE:
${existing}

NEW OBSERVATION (just happened):
${fresh}

Synthesize into an updated knowledge base (5-8 bullet points max).
Rules:
- KEEP specific failure patterns (loops, wrong keys, voice-only menus) — these are critical
- UPGRADE vague observations to specific ones when the new data is more detailed
- PRIORITIZE patterns confirmed across multiple calls
- DISCARD only observations that are clearly superseded or contradicted
- Be concrete: quote key numbers, IVR phrases, and action sequences
- End with 1-2 bullets on "best approach for next call"

Format: plain bullet points starting with "-". No headers.`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? `${existing}\n${fresh}`;
}

// Called when user marks a human_reached call as a false positive.
// Generates a correction note so future calls to the same company avoid the same mistake.
export async function generateFeedbackCorrection(callId: string): Promise<void> {
  const callRow = await query<{ company: string; goal: string }>(
    `SELECT company, goal FROM calls WHERE id = $1`,
    [callId]
  );
  if (!callRow[0]) return;
  const { company, goal } = callRow[0];

  const transcripts = await query<{ speaker: string; text: string }>(
    `SELECT speaker, text FROM transcripts WHERE call_id = $1 ORDER BY timestamp ASC`,
    [callId]
  );
  if (transcripts.length === 0) return;

  const transcript = transcripts.map(t => `[${t.speaker}] ${t.text}`).join('\n');

  // Find the IVR utterance that likely triggered the false escalation
  const ivrLines = transcripts.filter(t => t.speaker === 'IVR');
  const lastIvr  = ivrLines[ivrLines.length - 1]?.text ?? '(unknown)';

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    messages: [
      {
        role: 'system',
        content: `You analyze phone call transcripts where an AI agent was tricked into thinking an IVR/automated system was a real human. Write a correction note so future calls avoid the same mistake.`,
      },
      {
        role: 'user',
        content: `Company: ${company}
Goal: ${goal}
Outcome: FALSE POSITIVE — user confirmed this was NOT a real human. The AI was fooled by a conversational IVR bot.

The phrase that most likely triggered the false detection:
"${lastIvr}"

Full transcript:
${transcript}

Write 2-4 bullet points covering:
- What the IVR said that sounded human but wasn't (be specific, quote the phrases)
- That this company uses a conversational AI bot (not a human) — name it if identifiable
- What signals should have indicated it was still automated
- How to avoid this mistake next time

Format: plain bullet points starting with "-". Be specific and direct.`,
      },
    ],
  });

  const correction = response.choices[0]?.message?.content?.trim() ?? '';
  if (!correction) return;

  const existing = await query<{ id: string; summary: string }>(
    `SELECT id, summary FROM company_ivr_notes WHERE LOWER(company) = LOWER($1) ORDER BY updated_at DESC LIMIT 1`,
    [company]
  );

  if (existing[0]) {
    const merged = await consolidateNotes(existing[0].summary, `⚠️ FALSE POSITIVE CORRECTION:\n${correction}`, company);
    await query(
      `UPDATE company_ivr_notes SET summary = $1, outcome = 'false_positive_corrected', updated_at = NOW() WHERE id = $2`,
      [merged, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO company_ivr_notes (company, summary, outcome) VALUES ($1, $2, 'false_positive_corrected')`,
      [company, `⚠️ FALSE POSITIVE CORRECTION:\n${correction}`]
    );
  }

  console.log(`[Summarizer] Saved false-positive correction for ${company}`);
}

export async function getCompanyIvrNotes(company: string): Promise<string | null> {
  const rows = await query<{ summary: string; outcome: string; updated_at: Date }>(
    `SELECT summary, outcome, updated_at FROM company_ivr_notes WHERE LOWER(company) = LOWER($1) ORDER BY updated_at DESC LIMIT 3`,
    [company]
  );
  if (rows.length === 0) return null;
  return rows.map(r => `[${r.outcome} — ${r.updated_at.toISOString().slice(0, 10)}]\n${r.summary}`).join('\n\n---\n\n');
}
