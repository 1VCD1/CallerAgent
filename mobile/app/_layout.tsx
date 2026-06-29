import '@/i18n'; // initialize i18n before anything renders
import { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, Alert } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { onAuthStateChanged, User } from '@/firebase';
import { authLogin, updateUser, getApiUrl } from '@/api';
import { useCallStore } from '@/store';
import { useThemeStore, useThemeColors } from '@/hooks/useTheme';
import i18n from '@/i18n';

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
    if (user === undefined) return;
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
  const { setUserId, setCallbackPhone } = useCallStore();
  const router = useRouter();
  const notifResponseRef = useRef<any>(null);
  const c = useThemeColors();
  const mode = useThemeStore((s) => s.mode);

  // Load the persisted theme once on startup (defaults to light if unset).
  useEffect(() => {
    useThemeStore.getState().hydrate();
  }, []);

  // Navigate to call detail when user taps a push notification
  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as any;
      if (data?.callId && data?.action === 'JOIN_CALL') {
        router.push(`/call/${data.callId}` as any);
      }
    };

    // Tapped while app was running / backgrounded
    notifResponseRef.current = Notifications.addNotificationResponseReceivedListener(handleResponse);

    // Tapped while app was fully closed
    Notifications.getLastNotificationResponseAsync().then(response => {
      if (response) handleResponse(response);
    });

    return () => {
      notifResponseRef.current?.remove();
    };
  }, []);


  useEffect(() => {
    return onAuthStateChanged(async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const profile = await authLogin();
          setUserId(profile.id);
          setCallbackPhone(profile.phone_number ?? null);
          if (profile.language) i18n.changeLanguage(profile.language);
          await registerPushToken(profile.id).catch(console.warn);
        } catch (err: any) {
          Alert.alert('Sign-in error', err?.message ?? String(err));
        }
      } else {
        setUserId(null);
        setCallbackPhone(null);
      }
    });
  }, []);

  useProtectedRoute(user);

  if (user === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        <ActivityIndicator color={c.green} size="large" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="call/[id]" />
        <Stack.Screen name="sign-in" options={{ gestureEnabled: false }} />
      </Stack>
    </>
  );
}
