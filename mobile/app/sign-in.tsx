import { useEffect, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import { auth, GOOGLE_WEB_CLIENT_ID } from '@/firebase';
import { type Palette } from '@/theme';
import { useThemeColors, useThemeStore } from '@/hooks/useTheme';

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const [loading, setLoading] = useState(false);
  const c = useThemeColors();
  const mode = useThemeStore((st) => st.mode);
  const s = useMemo(() => makeStyles(c), [c]);
  const glow: [string, string, string] = mode === 'dark'
    ? ['#0f2a4a', c.bg, c.bg]
    : ['#dbeafe', c.bg, c.bg];

  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: '765448201002-7vn8b02k4ph1qiouv7l88tr8kc4lpcab.apps.googleusercontent.com',
    androidClientId: '765448201002-al748nhq23aqq7qjhqvhdqahqisabpom.apps.googleusercontent.com',
    prompt: 'select_account',
  } as any);

  useEffect(() => {
    if (response?.type !== 'success') return;
    const idToken = (response.params as any).id_token;
    if (!idToken) {
      Alert.alert('Sign-in failed', 'No ID token received from Google.');
      return;
    }
    setLoading(true);
    const credential = GoogleAuthProvider.credential(idToken);
    signInWithCredential(auth, credential)
      .catch(err => Alert.alert('Sign-in failed', err.message))
      .finally(() => setLoading(false));
  }, [response]);

  return (
    <SafeAreaView style={s.safe}>
      {/* Ambient glow */}
      <LinearGradient
        colors={glow}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
        pointerEvents="none"
      />

      <View style={s.container}>

        {/* Brand */}
        <View style={s.brand}>
          <Image source={require('../assets/icon.png')} style={s.logo} />
          <Text style={s.title}>CallerAgent</Text>
          <Text style={s.subtitle}>Skip the hold music.</Text>
        </View>

        {/* Bottom actions */}
        <View style={s.bottom}>
          <TouchableOpacity
            style={[s.googleBtn, (!request || loading) && s.disabled]}
            onPress={() => promptAsync()}
            disabled={!request || loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#1a1a1a" />
            ) : (
              <>
                <Text style={s.googleG}>G</Text>
                <Text style={s.googleTxt}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={s.legal}>
            By continuing you agree to CallerAgent's terms of service.
          </Text>
        </View>

      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  safe:      { flex: 1, backgroundColor: c.bg },
  container: { flex: 1, paddingHorizontal: 28, paddingVertical: 16, justifyContent: 'space-between' },

  brand: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  logo:     { width: 68, height: 68, borderRadius: 18, marginBottom: 6 },
  title:    { fontSize: 34, fontWeight: '300', color: c.text, letterSpacing: 1.5 },
  subtitle: { fontSize: 15, color: c.subtext, letterSpacing: 0.3 },

  bottom: { gap: 16, paddingBottom: 8 },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 17,
    borderWidth: 1,
    borderColor: c.border,
  },
  googleG:   { fontSize: 17, fontWeight: '800', color: '#4285F4' },
  googleTxt: { fontSize: 16, fontWeight: '600', color: '#111827' },
  disabled:  { opacity: 0.45 },
  legal:     { fontSize: 12, color: c.muted, textAlign: 'center', lineHeight: 17 },
});
