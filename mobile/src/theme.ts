export interface Palette {
  bg:        string;
  card:      string;
  border:    string;
  input:     string;
  text:      string;
  subtext:   string;
  muted:     string;
  blue:      string;
  green:     string;
  greenDark: string;
  red:       string;
  yellow:    string;
  orange:    string;
  // Translucent fill for chips / inputs (tinted toward the opposite of the bg).
  overlay:   string;
  // Tab bar surface + hairline.
  tabBar:       string;
  tabBarBorder: string;
}

export const darkColors: Palette = {
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
  overlay:      'rgba(255,255,255,0.04)',
  tabBar:       'rgba(15,23,42,0.96)',
  tabBarBorder: 'rgba(30,41,59,0.6)',
};

export const lightColors: Palette = {
  bg:        '#F8FAFC',
  card:      '#FFFFFF',
  border:    '#E2E8F0',
  input:     '#F1F5F9',
  text:      '#0F172A',
  subtext:   '#475569',
  muted:     '#64748B',
  blue:      '#2563EB',
  green:     '#128C4E',
  greenDark: '#0d5c34',
  red:       '#dc2626',
  yellow:    '#D97706',
  orange:    '#ea580c',
  overlay:      'rgba(15,23,42,0.04)',
  tabBar:       'rgba(255,255,255,0.96)',
  tabBarBorder: 'rgba(226,232,240,0.9)',
};

export type ThemeMode = 'light' | 'dark';

export const PALETTES: Record<ThemeMode, Palette> = {
  dark:  darkColors,
  light: lightColors,
};

// STATUS backgrounds use rgba tints so a badge reads correctly on either theme
// (a translucent tint over the card, rather than a solid dark swatch).
export const STATUS: Record<string, { color: string; bg: string; label: string; pulse?: boolean }> = {
  INIT:           { color: '#94a3b8', bg: 'rgba(148,163,184,0.14)', label: 'Starting…' },
  DIALING:        { color: '#F59E0B', bg: 'rgba(245,158,11,0.14)',  label: 'Dialing…',                      pulse: true },
  IVR_NAVIGATION: { color: '#3b82f6', bg: 'rgba(59,130,246,0.14)',  label: 'Navigating the phone system…',  pulse: true },
  EXPLORATION:    { color: '#f97316', bg: 'rgba(249,115,22,0.14)',  label: 'Exploring the menu…',            pulse: true },
  ON_HOLD:        { color: '#f97316', bg: 'rgba(249,115,22,0.14)',  label: 'Waiting on hold…',               pulse: true },
  HUMAN_DETECTED: { color: '#25D366', bg: 'rgba(37,211,102,0.14)',  label: 'Found a human!' },
  USER_NOTIFIED:  { color: '#25D366', bg: 'rgba(37,211,102,0.14)',  label: 'Connecting you…' },
  BRIDGED:        { color: '#16a34a', bg: 'rgba(37,211,102,0.14)',  label: 'Connected' },
  ENDED:          { color: '#64748B', bg: 'rgba(100,116,139,0.14)', label: 'Ended' },
  FAILED:         { color: '#ef4444', bg: 'rgba(239,68,68,0.14)',   label: 'Failed' },
};

export const ACTIVE_STATUSES = ['INIT', 'DIALING', 'IVR_NAVIGATION', 'EXPLORATION', 'ON_HOLD', 'HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'];
