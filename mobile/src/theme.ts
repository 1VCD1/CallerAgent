export const colors = {
  bg:        '#020617',
  card:      '#0f172a',
  border:    '#1e293b',
  input:     '#1e293b',
  text:      '#f1f5f9',
  subtext:   '#94a3b8',
  muted:     '#475569',
  blue:      '#3b82f6',
  green:     '#22c55e',
  greenDark: '#15803d',
  red:       '#ef4444',
  yellow:    '#eab308',
  orange:    '#f97316',
};

export const STATUS: Record<string, { color: string; bg: string; label: string; pulse?: boolean }> = {
  INIT:           { color: colors.subtext,  bg: '#1e293b',  label: 'Starting' },
  DIALING:        { color: colors.yellow,   bg: '#422006',  label: 'Dialing',          pulse: true },
  IVR_NAVIGATION: { color: colors.blue,     bg: '#1e3a5f',  label: 'Navigating IVR',   pulse: true },
  ON_HOLD:        { color: colors.orange,   bg: '#431407',  label: 'On Hold',           pulse: true },
  HUMAN_DETECTED: { color: colors.green,    bg: '#14532d',  label: 'Human Found!' },
  USER_NOTIFIED:  { color: colors.green,    bg: '#14532d',  label: 'Connecting You…' },
  BRIDGED:        { color: '#86efac',       bg: '#052e16',  label: 'Connected' },
  ENDED:          { color: colors.muted,    bg: '#1e293b',  label: 'Ended' },
  FAILED:         { color: colors.red,      bg: '#450a0a',  label: 'Failed' },
};

export const ACTIVE_STATUSES = ['INIT', 'DIALING', 'IVR_NAVIGATION', 'ON_HOLD', 'HUMAN_DETECTED', 'USER_NOTIFIED'];
