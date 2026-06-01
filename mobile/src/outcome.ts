export interface OutcomeConfig {
  label: string;
  color: string;
  bg: string;
  border: string;
  icon?: string;
  actionHint?: string;
}

export function getOutcomeConfig(call: {
  human_reached?: boolean;
  user_confirmed?: boolean | null;
  status: string;
  ended_reason?: string;
}): OutcomeConfig {
  // User explicitly rejected AI's human detection
  if (call.human_reached && call.user_confirmed === false) return {
    label: 'AI mistake', color: '#f97316',
    bg: 'rgba(249,115,22,0.10)', border: 'rgba(249,115,22,0.28)',
    icon: 'warning-outline',
    actionHint: 'The AI mistook an automated system for a human. Your feedback has been recorded to improve future calls.',
  };
  // User confirmed or AI correctly detected human
  if (call.human_reached && call.user_confirmed !== false) return {
    label: call.user_confirmed === true ? 'Human reached ✓' : 'Human reached',
    color: '#25D366',
    bg: 'rgba(37,211,102,0.12)', border: 'rgba(37,211,102,0.25)',
  };
  if (call.status === 'FAILED') return {
    label: 'Failed', color: '#ef4444',
    bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.25)',
    actionHint: 'A technical error occurred. Please try again.',
  };
  switch (call.ended_reason) {
    case 'callback_offered':
    case 'callback_scheduled': return {
      label: 'Callback option', color: '#f59e0b',
      bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.30)',
      icon: 'call-outline',
      actionHint: 'The company offered a callback. Call again and our AI will accept it and provide your phone number.',
    };
    case 'voicemail_left': return {
      label: 'Voicemail left', color: '#60a5fa',
      bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.25)',
      icon: 'mic-outline',
      actionHint: 'We left a voicemail on your behalf with your callback number. They may call you back.',
    };
    case 'voicemail': return {
      label: 'Voicemail', color: '#60a5fa',
      bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.25)',
      icon: 'mic-outline',
      actionHint: 'The call went to voicemail. Try calling during business hours.',
    };
    case 'invalid_number': return {
      label: 'Wrong number?', color: '#f97316',
      bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.28)',
      icon: 'warning-outline',
      actionHint: 'This number may be invalid or disconnected. Double-check the phone number and try a different one.',
    };
    case 'outside_hours': return {
      label: 'Closed', color: '#94a3b8',
      bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)',
      icon: 'time-outline',
      actionHint: 'The office was closed when we called. Try again during business hours.',
    };
    case 'busy': return {
      label: 'Line busy', color: '#f59e0b',
      bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.22)',
      actionHint: 'The line was busy. Try again in a few minutes.',
    };
    case 'no-answer': return {
      label: 'No answer', color: '#94a3b8',
      bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)',
      actionHint: 'No one answered. This sometimes happens with high-volume numbers — try again.',
    };
    case 'user_cancelled': return {
      label: 'Cancelled', color: '#64748b',
      bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.20)',
    };
    case 'no_human_path': return {
      label: 'No path to human', color: '#94a3b8',
      bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)',
      icon: 'git-network-outline',
      actionHint: 'The AI navigated extensively but could not find a path to a human representative. Try calling at a different time.',
    };
    case 'max_attempts':
    case 'low_confidence': return {
      label: 'Navigation failed', color: '#f97316',
      bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.22)',
      icon: 'alert-circle-outline',
      actionHint: 'The AI was unable to navigate this phone system. Try calling manually.',
    };
    case 'failed':
    case 'llm_error': return {
      label: 'Error', color: '#ef4444',
      bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.22)',
      actionHint: 'A technical error occurred. Please try again.',
    };
    default: return {
      label: 'No human reached', color: '#64748b',
      bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.25)',
    };
  }
}

export const NON_FAILURE_REASONS = new Set([
  'callback_offered', 'callback_scheduled', 'voicemail', 'voicemail_left',
  'outside_hours', 'busy', 'no-answer', 'user_cancelled',
]);
