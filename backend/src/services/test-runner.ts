import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/client';
import { decideLLMAction } from './llm-engine';
import { config } from '../config';
import { CallContext, LLMAction } from '../types';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

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
      content: `You are simulating an IVR phone system or human agent.

${persona}

Rules:
- Output ONLY the spoken response (IVR or human), no stage directions, no labels
- 1-3 sentences maximum
- If you are playing a human agent, introduce yourself by name on your first turn
- If the caller pressed a key or said something that routes to a specific menu, respond accordingly
- Use natural speech patterns (for humans: include "um", "uh", contractions)
- If the scenario ends (closed, voicemail, transferred), say so clearly
- Return null (literally the text "NULL") if the call has ended and there is nothing more to say`,
    },
    {
      role: 'user',
      content: `Conversation so far:\n${historyText || '(call just started)'}${actionDesc ? `\n\nCaller's latest action: ${actionDesc}` : ''}\n\nWhat does the IVR/agent say next?`,
    },
  ];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',        // more capable for realistic IVR simulation — latency doesn't matter here
    max_tokens: 150,
    temperature: 0.3,
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

  try {
    // Initial IVR greeting
    const greeting = await simulateIvr(scenario.ivrPersona, [], null);
    if (greeting) {
      transcript.push({ turn: 0, role: 'IVR', text: greeting });
    }

    while (turnNum < scenario.maxTurns) {
      turnNum++;
      const currentIvrUtterance = transcript.filter(t => t.role === 'IVR').slice(-1)[0]?.text ?? '';

      // Build a minimal CallContext for the real decision engine
      const callId = uuidv4();
      const context: CallContext = {
        callId,
        company: scenario.company,
        phoneNumber: 'test',
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
        recentFailures: [],
        consecutiveWaits: 0,
        currentCallState: 'IVR_NAVIGATION',
        recentHumanConfidences,
        speakerChanged: false,
        audioAnalysis: null,
      };

      const action = await decideLLMAction(context, true); // dryRun: no DB writes during test
      lastAction = action;
      recentHumanConfidences = [...recentHumanConfidences.slice(-9), action.humanConfidence ?? 0];

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

export async function runAllTests(triggeredBy = 'manual'): Promise<string> {
  const scenarios = await query<{
    id: string; name: string; company: string; goal: string;
    ivr_persona: string; expected_outcome: string;
    has_human: boolean; max_turns: number; tags: string[];
  }>(`SELECT * FROM test_scenarios ORDER BY created_at`);

  if (scenarios.length === 0) return 'no_scenarios';

  const runRow = await queryOne<{ id: string }>(
    `INSERT INTO test_runs (triggered_by, total_scenarios) VALUES ($1, $2) RETURNING id`,
    [triggeredBy, scenarios.length]
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

  const passed = results.filter(r => r.passed).length;
  const humanScenarios = results.filter(r => scenarios.find(s => s.id === r.scenarioId)?.has_human);
  const humanDetectionRate = humanScenarios.length
    ? humanScenarios.filter(r => r.humanDetected).length / humanScenarios.length
    : null;
  const noHumanScenarios = results.filter(r => !scenarios.find(s => s.id === r.scenarioId)?.has_human);
  const falsePositiveRate = noHumanScenarios.length
    ? noHumanScenarios.filter(r => r.falsePositive).length / noHumanScenarios.length
    : null;
  const avgTurns = results.reduce((s, r) => s + r.turns, 0) / results.length;

  await query(
    `UPDATE test_runs SET
       passed=$1, failed=$2, accuracy=$3,
       human_detection_rate=$4, false_positive_rate=$5, avg_turns=$6, ended_at=NOW()
     WHERE id=$7`,
    [passed, results.length - passed, passed / results.length,
     humanDetectionRate, falsePositiveRate, avgTurns, runId]
  );

  console.log(`[TestRunner] Done: ${passed}/${results.length} passed (${Math.round(passed / results.length * 100)}% accuracy)`);
  return runId;
}
