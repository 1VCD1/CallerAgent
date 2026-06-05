import AsyncStorage from '@react-native-async-storage/async-storage';
import { getIdToken } from '@/firebase';

export interface UserProfile {
  id: string;
  name?: string;
  email?: string;
  phone_number?: string;
  birthday?: string;
  push_token?: string;
  language?: 'en' | 'zh-TW' | 'zh-CN';
}

export interface Transcript {
  id: string;
  speaker: 'AI' | 'IVR' | 'HUMAN';
  text: string;
  timestamp: string;
  human_confidence?: number;
}

export interface Call {
  id: string;
  company: string;
  phone_number: string;
  goal: string;
  status: string;
  started_at: string;
  ended_at?: string;
  human_reached: boolean;
  human_confidence?: number;
  user_confirmed?: boolean | null;
  wait_duration_seconds?: number;
  recording_url?: string;
  ended_reason?: string;
  transcripts?: Transcript[];
}

const DEFAULT_API_URL = 'https://calleragent-production.up.railway.app';

async function getHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken();
  if (token) {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  }
  // fallback: API key for admin/local dev bypass
  const key = await AsyncStorage.getItem('apiKey');
  return {
    'Content-Type': 'application/json',
    ...(key ? { 'X-Api-Key': key } : {}),
  };
}

export async function getApiUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem('apiUrl');
  const isStale = !stored || stored === 'http://localhost:3000' || stored !== DEFAULT_API_URL && (stored.includes('loca.lt') || stored.includes('ngrok'));
  if (isStale) {
    await AsyncStorage.setItem('apiUrl', DEFAULT_API_URL);
    return DEFAULT_API_URL;
  }
  return stored;
}

export async function setApiUrl(url: string): Promise<void> {
  await AsyncStorage.setItem('apiUrl', url.replace(/\/$/, ''));
}

export async function getApiKey(): Promise<string> {
  return (await AsyncStorage.getItem('apiKey')) ?? '';
}

export async function setApiKey(key: string): Promise<void> {
  await AsyncStorage.setItem('apiKey', key);
}

async function getStoredUserId(): Promise<string | null> {
  return AsyncStorage.getItem('devUserId');
}

export async function ensureDevUser(): Promise<string> {
  const existing = await AsyncStorage.getItem('devUserId');
  if (existing) return existing;
  const url = await getApiUrl();
  const res = await fetch(`${url}/users`, {
    method: 'POST',
    headers: await getHeaders(),
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error('Failed to create dev user');
  const user = await res.json() as UserProfile;
  await AsyncStorage.setItem('devUserId', user.id);
  return user.id;
}

export async function authLogin(): Promise<UserProfile> {
  const url = await getApiUrl();
  const headers = await getHeaders();
  const res = await fetch(`${url}/auth/login`, { method: 'POST', headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Auth failed ${res.status}: ${body.slice(0, 200)} [token=${headers['Authorization'] ? 'present' : 'missing'}]`);
  }
  return res.json();
}

export async function getUser(userId: string): Promise<UserProfile> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/users/${userId}`, { headers: await getHeaders() });
  if (!res.ok) throw new Error('User not found');
  return res.json();
}

export async function updateUser(
  userId: string,
  data: Partial<{
    name: string; email: string; phoneNumber: string;
    birthday: string; pushToken: string; language: string;
  }>
): Promise<UserProfile> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/users/${userId}`, {
    method: 'PATCH',
    headers: await getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update user');
  return res.json();
}

export async function startCall(
  params: { company: string; phoneNumber: string; goal?: string; ivrLanguage?: string }
): Promise<{ callId: string; status: string }> {
  const url = await getApiUrl();
  const token = await getIdToken();
  const devUserId = !token ? await getStoredUserId() : null;
  const res = await fetch(`${url}/calls`, {
    method: 'POST',
    headers: await getHeaders(),
    body: JSON.stringify({ ...params, ...(devUserId ? { userId: devUserId } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = (() => { try { return JSON.parse(body); } catch { return {}; } })() as any;
    const e = new Error(err?.error ?? err?.message ?? `Server error ${res.status}: ${body.slice(0, 120)}`) as any;
    e.status = res.status;
    e.code   = err?.code;
    e.callId = err?.callId;
    throw e;
  }
  return res.json();
}

export async function getCalls(limit = 20): Promise<Call[]> {
  const url = await getApiUrl();
  const token = await getIdToken();
  const devUserId = !token ? await getStoredUserId() : null;
  const qs = `limit=${limit}${devUserId ? `&userId=${devUserId}` : ''}`;
  const res = await fetch(`${url}/calls?${qs}`, { headers: await getHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function getCall(callId: string): Promise<Call> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/calls/${callId}`, { headers: await getHeaders() });
  if (!res.ok) throw new Error('Call not found');
  return res.json();
}

export async function endCall(callId: string): Promise<void> {
  const url = await getApiUrl();
  await fetch(`${url}/calls/${callId}`, { method: 'DELETE', headers: await getHeaders() });
}

export interface CompanyStats {
  total: number;
  successful: number;
  successPct: number;
  avgWaitSecs: number | null;
}

export async function getCompanySuggestions(q: string): Promise<Array<{ company: string; phone: string }>> {
  if (q.trim().length < 2) return [];
  const url = await getApiUrl();
  const token = await getIdToken();
  const devUserId = !token ? await getStoredUserId() : null;
  // Pass userId so backend can rank user's own calls first; global results still fill the rest
  const params = new URLSearchParams({ q: q.trim(), ...(devUserId ? { userId: devUserId } : {}) });
  const res = await fetch(`${url}/company-suggestions?${params}`, { headers: await getHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function getCompanyStats(company: string): Promise<CompanyStats | null> {
  if (!company.trim()) return null;
  const url = await getApiUrl();
  const token = await getIdToken();
  const devUserId = !token ? await getStoredUserId() : null;
  const qs = devUserId ? `?userId=${devUserId}` : '';
  const res = await fetch(`${url}/company-stats/${encodeURIComponent(company)}${qs}`, { headers: await getHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data ?? null;
}

export async function getCompanyNote(company: string): Promise<string | null> {
  const url = await getApiUrl();
  const token = await getIdToken();
  const devUserId = !token ? await getStoredUserId() : null;
  const qs = devUserId ? `?userId=${devUserId}` : '';
  const res = await fetch(`${url}/company-notes/${encodeURIComponent(company)}${qs}`, { headers: await getHeaders() });
  if (!res.ok) return null;
  const data = await res.json() as { note: string } | null;
  return data?.note ?? null;
}

export async function saveCompanyNote(company: string, note: string): Promise<void> {
  const url = await getApiUrl();
  const token = await getIdToken();
  const devUserId = !token ? await getStoredUserId() : null;
  await fetch(`${url}/company-notes/${encodeURIComponent(company)}`, {
    method: 'PUT',
    headers: await getHeaders(),
    body: JSON.stringify({ note, ...(devUserId ? { userId: devUserId } : {}) }),
  });
}

export interface IvrNote {
  summary: string;
  outcome: string;
  updated_at: string;
}

export async function submitCallFeedback(callId: string, confirmed: boolean): Promise<void> {
  const url = await getApiUrl();
  await fetch(`${url}/calls/${callId}/feedback`, {
    method: 'PATCH',
    headers: await getHeaders(),
    body: JSON.stringify({ confirmed }),
  });
}

export async function getIvrNotes(company: string): Promise<IvrNote | null> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/ivr-notes/${encodeURIComponent(company)}`, { headers: await getHeaders() });
  if (!res.ok) return null;
  return res.json();
}
