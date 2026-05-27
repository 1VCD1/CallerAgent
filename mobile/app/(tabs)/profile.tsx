import { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme';
import { getUser, updateUser, getApiUrl, setApiUrl, getApiKey, setApiKey, getIvrNotes, IvrNote } from '@/api';
import { useCallStore } from '@/store';
import { auth, signOut } from '@/firebase';

export default function ProfileScreen() {
  const { userId } = useCallStore();
  const firebaseUser = auth.currentUser;

  const [name, setName]       = useState('');
  const [phone, setPhone]     = useState('');
  const [birthday, setBirthday] = useState('');
  const [email, setEmail]     = useState('');
  const [apiUrl, setLocalApiUrl] = useState('');
  const [apiKey, setLocalApiKey] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [noteCompany, setNoteCompany] = useState('');
  const [ivrNote, setIvrNote] = useState<IvrNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState('');

  useEffect(() => {
    getApiUrl().then(setLocalApiUrl);
    getApiKey().then(setLocalApiKey);
  }, []);

  useEffect(() => {
    if (!userId) return;
    getUser(userId).then(u => {
      if (u.name)         setName(u.name);
      if (u.phone_number) setPhone(u.phone_number);
      if (u.birthday)     setBirthday(u.birthday.slice(0, 10));
      if (u.email)        setEmail(u.email);
    }).catch(() => {});
  }, [userId]);

  const save = async () => {
    if (!userId) {
      Alert.alert('Not signed in', 'Please sign in first.');
      return;
    }
    setSaving(true);
    try {
      await setApiUrl(apiUrl.trim() || 'http://localhost:3000');
      await setApiKey(apiKey.trim());

      const data: Record<string, string> = {};
      if (name.trim())     data.name = name.trim();
      if (phone.trim())    data.phoneNumber = phone.trim();
      if (birthday.trim()) data.birthday = birthday.trim();
      if (email.trim())    data.email = email.trim();
      if (Object.keys(data).length) await updateUser(userId, data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut().catch(console.warn) },
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.titleRow}>
          <Text style={s.title}>Profile</Text>
          <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut}>
            <Ionicons name="log-out-outline" size={18} color={colors.red} />
            <Text style={s.signOutTxt}>Sign out</Text>
          </TouchableOpacity>
        </View>

        {/* Signed-in user info */}
        {firebaseUser && (
          <View style={s.accountCard}>
            <View style={s.avatar}>
              <Text style={s.avatarTxt}>
                {(firebaseUser.displayName ?? firebaseUser.email ?? '?')[0].toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              {firebaseUser.displayName ? (
                <Text style={s.accountName}>{firebaseUser.displayName}</Text>
              ) : null}
              <Text style={s.accountEmail}>{firebaseUser.email}</Text>
            </View>
          </View>
        )}

        <View style={s.card}>
          <Text style={s.cardTitle}>Personal Info</Text>
          <Text style={s.hint}>The AI uses this when a representative asks for verification</Text>

          <F label="Full Name" placeholder="John Doe" value={name} onChangeText={setName} />
          <F label="Callback Phone" placeholder="+1 234 567 8900" value={phone} onChangeText={setPhone}
            keyboardType="phone-pad" hint="Your phone rings when the AI finds a live rep" />
          <F label="Date of Birth (YYYY-MM-DD)" placeholder="1990-01-15" value={birthday} onChangeText={setBirthday} />
          <F label="Email" placeholder="you@email.com" value={email} onChangeText={setEmail}
            keyboardType="email-address" autoCapitalize="none" />
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Backend</Text>
          <Text style={s.hint}>Change the API URL if you are running a local backend</Text>
          <F label="API URL" placeholder="https://your-app.railway.app" value={apiUrl}
            onChangeText={setLocalApiUrl} autoCapitalize="none" keyboardType="url" />
          <F label="API Key" placeholder="Admin bypass only — leave empty for normal use" value={apiKey}
            onChangeText={setLocalApiKey} autoCapitalize="none" secureTextEntry />
          <TouchableOpacity style={s.testBtn} onPress={async () => {
            const url = apiUrl.trim();
            Alert.alert('Testing…', `Connecting to:\n${url}`);
            try {
              const res = await fetch(`${url}/users/ping-test-404`, {
                headers: { 'ngrok-skip-browser-warning': 'true' },
              });
              Alert.alert('Connected!', `Server responded with HTTP ${res.status}\nURL: ${url}`);
            } catch (e: any) {
              Alert.alert('Failed', `${e.message}\n\nURL tried:\n${url}`);
            }
          }}>
            <Text style={s.testBtnTxt}>Test Connection</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[s.saveBtn, saved && { backgroundColor: colors.greenDark }]} onPress={save} disabled={saving}>
          {saving
            ? <ActivityIndicator color="#fff" />
            : saved
              ? <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={s.saveBtnTxt}>Saved!</Text></>
              : <Text style={s.saveBtnTxt}>Save Profile</Text>
          }
        </TouchableOpacity>

        {/* IVR Notes — testing tool */}
        <View style={s.card}>
          <Text style={s.cardTitle}>🧪 IVR Learning Notes</Text>
          <Text style={s.hint}>View what the AI has learned about a company's IVR system</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              placeholder="Company name (e.g. Amazon)"
              placeholderTextColor={colors.muted}
              value={noteCompany}
              onChangeText={t => { setNoteCompany(t); setIvrNote(null); setNoteError(''); }}
              autoCapitalize="words"
            />
            <TouchableOpacity
              style={s.testBtn}
              disabled={noteLoading || !noteCompany.trim()}
              onPress={async () => {
                setNoteLoading(true); setIvrNote(null); setNoteError('');
                const n = await getIvrNotes(noteCompany.trim());
                if (n) setIvrNote(n);
                else setNoteError('No notes found for this company yet.');
                setNoteLoading(false);
              }}
            >
              {noteLoading
                ? <ActivityIndicator size="small" color={colors.blue} />
                : <Text style={s.testBtnTxt}>Load</Text>
              }
            </TouchableOpacity>
          </View>

          {noteError ? (
            <Text style={{ color: colors.muted, fontSize: 13 }}>{noteError}</Text>
          ) : ivrNote ? (
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                <View style={[s.outcomeBadge, { backgroundColor: ivrNote.outcome === 'human_reached' ? '#052e16' : '#1c1917' }]}>
                  <Text style={[s.outcomeTxt, { color: ivrNote.outcome === 'human_reached' ? colors.green : colors.muted }]}>
                    {ivrNote.outcome === 'human_reached' ? '✓ Human reached' : '✗ ' + ivrNote.outcome}
                  </Text>
                </View>
                <Text style={s.noteMeta}>{ivrNote.updated_at.slice(0, 10)}</Text>
              </View>
              {ivrNote.summary
                .split('\n')
                .filter(l => l.trim().startsWith('-'))
                .map((line, i) => {
                  const content = line.replace(/^[\s-]+/, '');
                  const parts = content.split(/\*\*(.*?)\*\*/g);
                  return (
                    <View key={i} style={s.noteBullet}>
                      <Text style={s.noteDot}>›</Text>
                      <Text style={s.noteBody}>
                        {parts.map((p, j) =>
                          j % 2 === 1
                            ? <Text key={j} style={s.noteBold}>{p}</Text>
                            : p
                        )}
                      </Text>
                    </View>
                  );
                })
              }
            </View>
          ) : null}
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function F({ label, hint, ...p }: { label: string; hint?: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} placeholderTextColor={colors.muted} {...p} />
      {hint && <Text style={s.fieldHint}>{hint}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: colors.bg },
  scroll:     { padding: 16, paddingBottom: 120 },
  titleRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title:      { fontSize: 24, fontWeight: '700', color: colors.text },
  signOutBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  signOutTxt: { fontSize: 14, fontWeight: '600', color: colors.red },
  accountCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 14 },
  avatar:     { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  avatarTxt:  { color: '#fff', fontSize: 18, fontWeight: '700' },
  accountName: { fontSize: 15, fontWeight: '600', color: colors.text },
  accountEmail: { fontSize: 13, color: colors.subtext },
  card:       { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 14 },
  cardTitle:  { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
  hint:       { fontSize: 12, color: colors.muted, marginBottom: 14, lineHeight: 17 },
  label:      { fontSize: 11, fontWeight: '700', color: colors.subtext, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input:      { backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, color: colors.text, fontSize: 14 },
  fieldHint:  { fontSize: 11, color: colors.muted, marginTop: 4, lineHeight: 16 },
  testBtn:     { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  testBtnTxt:  { color: colors.subtext, fontSize: 13, fontWeight: '600' },
  saveBtn:     { backgroundColor: colors.blue, borderRadius: 12, paddingVertical: 15, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  saveBtnTxt:  { color: '#fff', fontSize: 15, fontWeight: '700' },
  noteMeta:      { fontSize: 11, color: colors.muted },
  outcomeBadge:  { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  outcomeTxt:    { fontSize: 12, fontWeight: '700' },
  noteBullet:    { flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'flex-start' },
  noteDot:       { fontSize: 16, color: colors.blue, lineHeight: 20, marginTop: 1 },
  noteBody:      { flex: 1, fontSize: 13, color: colors.subtext, lineHeight: 20 },
  noteBold:      { fontWeight: '700', color: colors.text },
});
