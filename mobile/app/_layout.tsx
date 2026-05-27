import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { onAuthStateChanged, User } from '@/firebase';
import { authLogin, updateUser, getApiUrl } from '@/api';
import { useCallStore } from '@/store';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerPushToken(userId: string) {
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
  if (!projectId) return;

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await updateUser(userId, { pushToken: token });
}

function useProtectedRoute(user: User | null | undefined) {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (user === undefined) return; // still loading
    const inSignIn = segments[0] === 'sign-in';
    if (!user && !inSignIn) {
      router.replace('/sign-in');
    } else if (user && inSignIn) {
      router.replace('/');
    }
  }, [user, segments]);
}

export default function RootLayout() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const { setUserId } = useCallStore();

  useEffect(() => {
    return onAuthStateChanged(async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const profile = await authLogin();
          setUserId(profile.id);
          await registerPushToken(profile.id).catch(console.warn);
        } catch (err) {
          console.warn('[Auth] authLogin failed:', err);
        }
      } else {
        setUserId(null);
      }
    });
  }, []);

  useProtectedRoute(user);

  if (user === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: '#020617', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="call/[id]" />
      <Stack.Screen name="sign-in" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
