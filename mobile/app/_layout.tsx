import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { getUserId, setUserId, createUser, updateUser } from '@/api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerPushToken() {
  if (!Device.isDevice) return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'CallerAgent',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any).easConfig?.projectId;
  if (!projectId) return; // skip push token without EAS project ID

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

  let uid = await getUserId();
  if (!uid) {
    const u = await createUser();
    uid = u.id;
    await setUserId(uid);
  }
  await updateUser(uid, { pushToken: token });
}

export default function RootLayout() {
  useEffect(() => {
    registerPushToken().catch(console.warn);
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="call/[id]" />
    </Stack>
  );
}
