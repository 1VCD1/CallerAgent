import AsyncStorage from '@react-native-async-storage/async-storage';
import { getIdToken } from '@/firebase';

export interface UserProfile {
  id: string;
  name?: string;
  email?: string;
  phone_number?: string;
  birthday?: string;
  push_token?: string;
  language?: string;
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
  wait_duration_seconds?: number;
  recording_url?: string;
  ended_reason?: string;
  transcripts?: Transcript[];
}

const DEFAULT_API_URL = 'https://keep-disturbed-limited-endless.trycloudflare.com';

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

export async function authLogin(): Promise<UserProfile> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/auth/login`, {
    method: 'POST',
    headers: await getHeaders(),
  });
  if (!res.ok) throw new Error('Auth failed');
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
  const res = await fetch(`${url}/calls`, {
    method: 'POST',
    headers: await getHeaders(),
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err?.message ?? 'Failed to start call');
  }
  return res.json();
}

export async function getCalls(limit = 20): Promise<Call[]> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/calls?limit=${limit}`, { headers: await getHeaders() });
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

export interface IvrNote {
  summary: string;
  outcome: string;
  updated_at: string;
}

export async function getIvrNotes(company: string): Promise<IvrNote | null> {
  const url = await getApiUrl();
  const res = await fetch(`${url}/ivr-notes/${encodeURIComponent(company)}`, { headers: await getHeaders() });
  if (!res.ok) return null;
  return res.json();
}
