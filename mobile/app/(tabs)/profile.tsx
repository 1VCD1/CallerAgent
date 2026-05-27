import { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme';
import { getUserId, setUserId, createUser, getUser, updateUser, getApiUrl, setApiUrl, getIvrNotes, IvrNote } from '@/api';

const LANGUAGES = [
  { code: 'en',    label: 'English'  },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'zh-CN', label: '简体中文' },
] as const;

export default function ProfileScreen() {
  const [userId, setLocalUserId] = useState<string | null>(null);
  const [name, setName]       = useState('');
  const [phone, setPhone]     = useState('');
  const [birthday, setBirthday] = useState('');
  const [email, setEmail]     = useState('');
  const [language, setLanguage] = useState<'en' | 'zh-TW' | 'zh-CN'>('en');
  const [apiUrl, setLocalApiUrl] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [noteCompany, setNoteCompany] = useState('');
  const [ivrNote, setIvrNote] = useState<IvrNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState('');

  useEffect(() => {
    (async () => {
      setLocalApiUrl(await getApiUrl());
      try {
        let uid = await getUserId();
        if (!uid) { const u = await createUser(); uid = u.id; await setUserId(uid); }
        setLocalUserId(uid);
        const u = await getUser(uid);
        if (u.name)         setName(u.name);
        if (u.phone_number) setPhone(u.phone_number);
        if (u.birthday)     setBirthday(u.birthday.slice(0, 10));
        if (u.email)        setEmail(u.email);
        if (u.language)     setLanguage(u.language as any);
      } catch {}
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await setApiUrl(apiUrl.trim() || 'http://localhost:3000');

      let uid = userId;
      if (!uid) {
        const u = await createUser();
        uid = u.id;
        await setUserId(uid);
        setLocalUserId(uid);
      }

      const data: Record<string, string> = {};
      if (name.trim())     data.name = name.trim();
      if (phone.trim())    data.phoneNumber = phone.trim();
      if (birthday.trim()) data.birthday = birthday.trim();
      if (email.trim())    data.email = email.trim();
      data.language = language;
      if (Object.keys(data).length) await updateUser(uid, data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Profile</Text>
        {userId && <Text style={s.uid}>ID: {userId.slice(0, 8)}…</Text>}

        <View style={s.card}>
          <Text style={s.cardTitle}>Personal Info</Text>
          <Text style={s.hint}>The AI uses this when a representative asks for verification</Text>

          <F label="Full Name" placeholder="John Doe" value={name} onChangeText={setName} />
          <F label="Callback Phone" placeholder="+1 234 567 8900" value={phone} onChangeText={setPhone}
            keyboardType="phone-pad" hint="Your phone rings when the AI finds a live rep" />
          <F label="Date of Birth (YYYY-MM-DD)" placeholder="1990-01-15" value={birthday} onChangeText={setBirthday} />
          <F label="Email" placeholder="you@email.com" value={email} onChangeText={setEmail}
            keyboardType="email-address" autoCapitalize="none" />

          <Text style={s.label}>Language / 語言</Text>
          <View style={s.langRow}>
            {LANGUAGES.map(({ code, label }) => (
              <TouchableOpacity
                key={code}
                style={[s.langBtn, language === code && s.langBtnActive]}
                onPress={() => setLanguage(code as any)}
              >
                <Text style={[s.langLabel, language === code && { color: colors.blue }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Backend</Text>
          <Text style={s.hint}>Set this to your ngrok URL or local IP when running on a physical device</Text>
          <F label="API URL" placeholder="https://xxxx.ngrok-free.dev" value={apiUrl}
            onChangeText={setLocalApiUrl} autoCapitalize="none" keyboardType="url" />
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
                  // split on **...** to extract bold segments
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
  title:      { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 2 },
  uid:        { fontSize: 12, color: colors.muted, marginBottom: 20 },
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
  langRow:     { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  langBtn:     { flex: 1, minWidth: 90, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, alignItems: 'center', gap: 4, backgroundColor: colors.input },
  langBtnActive:{ borderColor: colors.blue, backgroundColor: '#1e3a5f' },
  langLabel:   { fontSize: 13, fontWeight: '600', color: colors.subtext },
  noteMeta:      { fontSize: 11, color: colors.muted },
  outcomeBadge:  { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  outcomeTxt:    { fontSize: 12, fontWeight: '700' },
  noteBullet:    { flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'flex-start' },
  noteDot:       { fontSize: 16, color: colors.blue, lineHeight: 20, marginTop: 1 },
  noteBody:      { flex: 1, fontSize: 13, color: colors.subtext, lineHeight: 20 },
  noteBold:      { fontWeight: '700', color: colors.text },
});
