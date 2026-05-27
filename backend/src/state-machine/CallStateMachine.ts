import { EventEmitter } from 'events';
import { CallStatus } from '../types';
import { query } from '../db/client';

type Transition = {
  from: CallStatus[];
  to: CallStatus;
};

const VALID_TRANSITIONS: Record<string, Transition> = {
  start_dial:     { from: ['INIT'],            to: 'DIALING' },
  call_connected: { from: ['DIALING'],         to: 'IVR_NAVIGATION' },
  start_explore:  { from: ['IVR_NAVIGATION'],  to: 'EXPLORATION' },
  on_hold:        { from: ['IVR_NAVIGATION', 'EXPLORATION'], to: 'ON_HOLD' },
  resume_nav:     { from: ['ON_HOLD'],         to: 'IVR_NAVIGATION' },
  human_detected: { from: ['IVR_NAVIGATION', 'EXPLORATION', 'ON_HOLD'], to: 'HUMAN_DETECTED' },
  user_notified:  { from: ['HUMAN_DETECTED'],  to: 'USER_NOTIFIED' },
  call_bridged:   { from: ['USER_NOTIFIED'],   to: 'BRIDGED' },
  end_call:       { from: ['INIT', 'DIALING', 'IVR_NAVIGATION', 'EXPLORATION', 'ON_HOLD', 'HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'], to: 'ENDED' },
  fail:           { from: ['INIT', 'DIALING', 'IVR_NAVIGATION', 'EXPLORATION', 'ON_HOLD'], to: 'FAILED' },
};

export class CallStateMachine extends EventEmitter {
  private status: CallStatus;
  private readonly callId: string;
  private stateEnteredAt: Date;

  constructor(callId: string, initialStatus: CallStatus = 'INIT') {
    super();
    this.callId = callId;
    this.status = initialStatus;
    this.stateEnteredAt = new Date();
  }

  getStatus(): CallStatus {
    return this.status;
  }

  can(transition: string): boolean {
    const t = VALID_TRANSITIONS[transition];
    if (!t) return false;
    return t.from.includes(this.status);
  }

  async transition(transition: string, payload?: Record<string, unknown>): Promise<CallStatus> {
    const t = VALID_TRANSITIONS[transition];
    if (!t) throw new Error(`Unknown transition: ${transition}`);
    if (!t.from.includes(this.status)) {
      throw new Error(`Invalid transition "${transition}" from state "${this.status}"`);
    }

    const previousStatus = this.status;
    this.status = t.to;
    this.stateEnteredAt = new Date();

    await this.persistStatus();
    await this.recordEvent(transition, previousStatus, payload);

    this.emit('transition', { from: previousStatus, to: this.status, transition, payload });
    this.emit(transition, { callId: this.callId, status: this.status, payload });

    return this.status;
  }

  timeInCurrentState(): number {
    return Date.now() - this.stateEnteredAt.getTime();
  }

  private async persistStatus(): Promise<void> {
    const updates: string[] = ['status = $2'];
    const values: unknown[] = [this.callId, this.status];

    if (this.status === 'ENDED' || this.status === 'FAILED') {
      updates.push('ended_at = NOW()');
    }
    if (this.status === 'HUMAN_DETECTED') {
      updates.push(`wait_duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER`);
    }

    await query(
      `UPDATE calls SET ${updates.join(', ')} WHERE id = $1`,
      values
    );
  }

  private async recordEvent(
    eventType: string,
    previousStatus: CallStatus,
    payload?: Record<string, unknown>
  ): Promise<void> {
    await query(
      `INSERT INTO call_events (call_id, event_type, payload) VALUES ($1, $2, $3)`,
      [this.callId, eventType, JSON.stringify({ from: previousStatus, to: this.status, ...payload })]
    );
  }
}
