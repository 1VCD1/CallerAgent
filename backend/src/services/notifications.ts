import { getFirebaseAdmin, isFirebaseReady } from './firebase-admin';

// Ensure Firebase is initialized (idempotent)
getFirebaseAdmin();

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendPushNotification(token: string, payload: PushPayload): Promise<void> {
  const isExpoToken = token.startsWith('ExponentPushToken[');

  if (isExpoToken) {
    await sendExpoNotification(token, payload);
  } else {
    await sendFcmNotification(token, payload);
  }

  console.log(`[Notifications] Sent push to ${token.slice(0, 24)}… — ${payload.title}`);
}

async function sendExpoNotification(token: string, payload: PushPayload): Promise<void> {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      priority: 'high',
      sound: 'default',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Expo push failed: ${text}`);
  }

  const json = await response.json() as { data?: { status: string; message?: string } };
  if (json.data?.status === 'error') {
    throw new Error(`Expo push error: ${json.data.message}`);
  }
}

async function sendFcmNotification(token: string, payload: PushPayload): Promise<void> {
  if (!isFirebaseReady()) {
    console.warn('[Notifications] FCM token received but Firebase not configured — push skipped');
    return;
  }

  const admin = getFirebaseAdmin();
  await admin.messaging().send({
    token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data ?? {},
    android: {
      priority: 'high',
      notification: { sound: 'default' },
    },
    apns: {
      payload: { aps: { sound: 'default' } },
    },
  });
}
