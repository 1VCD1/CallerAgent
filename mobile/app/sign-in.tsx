import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import { auth, GOOGLE_WEB_CLIENT_ID } from '@/firebase';

WebBrowser.maybeCompleteAuthSession();

const FEATURES = [
  { icon: '📞', text: 'AI navigates the IVR so you don\'t have to' },
  { icon: '👤', text: 'Get notified the moment a human answers' },
  { icon: '📝', text: 'Full transcript saved after every call' },
];

export default function SignInScreen() {
  const [loading, setLoading] = useState(false);

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
      <View style={s.container}>

        {/* Logo */}
        <Image source={require('../assets/icon.png')} style={s.logo} />
        <Text style={s.title}>CallerAgent</Text>
        <Text style={s.subtitle}>Your AI phone assistant</Text>

        {/* Features */}
        <View style={s.features}>
          {FEATURES.map((f, i) => (
            <View key={i} style={s.featureRow}>
              <Text style={s.featureIcon}>{f.icon}</Text>
              <Text style={s.featureText}>{f.text}</Text>
            </View>
          ))}
        </View>

        {/* Google button */}
        <TouchableOpacity
          style={[s.googleBtn, (!request || loading) && s.disabled]}
          onPress={() => promptAsync()}
          disabled={!request || loading}
        >
          {loading
            ? <ActivityIndicator color="#1a1a1a" />
            : (
              <>
                <Text style={s.googleIcon}>G</Text>
                <Text style={s.googleBtnTxt}>Continue with Google</Text>
              </>
            )
          }
        </TouchableOpacity>

        <Text style={s.legal}>
          By signing in you agree that your calls are processed by the CallerAgent AI service.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: '#020617' },
  container:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  logo:         { width: 80, height: 80, borderRadius: 20, marginBottom: 16 },
  title:        { fontSize: 30, fontWeight: '800', color: '#f1f5f9', marginBottom: 6 },
  subtitle:     { fontSize: 15, color: '#64748b', marginBottom: 36 },
  features:     { width: '100%', backgroundColor: '#0f172a', borderRadius: 16, borderWidth: 1, borderColor: '#1e293b', padding: 20, marginBottom: 36, gap: 16 },
  featureRow:   { flexDirection: 'row', alignItems: 'center', gap: 14 },
  featureIcon:  { fontSize: 22 },
  featureText:  { fontSize: 14, color: '#94a3b8', lineHeight: 20, flex: 1 },
  googleBtn:    { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 16, paddingHorizontal: 28, width: '100%', justifyContent: 'center' },
  googleIcon:   { fontSize: 18, fontWeight: '800', color: '#4285F4' },
  googleBtnTxt: { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  disabled:     { opacity: 0.5 },
  legal:        { marginTop: 24, fontSize: 12, color: '#334155', textAlign: 'center', lineHeight: 18 },
});
