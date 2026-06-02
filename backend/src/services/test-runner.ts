import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/client';
import { decideLLMAction } from './llm-engine';
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
  userInfo?: { name?: string; phoneNumber?: string; birthday?: string };
}

interface TurnRecord {
  turn: number;
  role: 'IVR' | 'AI';
  text: string;
}

interface ScenarioResult {
  scenarioId: string;
  passed: boolean;
  actualOutcome: string;
  expectedOutcome: string;
  turns: number;
  humanDetected: boolean;
  falsePositive: boolean;
  transcript: TurnRecord[];
  error?: string;
}

// IVR simulator: given conversation history and AI's last action, produce next IVR utterance
async function simulateIvr(
  persona: string,
  history: TurnRecord[],
  lastAction: LLMAction | null,
): Promise<string | null> {
  const actionDesc = lastAction
    ? lastAction.action === 'press_key'  ? `[DTMF: pressed key ${lastAction.value}]`
    : lastAction.action === 'say_phrase' ? `[Caller said: "${lastAction.value}"]`
    : lastAction.action === 'wait'       ? `[Caller waited ${lastAction.value}s]`
    : `[${lastAction.action}]`
    : null;

  const historyText = history.map(t => `${t.role}: ${t.text}`).join('\n');

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are simulating an IVR phone system or human agent with HIGH REALISM.

${persona}

Core rules:
- Output ONLY the spoken response — no labels, no stage directions
- Real IVRs take many turns. DO NOT rush through steps. One prompt at a time.
- If the caller gives an unexpected response (wrong key, unclear phrase, silence), say "I'm sorry, I didn't catch that" or repeat the question — don't skip ahead
- IVR menus are long and detailed. Give the FULL menu options, not a summary.
- Hold music / "please wait" counts as a turn. Use it when transferring.
- For humans: use natural speech — "um", "uh", "let me check on that", contractions, incomplete sentences
- If you are a human agent, introduce yourself by name and ask how you can help
- ONLY return NULL when the call is completely over (caller hung up, voicemail beep passed, goodbye said)
- Do NOT return NULL just because you gave the caller information — wait for their response`,
    },
    {
      role: 'user',
      content: `Conversation so far:\n${historyText || '(call just started — give the opening IVR greeting)'}${actionDesc ? `\n\nCaller's latest action: ${actionDesc}` : ''}\n\nWhat does the IVR/agent say next? Be realistic — don't skip steps.`,
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

async function runScenario(scenario: TestScenario): Promise<ScenarioResult> {
  const transcript: TurnRecord[] = [];
  let turnNum = 0;
  let actualOutcome = 'max_attempts';
  let humanDetected = false;
  let falsePositive = false;
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
    // Initial IVR greeting
    const greeting = await simulateIvr(scenario.ivrPersona, [], null);
    if (greeting) {
      transcript.push({ turn: 0, role: 'IVR', text: greeting });
    }

    while (turnNum < scenario.maxTurns) {
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
        historicalMemory: [],
        ivrDecisionTree: [],
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
                       : action.action === 'wait'       ? `[Wait ${action.value}s]`
                       : `[${action.action}]`;
      transcript.push({ turn: turnNum, role: 'AI', text: actionText });

      // Terminal: AI detected human
      if (action.action === 'escalate_to_user' || action.isHuman) {
        humanDetected = true;
        actualOutcome = 'human_reached';
        if (!scenario.hasHuman) falsePositive = true;
        break;
      }

      // Terminal: AI ended the call
      if (action.action === 'end_call') {
        actualOutcome = action.endedReason ?? 'completed';
        break;
      }

      // Get next IVR response
      const ivrResponse = await simulateIvr(scenario.ivrPersona, transcript, action);
      if (!ivrResponse) {
        actualOutcome = 'call_ended_by_ivr';
        break;
      }
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
      falsePositive,
      transcript,
      error: err.message ?? String(err),
    };
  }

  const passed = actualOutcome === scenario.expectedOutcome ||
    (scenario.expectedOutcome === 'human_reached' && humanDetected);

  return {
    scenarioId: scenario.id,
    passed,
    actualOutcome,
    expectedOutcome: scenario.expectedOutcome,
    turns: turnNum,
    humanDetected,
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

export async function runAllTests(triggeredBy = 'manual'): Promise<string> {
  const scenarios = await query<{
    id: string; name: string; company: string; goal: string;
    ivr_persona: string; expected_outcome: string;
    has_human: boolean; max_turns: number; tags: string[];
    user_info: { name?: string; phoneNumber?: string; birthday?: string } | null;
  }>(`SELECT * FROM test_scenarios ORDER BY created_at`);

  if (scenarios.length === 0) return 'no_scenarios';

  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  const commitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.split('\n')[0].slice(0, 120) ?? null;

  const runRow = await queryOne<{ id: string }>(
    `INSERT INTO test_runs (triggered_by, commit_sha, commit_message, total_scenarios)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [triggeredBy, commitSha, commitMsg, scenarios.length]
  );
  const runId = runRow!.id;

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
      userInfo: row.user_info ?? undefined,
    };

    console.log(`[TestRunner] Running: ${scenario.name}`);
    const result = await runScenario(scenario);
    results.push(result);

    await query(
      `INSERT INTO test_results
         (run_id, scenario_id, passed, actual_outcome, expected_outcome, turns, human_detected, false_positive, transcript, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        runId, result.scenarioId, result.passed, result.actualOutcome,
        result.expectedOutcome, result.turns, result.humanDetected,
        result.falsePositive, JSON.stringify(result.transcript), result.error ?? null,
      ]
    );
  }

  // Force-majeure outcomes: circumstances beyond AI control (same set as EXCLUDED_FROM_AI_PERF in dashboard)
  const FORCE_MAJEURE = new Set(['outside_hours', 'voicemail', 'voicemail_left', 'wrong_number',
    'invalid_number', 'busy', 'no-answer', 'dial_failed', 'server_restart']);

  const passed = results.filter(r => r.passed).length;
  const controllableResults = results.filter(r => {
    const scenario = scenarios.find(s => s.id === r.scenarioId);
    return !FORCE_MAJEURE.has(scenario?.expected_outcome ?? '');
  });
  const controllablePassed = controllableResults.filter(r => r.passed).length;
  const accuracyControllable = controllableResults.length
    ? controllablePassed / controllableResults.length : null;

  const humanScenarios = results.filter(r => scenarios.find(s => s.id === r.scenarioId)?.has_human);
  const humanDetectionRate = humanScenarios.length
    ? humanScenarios.filter(r => r.humanDetected).length / humanScenarios.length : null;
  const noHumanScenarios = results.filter(r => !scenarios.find(s => s.id === r.scenarioId)?.has_human);
  const falsePositiveRate = noHumanScenarios.length
    ? noHumanScenarios.filter(r => r.falsePositive).length / noHumanScenarios.length : null;
  const avgTurns = results.reduce((s, r) => s + r.turns, 0) / results.length;

  await query(
    `UPDATE test_runs SET
       passed=$1, failed=$2, accuracy=$3, accuracy_controllable=$4,
       human_detection_rate=$5, false_positive_rate=$6, avg_turns=$7, ended_at=NOW()
     WHERE id=$8`,
    [passed, results.length - passed, passed / results.length, accuracyControllable,
     humanDetectionRate, falsePositiveRate, avgTurns, runId]
  );

  console.log(`[TestRunner] Done: ${passed}/${results.length} (${Math.round(passed/results.length*100)}% overall, ${Math.round((accuracyControllable??0)*100)}% AI-controllable)`);
  return runId;
}
