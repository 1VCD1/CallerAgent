import { v4 as uuidv4 } from 'uuid';
import { CallStateMachine } from '../state-machine/CallStateMachine';
import { DeepgramTranscriptionSession } from './transcription';
import { decideLLMAction } from './llm-engine';
import { getMemoryPatterns, recordCallOutcome, markActionSuccess, getActionPatterns } from './memory';
import { emitCallStatus } from './call-events';
import { generateCallSummary } from './call-summarizer';
import { initiateOutboundCall, sendDTMF, sayPhrase, createConferenceBridge, createConferenceWithHold, bridgeUserToConference, endCall } from './telephony';
import { detectHumanCombined, isHoldMusic, extractMenuKeys } from './human-detector';
import { AudioAnalyzer, AudioAnalysisResult } from './audio-analyzer';
import { query, queryOne } from '../db/client';
import { config } from '../config';
import { CallContext, ActionRecord, LLMAction, Call, UserInfo } from '../types';
import { getLang } from '../languages';

const MAX_NAVIGATION_ATTEMPTS = 20;
const HUMAN_CONFIDENCE_THRESHOLD = 0.75;

export class CallOrchestrator {
  private stateMachine: CallStateMachine;
  private transcriptionSession: DeepgramTranscriptionSession;
  private audioAnalyzer: AudioAnalyzer;
  private call: Call;
  private actionHistory: ActionRecord[] = [];
  private recentFailures: string[] = [];
  private onUserNotify?: (callId: string) => Promise<void>;

  private constructor(call: Call, onUserNotify?: (callId: string) => Promise<void>, language = 'en') {
    this.call = call;
    this.onUserNotify = onUserNotify;
    this.language = language;
    this.stateMachine = new CallStateMachine(call.id, 'INIT');
    this.audioAnalyzer = new AudioAnalyzer();
    this.transcriptionSession = new DeepgramTranscriptionSession(
      call.id,
      this.onTranscript.bind(this),
      getLang(language as any).deepgramLanguage
    );

    this.stateMachine.on('human_detected', () => this.handleHumanDetected());
    this.stateMachine.on('end_call', () => this.handleCallEnded(false));
    this.stateMachine.on('fail', () => this.handleCallEnded(false));
  }

  private userInfo?: UserInfo;
  private language = 'en';

  static async create(params: {
    company: string;
    phoneNumber: string;
    userPhoneNumber?: string;
    userInfo?: UserInfo;
    language?: string;
    goal?: string;
    userId: string;
    onUserNotify?: (callId: string) => Promise<void>;
  }): Promise<CallOrchestrator> {
    const callId = uuidv4();
    const goal = params.goal ?? 'reach_human';

    await query(
      `INSERT INTO calls (id, user_id, company, phone_number, user_phone_number, goal, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'INIT')`,
      [callId, params.userId, params.company, params.phoneNumber, params.userPhoneNumber ?? null, goal]
    );

    const call: Call = {
      id: callId,
      userId: params.userId,
      company: params.company,
      phoneNumber: params.phoneNumber,
      userPhoneNumber: params.userPhoneNumber,
      goal,
      status: 'INIT',
      humanReached: false,
      startedAt: new Date(),
    };

    const orchestrator = new CallOrchestrator(call, params.onUserNotify, params.language ?? 'en');
    orchestrator.userInfo = params.userInfo;
    return orchestrator;
  }

  async start(): Promise<void> {
    let twilioCallSid: string;
    try {
      twilioCallSid = await initiateOutboundCall({
        to: this.call.phoneNumber,
        callId: this.call.id,
      });
    } catch (err) {
      await query(
        `UPDATE calls SET status = 'FAILED', ended_at = NOW(), ended_reason = 'dial_failed' WHERE id = $1`,
        [this.call.id]
      );
      emitCallStatus(this.call.id, 'FAILED');
      throw err;
    }

    await query(`UPDATE calls SET twilio_call_sid = $1 WHERE id = $2`, [
      twilioCallSid,
      this.call.id,
    ]);

    this.call.twilioCallSid = twilioCallSid;
    this.transcriptionSession.start();
    await this.stateMachine.transition('start_dial');

    console.log(`[Orchestrator] Call ${this.call.id} dialing ${this.call.phoneNumber}`);
  }

  handleAudioChunk(audioBuffer: Buffer): void {
    this.audioAnalyzer.addChunk(audioBuffer);
    this.transcriptionSession.sendAudio(audioBuffer);
  }

  getAudioAnalysis(): AudioAnalysisResult | null {
    return this.audioAnalyzer.analyze();
  }

  async onCallConnected(): Promise<void> {
    await this.stateMachine.transition('call_connected');
    emitCallStatus(this.call.id, 'IVR_NAVIGATION');
    // Decisions are handled by the Gather webhook loop, not a timer
  }

  private speakerChanged = false;
  private pendingDecision: Promise<LLMAction> | null = null;
  private pendingDecisionAt = 0; // timestamp ms

  // Call-level cache for data that doesn't change mid-call
  private cachedMemories: import('../types').MemoryPattern[] | null = null;
  private cachedIvrNotes: string | null | undefined = undefined;    // undefined = not loaded yet
  private cachedCompanyNote: string | null | undefined = undefined; // undefined = not loaded yet
  private cachedUserRow: { name?: string; birthday?: string; language?: string } | null = null;
  private cachedActionPatterns: import('./memory').ActionPattern[] | null = null;
  // Updated by the Gather webhook after each turn so prefetch has real previousActions
  private cachedRecentActions: ActionRecord[] = [];

  private onTranscript(text: string, isFinal: boolean, speakerChanged: boolean): void {
    if (!isFinal) return;

    if (speakerChanged) {
      this.speakerChanged = true;
      console.log(`[Orchestrator] Speaker change detected for call ${this.call.id} — will pass to LLM`);
    }

    const audioNow = this.audioAnalyzer.analyze();

    // Ring-tone pickup: transfer ring heard → someone answered → almost certainly human
    if (audioNow?.postRingPickup && this.stateMachine.can('human_detected')) {
      console.log(`[Orchestrator] Post-ring-tone pickup for call ${this.call.id} — escalating immediately`);
      this.handleHumanDetected();
      return;
    }

    const detection = detectHumanCombined(text, audioNow);
    if (
      detection.isHuman &&
      detection.confidence >= HUMAN_CONFIDENCE_THRESHOLD &&
      this.stateMachine.can('human_detected')
    ) {
      this.handleHumanDetected();
      return;
    }

    if (isHoldMusic(text) && this.stateMachine.can('on_hold')) {
      this.stateMachine.transition('on_hold');
    }

    // Pre-fetch LLM decision in parallel with Twilio's speechTimeout
    // By the time the Gather webhook fires, the decision may already be ready
    this.prefetchDecision(text);
  }

  private prefetchDecision(triggerText: string): void {
    this.pendingDecisionAt = Date.now();

    const memoriesPromise = this.cachedMemories
      ? Promise.resolve(this.cachedMemories)
      : getMemoryPatterns(this.call.company, this.call.goal).then(m => { this.cachedMemories = m; return m; });

    const patternsPromise = this.cachedActionPatterns
      ? Promise.resolve(this.cachedActionPatterns)
      : getActionPatterns(this.call.company).then(p => { this.cachedActionPatterns = p; return p; });

    this.pendingDecision = Promise.all([memoriesPromise, patternsPromise])
      .then(([memories, patterns]) => {
        const context: CallContext = {
          callId: this.call.id,
          company: this.call.company,
          phoneNumber: this.call.phoneNumber,
          goal: this.call.goal,
          language: this.language,
          currentTranscript: this.transcriptionSession.getFullTranscript(),
          historicalMemory: memories,
          currentCallState: this.stateMachine.getStatus(),
          previousActions: this.cachedRecentActions,
          recentFailures: this.cachedRecentActions.filter(a => !a.success).map(a => `${a.action}(${a.value})`),
          userInfo: this.userInfo,
          currentIvrUtterance: triggerText,
          audioAnalysis: this.audioAnalyzer.analyze(),
          speakerChanged: this.speakerChanged,
          companyIvrNotes: this.cachedIvrNotes ?? undefined,
          availableMenuKeys: extractMenuKeys(triggerText),
          actionPatterns: patterns.length > 0 ? patterns : undefined,
        };
        return decideLLMAction(context);
      })
      .catch(err => {
        console.error(`[Orchestrator] Prefetch failed for call ${this.call.id}:`, err);
        return null as any;
      });
  }

  // Time-based match: use prefetch if it was started within the last 4 seconds.
  // Text-based matching (old approach) failed because Deepgram and Twilio use
  // different ASR engines and almost never produce identical transcripts.
  consumePendingDecision(): Promise<LLMAction> | null {
    if (!this.pendingDecision) return null;
    const age = Date.now() - this.pendingDecisionAt;
    if (age > 4000) return null; // stale, don't use
    const decision = this.pendingDecision;
    this.pendingDecision = null;
    this.pendingDecisionAt = 0;
    return decision;
  }

  async startExploration(): Promise<void> {
    if (this.stateMachine.can('start_explore')) {
      await this.stateMachine.transition('start_explore');
      emitCallStatus(this.call.id, 'EXPLORATION');
      console.log(`[Orchestrator] Entering EXPLORATION mode for call ${this.call.id}`);
    }
  }

  updateActionCache(actions: ActionRecord[]): void {
    this.cachedRecentActions = actions;
  }

  getCachedMemories(): import('../types').MemoryPattern[] | null {
    return this.cachedMemories;
  }

  getCachedIvrNotes(): string | null | undefined {
    return this.cachedIvrNotes;
  }

  setCachedIvrNotes(notes: string | null): void {
    this.cachedIvrNotes = notes;
  }

  getCachedCompanyNote(): string | null | undefined {
    return this.cachedCompanyNote;
  }

  setCachedCompanyNote(note: string | null): void {
    this.cachedCompanyNote = note;
  }

  getCachedUserRow(): { name?: string; birthday?: string; language?: string } | null {
    return this.cachedUserRow;
  }

  setCachedUserRow(row: { name?: string; birthday?: string; language?: string }): void {
    this.cachedUserRow = row;
  }

  getSpeakerChanged(): boolean {
    return this.speakerChanged;
  }

  private async executeAction(action: LLMAction): Promise<void> {
    const callSid = this.call.twilioCallSid;
    if (!callSid) return;

    console.log(`[Orchestrator] Action: ${action.action}(${action.value}) — ${action.reasoning}`);

    try {
      switch (action.action) {
        case 'press_key':
          if (action.value) await sendDTMF(callSid, action.value);
          break;

        case 'say_phrase':
          if (action.value) await sayPhrase(callSid, action.value, getLang(this.language).ttsVoice);
          break;

        case 'wait':
          const waitMs = parseInt(action.value ?? '5', 10) * 1000;
          await new Promise((r) => setTimeout(r, waitMs));
          break;

        case 'end_call':
          await endCall(callSid);
          if (action.endedReason) {
            await query(
              `UPDATE calls SET ended_reason = $1 WHERE id = $2`,
              [action.endedReason, this.call.id]
            );
          }
          await this.stateMachine.transition('end_call');
          return;

        case 'escalate_to_user':
          await this.stateMachine.transition('human_detected', { escalated: true });
          return;

        case 'retry':
          this.recentFailures.push('retry requested');
          break;
      }

      this.actionHistory.push({
        action: action.action,
        value: action.value,
        success: true,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error(`[Orchestrator] Action execution failed:`, err);
      this.actionHistory.push({
        action: action.action,
        value: action.value,
        success: false,
        timestamp: new Date(),
      });
      await markActionSuccess(this.call.id, action.action, false);
    }
  }

  async onHumanDetected(conferenceName?: string): Promise<void> {
    const status = this.stateMachine.getStatus();

    // Deepgram may have already fired handleHumanDetected() without a conference name,
    // advancing state to USER_NOTIFIED. When Gather now provides the conference name,
    // we can't re-enter the normal human_detected flow — attempt bridge directly.
    if (status === 'USER_NOTIFIED' && conferenceName && this.call.userPhoneNumber) {
      console.log(`[Orchestrator] State already USER_NOTIFIED — attempting late bridge for ${this.call.id}`);
      try {
        const lateLang = getLang(this.language);
        const userCallSid = await bridgeUserToConference(this.call.userPhoneNumber, conferenceName, lateLang.userBridgeMessage, lateLang.ttsVoice);
        await query(
          `UPDATE calls SET user_call_sid = $1, conference_sid = $2, status = 'BRIDGED' WHERE id = $3`,
          [userCallSid, conferenceName, this.call.id]
        );
        await this.stateMachine.transition('call_bridged');
        emitCallStatus(this.call.id, 'BRIDGED');
        console.log(`[Orchestrator] Late-bridged ${this.call.userPhoneNumber} into ${conferenceName}`);
      } catch (err) {
        console.error(`[Orchestrator] Failed to late-bridge user for call ${this.call.id}:`, err);
      }
      return;
    }

    return this.handleHumanDetected(conferenceName);
  }

  private async handleHumanDetected(conferenceName?: string): Promise<void> {
    if (!this.stateMachine.can('human_detected')) return;

    await this.stateMachine.transition('human_detected');
    emitCallStatus(this.call.id, 'HUMAN_DETECTED');
    console.log(`[Orchestrator] Human detected for call ${this.call.id}!`);

    const callSid = this.call.twilioCallSid;

    // Deepgram path: no conference name provided — proactively create one and redirect the call
    if (!conferenceName && callSid) {
      conferenceName = `conf-${this.call.id}`;
      try {
        const langConfig = getLang(this.language);
        await createConferenceWithHold(callSid, conferenceName, langConfig.humanBridgeMessage, langConfig.ttsVoice);
        await query(
          `UPDATE calls SET status = 'HUMAN_DETECTED', human_reached = true,
           wait_duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER
           WHERE id = $1`,
          [this.call.id]
        );
        this.call.humanReached = true;
        console.log(`[Orchestrator] Deepgram path: redirected call into conference ${conferenceName}`);
      } catch (err) {
        console.error(`[Orchestrator] Failed to create conference from Deepgram path:`, err);
        conferenceName = undefined;
      }
    }

    // SMS + push notification fires first so user knows to answer the incoming call
    if (this.onUserNotify) {
      await this.onUserNotify(this.call.id);
    }

    await this.stateMachine.transition('user_notified');
    emitCallStatus(this.call.id, 'USER_NOTIFIED');

    // Auto-bridge: call user and drop them into the same conference as the representative
    if (conferenceName && this.call.userPhoneNumber) {
      try {
        const autoLang = getLang(this.language);
        const userCallSid = await bridgeUserToConference(this.call.userPhoneNumber, conferenceName, autoLang.userBridgeMessage, autoLang.ttsVoice);
        await query(
          `UPDATE calls SET user_call_sid = $1, conference_sid = $2, status = 'BRIDGED' WHERE id = $3`,
          [userCallSid, conferenceName, this.call.id]
        );
        await this.stateMachine.transition('call_bridged');
        emitCallStatus(this.call.id, 'BRIDGED');
        console.log(`[Orchestrator] Auto-bridged ${this.call.userPhoneNumber} into ${conferenceName}`);
      } catch (err) {
        console.error(`[Orchestrator] Failed to auto-bridge user for call ${this.call.id}:`, err);
      }
    } else {
      console.warn(`[Orchestrator] Human detected but no conference name or user phone — bridge skipped. conferenceName=${conferenceName} userPhone=${this.call.userPhoneNumber}`);
    }
  }

  async bridgeUser(userPhoneNumber: string): Promise<void> {
    if (!this.stateMachine.can('call_bridged')) {
      throw new Error('Call is not in USER_NOTIFIED state');
    }

    const conferenceName = `conf-${this.call.id}`;
    const callSid = this.call.twilioCallSid;
    if (!callSid) throw new Error('No active Twilio call');

    await createConferenceBridge(callSid, conferenceName);

    const { bridgeUserToConference } = await import('./telephony');
    const manualLang = getLang(this.language);
    const userCallSid = await bridgeUserToConference(userPhoneNumber, conferenceName, manualLang.userBridgeMessage, manualLang.ttsVoice);

    await query(
      `UPDATE calls SET user_call_sid = $1, conference_sid = $2 WHERE id = $3`,
      [userCallSid, conferenceName, this.call.id]
    );

    await this.stateMachine.transition('call_bridged');
    console.log(`[Orchestrator] User bridged into call ${this.call.id}`);
  }

  private async handleCallEnded(humanReached: boolean): Promise<void> {
    this.transcriptionSession.stop();
    emitCallStatus(this.call.id, 'ENDED');

    const callRow = await queryOne<{ wait_duration_seconds: number }>(
      `SELECT wait_duration_seconds FROM calls WHERE id = $1`,
      [this.call.id]
    );

    await recordCallOutcome({
      callId: this.call.id,
      company: this.call.company,
      goal: this.call.goal,
      humanReached: this.call.humanReached,
      waitDurationSeconds: callRow?.wait_duration_seconds,
    });

    // Fire post-call LLM summary in background — don't block
    generateCallSummary(this.call.id).catch(err =>
      console.error(`[Orchestrator] Failed to generate call summary:`, err)
    );

    console.log(`[Orchestrator] Call ${this.call.id} ended. Human reached: ${humanReached}`);
  }

  getCallId(): string {
    return this.call.id;
  }

  getStatus() {
    return this.stateMachine.getStatus();
  }
}
