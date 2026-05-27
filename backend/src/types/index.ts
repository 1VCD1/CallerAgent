export type CallStatus =
  | 'INIT'
  | 'DIALING'
  | 'IVR_NAVIGATION'
  | 'EXPLORATION'
  | 'ON_HOLD'
  | 'HUMAN_DETECTED'
  | 'USER_NOTIFIED'
  | 'BRIDGED'
  | 'ENDED'
  | 'FAILED';

export type ActionType =
  | 'press_key'
  | 'say_phrase'
  | 'wait'
  | 'retry'
  | 'end_call'
  | 'escalate_to_user';

export interface LLMAction {
  action: ActionType;
  value?: string;
  reasoning: string;
  confidence?: number;
  isHuman?: boolean;
  humanConfidence?: number;
}

export interface UserInfo {
  name?: string;
  birthday?: string;
}

export interface CallContext {
  callId: string;
  company: string;
  phoneNumber: string;
  goal: string;
  language?: string;
  currentTranscript: string;
  historicalMemory: MemoryPattern[];
  currentCallState: CallStatus;
  previousActions: ActionRecord[];
  recentFailures: string[];
  userInfo?: UserInfo;
  recentHumanConfidences?: number[]; // history of recent scores for consistency check
  speakerChanged?: boolean;           // Deepgram diarization detected a new voice
  availableMenuKeys?: string[];       // DTMF keys explicitly mentioned in current menu
  companyIvrNotes?: string;           // post-call LLM summaries from prior calls to this company
  currentIvrUtterance?: string;       // what the IVR said just now (this turn only)
  consecutiveWaits?: number;          // how many consecutive wait actions taken so far
  consecutiveSameKey?: { key: string; count: number }; // same DTMF key pressed N times in a row
  audioAnalysis?: {
    isHuman: boolean;
    confidence: number;
    rmsVariance: number;
    pitchVariance: number;
    hasDisfluencies: boolean;
    framesAnalyzed: number;
  } | null;
}

export interface ActionRecord {
  action: ActionType;
  value?: string;
  success: boolean;
  timestamp: Date;
}

export interface MemoryPattern {
  id: string;
  company: string;
  goal: string;
  path: string[];
  successRate: number;
  avgWaitSeconds: number;
  lastVerifiedAt: Date;
  strategyEmbedding?: number[];
}

export interface Call {
  id: string;
  company: string;
  phoneNumber: string;
  userPhoneNumber?: string;
  goal: string;
  status: CallStatus;
  twilioCallSid?: string;
  userCallSid?: string;
  conferenceSid?: string;
  startedAt: Date;
  endedAt?: Date;
  humanReached: boolean;
  waitDuration?: number;
  userId: string;
}

export interface CallEvent {
  id: string;
  callId: string;
  timestamp: Date;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface Transcript {
  id: string;
  callId: string;
  speaker: 'AI' | 'IVR' | 'HUMAN';
  text: string;
  timestamp: Date;
}

export interface CreateCallRequest {
  company: string;
  phoneNumber: string;
  userPhoneNumber?: string;
  goal?: string;
  userId: string;
}

export interface CallStateUpdate {
  callId: string;
  status: CallStatus;
  message?: string;
}
