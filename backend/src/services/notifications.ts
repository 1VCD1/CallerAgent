export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// Placeholder for Expo Push Notifications / FCM
// Replace with actual push provider SDK when mobile app is ready
export async function sendPushNotification(
  token: string,
  payload: PushPayload
): Promise<void> {
  const isExpoToken = token.startsWith('ExponentPushToken[');

  if (isExpoToken) {
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
      throw new Error(`Push notification failed: ${text}`);
    }
  } else {
    // FCM or other provider
    console.warn('[Notifications] Non-Expo token — push not implemented:', token.slice(0, 20));
  }

  console.log(`[Notifications] Sent push to ${token.slice(0, 20)}... — ${payload.title}`);
}
