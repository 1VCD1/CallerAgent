import { Platform } from 'react-native';
import { getApps, initializeApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
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
  apiKey:            'AIzaSyA0byiMMCmWkn6RENy__8dS677RrqvTagc',
  authDomain:        'calleragent-f880c.firebaseapp.com',
  projectId:         'calleragent-f880c',
  storageBucket:     'calleragent-f880c.firebasestorage.app',
  messagingSenderId: '765448201002',
  appId:             '1:765448201002:web:a40f1c7711ebaa1c68f453',
};

// Google Sign-In → Firebase Console → Authentication → Sign-in method → Google
// → Web SDK configuration → Web client ID
export const GOOGLE_WEB_CLIENT_ID = '765448201002-0uedn3mq2a25itdqo25s5janpmtdrbkq.apps.googleusercontent.com';

const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];

// Web has no getReactNativePersistence — getAuth() uses the browser's default
// (indexedDB/local) persistence. Native uses AsyncStorage-backed RN persistence.
// getReactNativePersistence exists in the RN Metro bundle (dist/rn/) but is absent
// from the Node/TypeScript type declarations — require() bypasses the type check.
export const auth = Platform.OS === 'web'
  ? getAuth(app)
  : initializeAuth(app, {
      persistence: require('firebase/auth').getReactNativePersistence(AsyncStorage),
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
