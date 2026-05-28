export const colors = {
  bg:        '#020617',
  card:      '#0f172a',
  border:    '#1e293b',
  input:     '#1e293b',
  text:      '#F8FAFC',
  subtext:   '#94a3b8',
  muted:     '#64748B',
  blue:      '#3b82f6',
  green:     '#25D366',
  greenDark: '#128C4E',
  red:       '#ef4444',
  yellow:    '#F59E0B',
  orange:    '#f97316',
};

export const STATUS: Record<string, { color: string; bg: string; label: string; pulse?: boolean }> = {
  INIT:           { color: colors.subtext,  bg: '#1e293b',  label: 'Starting…' },
  DIALING:        { color: colors.yellow,   bg: '#422006',  label: 'Dialing…',                      pulse: true },
  IVR_NAVIGATION: { color: colors.blue,     bg: '#1e3a5f',  label: 'Navigating the phone system…',  pulse: true },
  EXPLORATION:    { color: colors.orange,   bg: '#431407',  label: 'Exploring the menu…',            pulse: true },
  ON_HOLD:        { color: colors.orange,   bg: '#431407',  label: 'Waiting on hold…',               pulse: true },
  HUMAN_DETECTED: { color: colors.green,    bg: '#052e16',  label: 'Found a human!' },
  USER_NOTIFIED:  { color: colors.green,    bg: '#052e16',  label: 'Connecting you…' },
  BRIDGED:        { color: '#86efac',       bg: '#052e16',  label: 'Connected' },
  ENDED:          { color: colors.muted,    bg: '#1e293b',  label: 'Ended' },
  FAILED:         { color: colors.red,      bg: '#450a0a',  label: 'Failed' },
};

export const ACTIVE_STATUSES = ['INIT', 'DIALING', 'IVR_NAVIGATION', 'EXPLORATION', 'ON_HOLD', 'HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'];
