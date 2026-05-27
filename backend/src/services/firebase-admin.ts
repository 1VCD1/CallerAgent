import * as admin from 'firebase-admin';
import { config } from '../config';

let initialized = false;

export function getFirebaseAdmin(): typeof admin {
  if (!initialized && config.firebase.serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(config.firebase.serviceAccountJson);
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      initialized = true;
      console.log('[Firebase] Admin SDK initialized');
    } catch (err) {
      console.error('[Firebase] Admin SDK init failed:', err);
    }
  }
  return admin;
}

export function isFirebaseReady(): boolean {
  return initialized;
}
