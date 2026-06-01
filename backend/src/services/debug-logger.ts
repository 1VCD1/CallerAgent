import { query } from '../db/client';

export type DebugEventType = 'llm_decision' | 'human_detection' | 'call_summary';

// Fire-and-forget — never let debug logging block or crash the main flow
export function logDebug(callId: string, eventType: DebugEventType, data: Record<string, unknown>): void {
  query(
    `INSERT INTO call_debug_logs (call_id, event_type, data) VALUES ($1, $2, $3)`,
    [callId, eventType, JSON.stringify(data)]
  ).catch(err => console.error(`[DebugLog] Failed to write ${eventType} for call ${callId}:`, err));
}
