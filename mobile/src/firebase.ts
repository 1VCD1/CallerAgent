import { getApps, initializeApp } from 'firebase/app';
import {
  initializeAuth,
  onAuthStateChanged as _onAuthStateChanged,
  signOut as _signOut,
  User,
} from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────────────────────────────────────
// SETUP REQUIRED — fill in your Firebase project settings:
//   Firebase Console → Project Settings → Your apps → Web app → Config snippet
// ─────────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'REPLACE_WITH_YOUR_API_KEY',
  authDomain:        'REPLACE_WITH_YOUR_PROJECT.firebaseapp.com',
  projectId:         'REPLACE_WITH_YOUR_PROJECT_ID',
  storageBucket:     'REPLACE_WITH_YOUR_PROJECT.appspot.com',
  messagingSenderId: 'REPLACE_WITH_YOUR_SENDER_ID',
  appId:             'REPLACE_WITH_YOUR_APP_ID',
};

// Google Sign-In → Firebase Console → Authentication → Sign-in method → Google
// → Web SDK configuration → Web client ID
export const GOOGLE_WEB_CLIENT_ID = 'REPLACE_WITH_YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';

// Custom AsyncStorage persistence (getReactNativePersistence was removed in Firebase v12)
const asyncStoragePersistence = {
  type: 'LOCAL',
  async _isAvailable() { return true; },
  async _set(key: string, value: unknown) {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  },
  async _get(key: string) {
    const str = await AsyncStorage.getItem(key);
    if (str === null) return null;
    try { return JSON.parse(str); } catch { return null; }
  },
  async _remove(key: string) {
    await AsyncStorage.removeItem(key);
  },
  _addListener() {},
  _removeListener() {},
};

const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];

export const auth = initializeAuth(app, {
  persistence: asyncStoragePersistence as any,
});

/** Subscribe to auth state changes. Returns unsubscribe function. */
export function onAuthStateChanged(callback: (user: User | null) => void): () => void {
  return _onAuthStateChanged(auth, callback);
}

/** Returns the current user's Firebase ID token, auto-refreshing if expired. */
export async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export function signOut(): Promise<void> {
  return _signOut(auth);
}

export type { User };
