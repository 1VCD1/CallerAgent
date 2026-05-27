import { EventEmitter } from 'events';

// Global event bus for real-time call status changes.
// SSE connections subscribe here instead of polling the DB.
export const callEvents = new EventEmitter();
callEvents.setMaxListeners(200); // allow many concurrent SSE listeners

export function emitCallStatus(callId: string, status: string): void {
  callEvents.emit(`call:${callId}`, status);
}
