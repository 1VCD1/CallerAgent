import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/client';
import { decideLLMAction } from './llm-engine';
import { getMemoryPatterns, getIvrDecisionTree } from './memory';
import { config } from '../config';
import { CallContext, LLMAction } from '../types';
import {
  isOutsideBusinessHours,
  isWrongNumber,
  isVoicemailGreeting,
  isInvalidOrDisconnected,
  isCallbackOffer,
} from './human-detector';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// Default test user — real info so AI behaves like in production
const DEFAULT_TEST_USER = {
  name: 'Wayne Tang',
  phoneNumber: '+18582229375',
  birthday: undefined as string | undefined,
};

export interface TestScenario {
  id: string;
  name: string;
  company: string;
  goal: string;
  ivrPersona: string;
  expectedOutcome: string;
  hasHuman: boolean;
  maxTurns: number;
  tags: string[];
  phoneNumber?: string;  // IVR's actual phone number — used to load production memory
  userInfo?: { name?: string; phoneNumber?: string; birthday?: string };
  referenceCallIds?: string[];
}

interface TurnRecord {
  turn: number;
  role: 'IVR' | 'AI';
  text: string;
}

interface ScenarioResult {
  scenarioId: string;
  passed: boolean | null; // null = neutral (uncontrollable outcome)
  actualOutcome: string;
  expectedOutcome: string;
  turns: number;
  humanDetected: boolean;
  humanAppearedInIvr: boolean; // IVR simulator produced a [HUMAN] turn
  falsePositive: boolean;
  transcript: TurnRecord[];
  error?: string;
}

// Fetch transcripts for reference calls and format as few-shot examples
async function buildFewShotExamples(callIds: string[]): Promise<string> {
  if (!callIds.length) return '';
  const examples: string[] = [];
  for (const callId of callIds.slice(0, 4)) { // max 4 examples to keep context manageable
    const transcripts = await query<{ speaker: string; text: string }>(
      `SELECT speaker, text FROM transcripts WHERE call_id = $1 ORDER BY timestamp`,
      [callId]
    );
    const callRow = await queryOne<{ ended_reason: string | null; human_reached: boolean }>(
      `SELECT ended_reason, human_reached FROM calls WHERE id = $1`,
      [callId]
    );
    if (!transcripts.length) continue;
    const outcome = callRow?.human_reached ? 'human_reached' : (callRow?.ended_reason ?? 'unknown');
    const lines = transcripts.map(t =>
      `${t.speaker === 'AI' ? 'Caller' : t.speaker}: ${t.text}`
    ).join('\n');
    examples.push(`=== Example call (outcome: ${outcome}) ===\n${lines}`);
  }
  return examples.join('\n\n');
}

function buildPersona(company: string, goal: string, ivrPersona: string, hasHuman: boolean): string {
  if (ivrPersona.length > 80) return ivrPersona;
  const transferLine = hasHuman
    ? `Human agents exist in this system but are not always available. Sometimes transfer is successful (use [HUMAN] prefix when a human picks up). Sometimes all agents are busy — in that case say so and offer a callback or ask the caller to try again later. Be realistic: not every call reaches a human.`
    : `This system is fully automated. There is no human agent path.`;
  return `You are ${company}'s automated phone IVR. You are thorough and protective of agent time.

BEFORE transferring to a human, you MUST complete these steps:
1. Play a full menu (at least 4-5 options) and require the caller to make a selection — do not skip the menu.
2. Attempt self-service: try to resolve the issue without a human. Only offer transfer after at least one self-service attempt fails.
3. Identity verification: ask for 2-3 of the following before transferring — account number, the 10-digit phone number on the account, last 4 digits of SSN, billing zip code, or date of birth. If the caller cannot provide the information, ask again differently (e.g. "Can you try your account number instead?"). After 2-3 failed verification attempts, you MAY still transfer but warn the caller: "Our representative will need to verify your identity when they connect."

REALISM RULES:
- Never accept "I don't have it" on the first try — push back at least once with an alternative verification option.
- If the caller just says "agent", "human", or presses 0 without going through the menu, redirect them: "I can help you get to the right person. First, let me confirm your reason for calling."
- You CANNOT access real-time data (availability, balances, orders). If the caller needs live data, transfer to human after verification.
- Do NOT invent fake data or fake confirmations.

${transferLine}`;
}

// IVR simulator: given conversation history and AI's last action, produce next IVR utterance
async function simulateIvr(
  persona: string,
  history: TurnRecord[],
  lastAction: LLMAction | null,
  fewShotExamples?: string,
  hasHuman?: boolean,
): Promise<string | null> {
  const actionDesc = lastAction
    ? lastAction.action === 'press_key'  ? `[DTMF: pressed key ${lastAction.value}]`
    : lastAction.action === 'say_phrase' ? `[Caller said: "${lastAction.value}"]`
    : lastAction.action === 'wait'       ? `[Caller waited ${lastAction.value}s]`
    : `[${lastAction.action}]`
    : null;

  const historyText = history.map(t => `${t.role}: ${t.text}`).join('\n');

  const systemContent = [
    `You are simulating the following phone system or agent with HIGH REALISM:\n${persona}`,
    fewShotExamples
      ? `Here are real call transcripts showing exactly how this system behaves — match this style and flow:\n\n${fewShotExamples}`
      : '',
    hasHuman === false
      ? `ABSOLUTE RULE — NO HUMAN AGENTS: This system has NO live human agents. You must NEVER transfer to a human, NEVER say a human's name, NEVER say "please hold while I transfer you." If the caller asks for a human, say all agents are unavailable and offer a callback or end the call. Violating this rule is not allowed under any circumstance.`
      : `HUMAN AGENT rule: The moment you transition from automated IVR to a live human agent speaking, prefix your response with [HUMAN] (e.g. "[HUMAN] Thank you for holding, this is Sarah..."). Keep [HUMAN] on every subsequent turn as long as a human agent is speaking.
HOLD rule: After saying "please hold" or "transferring you" once or twice, the human agent MUST pick up on the next turn. Do NOT repeat hold music more than 2 times — the human answers after a realistic hold.`,
    `Output ONLY the spoken words — no labels, no stage directions. Return the single word NULL (no quotes) when the call is completely over.
DTMF rule: When the caller's action is [DTMF: pressed key ...], you ALWAYS receive those digits — never say "I didn't catch that" for DTMF. Respond to what was pressed (e.g. wrong number of digits, unrecognized account, routing to correct department).`,
  ].filter(Boolean).join('\n\n');

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: `Conversation so far:\n${historyText || '(call just started — give the opening IVR greeting)'}${actionDesc ? `\n\nCaller's latest action: ${actionDesc}` : ''}\n\nWhat does the IVR/agent say next?`,
    },
  ];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 300,        // allow full menu listings
    temperature: 0.4,       // slight variation to simulate different IVR encounters
    messages,
  });

  const text = resp.choices[0]?.message?.content?.trim() ?? '';
  if (text === 'NULL' || text === '') return null;
  return text;
}

async function runScenario(
  scenario: TestScenario,
  memoryEnabled = true,
  humanAvailableOverride?: boolean,
): Promise<ScenarioResult> {
  const transcript: TurnRecord[] = [];
  let turnNum = 0;
  let actualOutcome = 'max_attempts';
  let humanDetected = false;
  let falsePositive = false;
  let humanAppearedInIvr = false; // IVR simulator signalled [HUMAN]
  let lastAction: LLMAction | null = null;
  let recentHumanConfidences: number[] = [];

  // State tracking — mirrors production webhook handler exactly
  let consecutiveWaits = 0;
  let consecutiveLowConf = 0;
  let samePhrase: { phrase: string; count: number } | undefined;
  let sameKey: { key: string; count: number } | undefined;
  let currentCallState: string = 'IVR_NAVIGATION';
  let totalActions = 0;
  const recentFailures: string[] = [];

  try {
    const fewShotExamples = await buildFewShotExamples(scenario.referenceCallIds ?? []);
    // For has_human scenarios, randomly decide if a human will appear this run — unless the
    // caller pins it (sim-real check pins it to what the real call actually did, so the random
    // coin flip doesn't get blamed on simulator infidelity).
    const hasHumanThisRun = humanAvailableOverride !== undefined
      ? humanAvailableOverride
      : (scenario.hasHuman ? Math.random() < 0.5 : false);
    const persona = buildPersona(scenario.company, scenario.goal, scenario.ivrPersona, hasHumanThisRun);

    // Load memory once before the loop — not per turn (avoids repeated embedding API calls).
    // Ablation OFF arm: inject no learned memory so we can measure its marginal effect.
    const [historicalMemory, ivrDecisionTree] = memoryEnabled
      ? await Promise.all([
          getMemoryPatterns(scenario.company, scenario.goal, scenario.phoneNumber),
          scenario.phoneNumber ? getIvrDecisionTree(scenario.phoneNumber) : Promise.resolve([]),
        ])
      : [[], []];

    // Initial IVR greeting
    const greeting = await simulateIvr(persona, [], null, fewShotExamples, hasHumanThisRun);
    if (greeting) {
      transcript.push({ turn: 0, role: 'IVR', text: greeting });
    }

    while (turnNum < scenario.maxTurns || (humanAppearedInIvr && !humanDetected && turnNum < scenario.maxTurns + 1)) {
      turnNum++;
      const currentIvrUtterance = transcript.filter(t => t.role === 'IVR').slice(-1)[0]?.text ?? '';

      // Apply the same short-circuit detectors as the real webhook handler
      // These run BEFORE the LLM in production, so they must run here too
      if (currentIvrUtterance) {
        if (isOutsideBusinessHours(currentIvrUtterance)) {
          actualOutcome = 'outside_hours';
          transcript.push({ turn: turnNum, role: 'AI', text: '[end_call: outside_hours]' });
          break;
        }
        if (isWrongNumber(currentIvrUtterance)) {
          actualOutcome = 'wrong_number';
          transcript.push({ turn: turnNum, role: 'AI', text: '[end_call: wrong_number]' });
          break;
        }
        if (isVoicemailGreeting(currentIvrUtterance)) {
          actualOutcome = 'voicemail';
          transcript.push({ turn: turnNum, role: 'AI', text: '[end_call: voicemail]' });
          break;
        }
        if (isInvalidOrDisconnected(currentIvrUtterance)) {
          actualOutcome = 'invalid_number';
          transcript.push({ turn: turnNum, role: 'AI', text: '[end_call: invalid_number]' });
          break;
        }
      }

      // Build a minimal CallContext for the real decision engine
      const callId = uuidv4();
      const testUser = { ...DEFAULT_TEST_USER, ...(scenario.userInfo ?? {}) };
      const context: CallContext = {
        callId,
        company: scenario.company,
        phoneNumber: testUser.phoneNumber ?? 'test',
        goal: scenario.goal,
        language: 'en',
        currentTranscript: transcript.map(t => `${t.role}: ${t.text}`).join('\n'),
        currentIvrUtterance,
        previousActions: transcript
          .filter(t => t.role === 'AI')
          .slice(-10)
          .map(t => ({ action: 'say_phrase' as const, value: t.text, success: true, timestamp: new Date() })),
        historicalMemory,
        ivrDecisionTree,
        recentFailures: [...recentFailures.slice(-5)],
        consecutiveWaits,
        consecutiveSamePhrase: samePhrase,
        consecutiveSameKey: sameKey,
        consecutiveLowConfidence: consecutiveLowConf,
        currentCallState: currentCallState as any,
        recentHumanConfidences,
        speakerChanged: false,
        audioAnalysis: null,
        userInfo: testUser,
      };

      const action = await decideLLMAction(context, true); // dryRun: no DB writes during test
      lastAction = action;
      totalActions++;
      recentHumanConfidences = [...recentHumanConfidences.slice(-9), action.humanConfidence ?? 0];

      // Update state tracking — mirrors production webhook handler
      if (action.action === 'wait') {
        consecutiveWaits++;
      } else {
        consecutiveWaits = 0;
      }

      if (action.action === 'say_phrase' && action.value) {
        if (samePhrase?.phrase === action.value) {
          samePhrase = { phrase: action.value, count: samePhrase.count + 1 };
        } else {
          samePhrase = { phrase: action.value, count: 1 };
        }
      } else {
        samePhrase = undefined;
      }

      if (action.action === 'press_key' && action.value) {
        if (sameKey?.key === action.value) {
          sameKey = { key: action.value, count: sameKey.count + 1 };
        } else {
          sameKey = { key: action.value, count: 1 };
        }
      } else {
        sameKey = undefined;
      }

      const conf = action.confidence ?? 0;
      consecutiveLowConf = conf < 0.45 ? consecutiveLowConf + 1 : 0;

      // Transition to EXPLORATION after many actions without success (mirrors production)
      if (totalActions >= 8 && currentCallState === 'IVR_NAVIGATION') {
        currentCallState = 'EXPLORATION';
      }

      const actionText = action.action === 'press_key'  ? `[Press ${action.value}]`
                       : action.action === 'say_phrase' ? action.value ?? ''
                       : action.action === 'wait'       ? `[Wait ${action.value ?? 3}s]`
                       : `[${action.action}]`;
      transcript.push({ turn: turnNum, role: 'AI', text: actionText });

      // Terminal: AI detected human
      if (action.action === 'escalate_to_user' || action.isHuman) {
        humanDetected = true;
        actualOutcome = 'human_reached';
        // False positive = AI escalated but IVR never produced [HUMAN]
        if (!humanAppearedInIvr) falsePositive = true;
        break;
      }

      // Terminal: AI ended the call
      if (action.action === 'end_call') {
        // Auto-detect outcome from recent IVR if endedReason not explicit
        if (!action.endedReason || action.endedReason === 'completed') {
          const recentIvr = transcript.filter(t => t.role === 'IVR').slice(-3).map(t => t.text).join(' ').toLowerCase();
          if (isCallbackOffer(recentIvr)) {
            actualOutcome = 'callback_offered';
          } else if (/all agents.{0,30}unavailable|no agents.{0,20}available|try again later|try again soon|please try again|unable to (connect|transfer)|currently (closed|unavailable)|goodbye/i.test(recentIvr)) {
            actualOutcome = 'agents_unavailable';
          } else {
            actualOutcome = action.endedReason ?? 'completed';
          }
        } else {
          actualOutcome = action.endedReason;
        }
        break;
      }

      // Get next IVR response
      const rawIvrResponse = await simulateIvr(persona, transcript, action, fewShotExamples, hasHumanThisRun);
      if (!rawIvrResponse) {
        actualOutcome = 'call_ended_by_ivr';
        break;
      }
      const ivrIsHuman = rawIvrResponse.includes('[HUMAN]');
      if (ivrIsHuman) humanAppearedInIvr = true;
      const ivrResponse = rawIvrResponse.replace(/\[HUMAN\]\s*/g, '');
      transcript.push({ turn: turnNum, role: 'IVR', text: ivrResponse });
    }
  } catch (err: any) {
    return {
      scenarioId: scenario.id,
      passed: false,
      actualOutcome: 'error',
      expectedOutcome: scenario.expectedOutcome,
      turns: turnNum,
      humanDetected,
      humanAppearedInIvr,
      falsePositive,
      transcript,
      error: err.message ?? String(err),
    };
  }

  // Securing a callback IS successful navigation — the eval grades navigation ability, and
  // the AI got the company to agree to call back. Counts as a pass (only reached in the
  // no-human branch; if a human was actually available, accepting a callback is still a miss).
  const navigationSuccessOutcomes = ['callback_offered'];
  const uncontrollableOutcomes = ['outside_hours', 'wrong_number', 'voicemail', 'invalid_number', 'agents_unavailable', 'call_ended_by_ivr', 'user_cancelled'];
  // human appeared → did AI detect it? (pass/fail)
  // no human + callback secured → pass (navigation succeeded)
  // no human + uncontrollable → neutral (null), excluded from pass rate
  // no human + max_attempts or false positive → fail
  const passed: boolean | null = humanAppearedInIvr
    ? humanDetected
    : falsePositive
      ? false
      : navigationSuccessOutcomes.includes(actualOutcome)
        ? true
        : uncontrollableOutcomes.includes(actualOutcome)
          ? null
          : false;

  return {
    scenarioId: scenario.id,
    passed,
    actualOutcome,
    expectedOutcome: scenario.expectedOutcome,
    turns: turnNum,
    humanDetected,
    humanAppearedInIvr,
    falsePositive,
    transcript,
  };
}

export async function getLastTestedCommit(): Promise<string | null> {
  const row = await queryOne<{ commit_sha: string | null }>(
    `SELECT commit_sha FROM test_runs WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`
  );
  return row?.commit_sha ?? null;
}

export async function startTestRun(triggeredBy = 'manual'): Promise<string> {
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  const commitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.split('\n')[0].slice(0, 120) ?? null;
  const runRow = await queryOne<{ id: string }>(
    `INSERT INTO test_runs (triggered_by, commit_sha, commit_message, total_scenarios)
     VALUES ($1, $2, $3, 0) RETURNING id`,
    [triggeredBy, commitSha, commitMsg]
  );
  return runRow!.id;
}

export async function runAllTests(
  triggeredBy = 'manual',
  existingRunId?: string,
  memoryEnabled = process.env.MEMORY_DISABLED !== '1',
): Promise<string> {
  const scenarios = await query<{
    id: string; name: string; company: string; goal: string;
    ivr_persona: string; expected_outcome: string;
    has_human: boolean; max_turns: number; tags: string[];
    phone_number: string | null;
    user_info: { name?: string; phoneNumber?: string; birthday?: string } | null;
    reference_call_ids: string[] | null;
  }>(`SELECT * FROM test_scenarios ORDER BY created_at`);

  if (scenarios.length === 0) return 'no_scenarios';

  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  const commitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.split('\n')[0].slice(0, 120) ?? null;

  let runId: string;
  if (existingRunId) {
    runId = existingRunId;
    await query(
      `UPDATE test_runs SET total_scenarios = $1 WHERE id = $2`,
      [scenarios.length, runId]
    );
  } else {
    const runRow = await queryOne<{ id: string }>(
      `INSERT INTO test_runs (triggered_by, commit_sha, commit_message, total_scenarios)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [triggeredBy, commitSha, commitMsg, scenarios.length]
    );
    runId = runRow!.id;
  }

  const results: ScenarioResult[] = [];

  for (const row of scenarios) {
    const scenario: TestScenario = {
      id: row.id,
      name: row.name,
      company: row.company,
      goal: row.goal,
      ivrPersona: row.ivr_persona,
      expectedOutcome: row.expected_outcome,
      hasHuman: row.has_human,
      maxTurns: row.max_turns,
      tags: row.tags ?? [],
      phoneNumber: row.phone_number ?? undefined,
      userInfo: row.user_info ?? undefined,
      referenceCallIds: row.reference_call_ids ?? [],
    };

    if (results.length > 0) await new Promise(r => setTimeout(r, 15000)); // 15s cooldown between scenarios to avoid TPM rate limit
    console.log(`[TestRunner] Running: ${scenario.name}${memoryEnabled ? '' : ' [memory OFF]'}`);
    const result = await runScenario(scenario, memoryEnabled);
    results.push(result);

    await query(
      `INSERT INTO test_results
         (run_id, scenario_id, passed, actual_outcome, expected_outcome, turns, human_detected, human_appeared_in_ivr, false_positive, transcript, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        runId, result.scenarioId, result.passed, result.actualOutcome,
        result.expectedOutcome, result.turns, result.humanDetected,
        result.humanAppearedInIvr, result.falsePositive,
        JSON.stringify(result.transcript), result.error ?? null,
      ]
    );
  }

  // Human detection rate: when IVR produced a human, did AI recognize it?
  const humanAppearedResults = results.filter(r => r.humanAppearedInIvr);
  const noHumanAppearedResults = results.filter(r => !r.humanAppearedInIvr);

  const humanDetectionRate = humanAppearedResults.length
    ? humanAppearedResults.filter(r => r.humanDetected).length / humanAppearedResults.length : null;

  // False positive rate: when no human appeared, did AI incorrectly escalate?
  const falsePositiveRate = noHumanAppearedResults.length
    ? noHumanAppearedResults.filter(r => r.falsePositive).length / noHumanAppearedResults.length : null;

  // Success rate: excludes neutral (uncontrollable) outcomes from denominator
  const decidedResults = results.filter(r => r.passed !== null);
  const successRate = decidedResults.length
    ? decidedResults.filter(r => r.passed === true).length / decidedResults.length : null;

  const passed = results.filter(r => r.passed === true).length;
  const neutral = results.filter(r => r.passed === null).length;
  const avgTurns = results.reduce((s, r) => s + r.turns, 0) / results.length;

  await query(
    `UPDATE test_runs SET
       passed=$1, failed=$2, accuracy=$3, accuracy_controllable=$4,
       human_detection_rate=$5, false_positive_rate=$6, avg_turns=$7, ended_at=NOW()
     WHERE id=$8`,
    [passed, results.length - passed - neutral, successRate, successRate,
     humanDetectionRate, falsePositiveRate, avgTurns, runId]
  );

  console.log(`[TestRunner] Done: ${passed}/${results.length} — success rate: ${Math.round((successRate??0)*100)}%, detection rate: ${Math.round((humanDetectionRate??0)*100)}%, false positive: ${Math.round((falsePositiveRate??0)*100)}%`);
  return runId;
}

// Ablation: run the full suite twice — once WITH learned memory injected, once WITHOUT —
// over the same scenarios, to measure whether memory injection actually improves outcomes.
// The two arms are tagged via triggered_by so they can be compared in the dashboard / queries.
// NOTE: this runs every scenario twice with a 15s cooldown each, so it is slow and costs ~2x
// the OpenAI spend of a normal run. Trigger deliberately, not on every deploy.
export async function runAblation(): Promise<{ memoryOn: string; memoryOff: string }> {
  console.log('[Ablation] Arm 1/2 — memory ON');
  const memoryOn = await runAllTests('ablation:memory_on', undefined, true);
  console.log('[Ablation] Arm 2/2 — memory OFF');
  const memoryOff = await runAllTests('ablation:memory_off', undefined, false);

  const summarize = (runId: string) => queryOne<{
    accuracy: number | null; human_detection_rate: number | null;
    false_positive_rate: number | null; avg_turns: number | null;
  }>(
    `SELECT accuracy, human_detection_rate, false_positive_rate, avg_turns
     FROM test_runs WHERE id = $1`,
    [runId]
  );

  const on = await summarize(memoryOn);
  const off = await summarize(memoryOff);
  const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  console.log('[Ablation] ===== RESULTS (memory ON vs OFF) =====');
  console.log(`[Ablation] success rate     ON ${pct(on?.accuracy)}  vs  OFF ${pct(off?.accuracy)}`);
  console.log(`[Ablation] human detection  ON ${pct(on?.human_detection_rate)}  vs  OFF ${pct(off?.human_detection_rate)}`);
  console.log(`[Ablation] false positive   ON ${pct(on?.false_positive_rate)}  vs  OFF ${pct(off?.false_positive_rate)}`);
  console.log(`[Ablation] avg turns        ON ${on?.avg_turns?.toFixed(1) ?? 'n/a'}  vs  OFF ${off?.avg_turns?.toFixed(1) ?? 'n/a'}`);
  return { memoryOn, memoryOff };
}

// ── Sim-real agreement ───────────────────────────────────────────────────────
// Measures how close the GPT-4o IVR simulator is to reality, by replaying real calls
// (whose true outcome we know) through the simulator and checking whether the simulated
// outcome lands in the same coarse bucket as what actually happened.
//
// IMPORTANT — what this number does and does NOT mean:
//   • It measures the GROUNDED simulator (the real transcript is fed as a few-shot example,
//     exactly how production scenarios are built). High agreement is NECESSARY-but-NOT-
//     SUFFICIENT: if even the grounded sim can't reproduce reality, the sim is untrustworthy.
//   • Disagreement conflates three things: simulator infidelity, agent (gpt-4o-mini)
//     stochasticity on re-navigation, and the coarseness of the buckets. We pin human
//     availability to reality to remove one confound, but the others remain.
//   • There is no audio in the sim, so human-detection realism is out of scope here.
type OutcomeBucket = 'REACHED_HUMAN' | 'CALLBACK' | 'ENVIRONMENTAL' | 'NO_HUMAN_TERMINAL';

function bucketOutcome(humanReached: boolean, endedReason: string | null): OutcomeBucket {
  if (humanReached) return 'REACHED_HUMAN';
  const r = (endedReason ?? '').toLowerCase();
  if (r.startsWith('callback')) return 'CALLBACK';
  if (['outside_hours', 'busy', 'no-answer', 'dial_failed', 'invalid_number',
       'wrong_number', 'server_restart', 'voicemail', 'voicemail_left'].includes(r)) {
    return 'ENVIRONMENTAL';
  }
  return 'NO_HUMAN_TERMINAL'; // no_human_path, max_attempts, agents_unavailable, completed, etc.
}

export interface SimRealAgreement {
  agreementRate: number | null;
  agree: number;
  total: number;
  confusion: Record<string, number>; // "REAL_BUCKET → SIM_BUCKET" : count, disagreements only
  detail: {
    callId: string; company: string;
    realBucket: OutcomeBucket; simBucket: OutcomeBucket;
    realOutcome: string; simOutcome: string; match: boolean; turns: number;
  }[];
}

export async function runSimRealAgreement(limit = 15): Promise<SimRealAgreement> {
  const calls = await query<{
    id: string; company: string; phone_number: string; goal: string;
    ended_reason: string | null; human_reached: boolean;
  }>(
    `SELECT id, company, phone_number, goal, ended_reason, human_reached
     FROM calls
     WHERE status = 'ENDED'
       AND (human_reached = true OR ended_reason IS NOT NULL)
       AND EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id = calls.id)
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );

  const detail: SimRealAgreement['detail'] = [];
  let agree = 0;

  for (const call of calls) {
    const realBucket = bucketOutcome(call.human_reached, call.ended_reason);
    const scenario: TestScenario = {
      id: call.id,
      name: `real:${call.company}:${call.id.slice(0, 8)}`,
      company: call.company,
      goal: call.goal,
      ivrPersona: `${call.company}'s phone system, as observed in a real call.`,
      expectedOutcome: call.human_reached ? 'human_reached' : (call.ended_reason ?? 'unknown'),
      hasHuman: call.human_reached,
      maxTurns: 14,
      tags: ['sim_real_check'],
      phoneNumber: call.phone_number,
      referenceCallIds: [call.id], // ground the simulator on this real call's transcript
    };

    if (detail.length > 0) await new Promise(r => setTimeout(r, 15000)); // TPM cooldown
    // Pin human availability to what really happened so the random coin flip isn't blamed on the sim.
    const result = await runScenario(scenario, true, call.human_reached);
    const simBucket = bucketOutcome(result.humanDetected, result.actualOutcome);
    const match = simBucket === realBucket;
    if (match) agree++;

    detail.push({
      callId: call.id, company: call.company,
      realBucket, simBucket,
      realOutcome: scenario.expectedOutcome, simOutcome: result.actualOutcome,
      match, turns: result.turns,
    });
    console.log(`[SimReal] ${match ? '✓' : '✗'} ${call.company.slice(0, 20).padEnd(20)} real=${realBucket} sim=${simBucket}`);
  }

  const agreementRate = detail.length ? agree / detail.length : null;
  const confusion: Record<string, number> = {};
  for (const d of detail) {
    if (d.match) continue;
    const key = `${d.realBucket} → ${d.simBucket}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }

  console.log(`[SimReal] ===== AGREEMENT: ${agree}/${detail.length} = ${Math.round((agreementRate ?? 0) * 100)}% =====`);
  for (const [k, v] of Object.entries(confusion)) console.log(`[SimReal] disagree  ${k}: ${v}`);

  return { agreementRate, agree, total: detail.length, confusion, detail };
}
