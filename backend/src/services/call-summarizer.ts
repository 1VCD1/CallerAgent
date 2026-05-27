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

  const transcripts = await query<{ speaker: string; text: string }>(
    `SELECT speaker, text FROM transcripts WHERE call_id = $1 ORDER BY timestamp ASC`,
    [callId]
  );
  if (transcripts.length === 0) return;

  const transcript = transcripts
    .map(t => `[${t.speaker}] ${t.text}`)
    .join('\n');

  const outcome = status === 'HUMAN_DETECTED' || status === 'BRIDGED'
    ? 'human_reached'
    : ended_reason ?? 'failed';

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 512,
    messages: [
      {
        role: 'system',
        content: `You analyze phone call transcripts to extract IVR navigation knowledge. Be concise and factual.`,
      },
      {
        role: 'user',
        content: `Company: ${company}
Goal: ${goal}
Outcome: ${outcome}

Transcript:
${transcript}

Write a concise IVR navigation note (3-6 bullet points) covering:
- What the IVR asked / menu structure observed
- What worked (if human was reached)
- What didn't work (if failed)
- Any timing info (outside hours, hold times)
- Best approach for next time

Format: plain bullet points starting with "-". No headers.`,
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

Synthesize both into an updated knowledge base (5-8 bullet points max).
- Merge duplicate observations
- Keep what's still relevant, discard what's superseded
- Prioritize patterns seen across multiple calls
- Be specific about what works and what doesn't
- Note any IVR structure, verification requirements, or timing constraints

Format: plain bullet points starting with "-". No headers.`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? `${existing}\n${fresh}`;
}

export async function getCompanyIvrNotes(company: string): Promise<string | null> {
  const rows = await query<{ summary: string; outcome: string; updated_at: Date }>(
    `SELECT summary, outcome, updated_at FROM company_ivr_notes WHERE LOWER(company) = LOWER($1) ORDER BY updated_at DESC LIMIT 3`,
    [company]
  );
  if (rows.length === 0) return null;
  return rows.map(r => `[${r.outcome} — ${r.updated_at.toISOString().slice(0, 10)}]\n${r.summary}`).join('\n\n---\n\n');
}
