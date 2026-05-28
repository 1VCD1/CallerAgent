import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Switch,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '@/theme';
import { getUser, updateUser, getApiUrl, setApiUrl, getApiKey, setApiKey, getIvrNotes, IvrNote } from '@/api';
import { useCallStore } from '@/store';
import { auth, signOut } from '@/firebase';

export default function ProfileScreen() {
  const { userId } = useCallStore();
  const firebaseUser = auth.currentUser;

  const [name, setName]         = useState('');
  const [phone, setPhone]       = useState('');
  const [birthday, setBirthday] = useState('');
  const [email, setEmail]       = useState('');
  const [apiUrl, setLocalApiUrl]   = useState('');
  const [apiKey, setLocalApiKey]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [showDev, setShowDev]   = useState(false);
  const [editMode, setEditMode] = useState(false);

  const [noteCompany, setNoteCompany] = useState('');
  const [ivrNote, setIvrNote]         = useState<IvrNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError]     = useState('');

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
      await setApiUrl(apiUrl.trim() || 'http://localhost:3000');
      await setApiKey(apiKey.trim());
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      return;
    }
    setSaving(true);
    try {
      await setApiUrl(apiUrl.trim() || 'http://localhost:3000');
      await setApiKey(apiKey.trim());
      const data: Record<string, string> = {};
      if (name.trim())     data.name = name.trim();
      if (phone.trim()) {
        const raw = phone.trim();
        data.phoneNumber = raw.startsWith('+') ? raw : `+1${raw.replace(/\D/g, '')}`;
      }
      if (birthday.trim()) data.birthday = birthday.trim();
      if (email.trim())    data.email    = email.trim();
      if (Object.keys(data).length) await updateUser(userId, data);
      setSaved(true); setEditMode(false);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Save failed');
    } finally { setSaving(false); }
  };

  const handleSignOut = () => {
    Alert.alert('Sign out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut().catch(console.warn) },
    ]);
  };

  const initials = (firebaseUser?.displayName ?? firebaseUser?.email ?? userId ?? '?')[0].toUpperCase();
  const displayName = firebaseUser?.displayName ?? (userId ? `User ${userId.slice(0, 6)}` : 'You');
  const displayEmail = firebaseUser?.email ?? (userId ? 'Dev mode' : '');

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAwareScrollView
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
        extraScrollHeight={120}
        enableOnAndroid
      >

          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>You</Text>
            <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut}>
              <Ionicons name="log-out-outline" size={17} color={colors.red} />
              <Text style={s.signOutTxt}>Sign out</Text>
            </TouchableOpacity>
          </View>

          {/* Avatar + name */}
          <View style={s.avatarSection}>
            <View style={s.avatar}>
              <Text style={s.avatarTxt}>{initials}</Text>
            </View>
            <Text style={s.displayName}>{displayName}</Text>
            {displayEmail ? <Text style={s.displayEmail}>{displayEmail}</Text> : null}
          </View>

          {/* Preferences section */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>PREFERENCES</Text>

            <SettingRow
              icon="call-outline"
              label="Callback phone"
              value={phone || 'Not set'}
              onPress={editMode ? undefined : () => setEditMode(true)}
              valueColor={phone ? colors.text : colors.muted}
            />
            <SettingDivider />
            <SettingRow
              icon="language-outline"
              label="Language preference"
              value="English"
            />
          </View>

          {/* Edit personal info (shown when editMode) */}
          {editMode && (
            <View style={s.editCard}>
              <Text style={s.editCardTitle}>Personal Info</Text>
              <Text style={s.editCardHint}>Used by AI when a representative asks for verification</Text>

              <Field label="Full Name"      placeholder="John Doe"          value={name}     onChangeText={setName} />
              <Field label="Callback Phone" placeholder="234 567 8900"      value={phone}    onChangeText={setPhone} keyboardType="phone-pad"
                hint="Your phone rings when the AI finds a live rep" />
              <View style={s.fieldWrap}>
                <Text style={s.fieldLabel}>DATE OF BIRTH</Text>
                <TextInput
                  style={s.input}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.muted}
                  value={birthday}
                  keyboardType="number-pad"
                  maxLength={10}
                  onChangeText={t => {
                    const digits = t.replace(/\D/g, '');
                    let f = digits;
                    if (digits.length > 4) f = digits.slice(0, 4) + '-' + digits.slice(4);
                    if (digits.length > 6) f = digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8);
                    setBirthday(f);
                  }}
                />
              </View>
              <Field label="Email" placeholder="you@email.com" value={email} onChangeText={setEmail}
                keyboardType="email-address" autoCapitalize="none" />

              <TouchableOpacity onPress={save} disabled={saving} activeOpacity={0.85} style={s.saveBtnWrap}>
                <LinearGradient
                  colors={saved ? ['#128C4E', '#0d5c34'] : ['#25D366', '#128C4E']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={s.saveBtn}
                >
                  {saving
                    ? <ActivityIndicator color="#fff" />
                    : saved
                      ? <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={s.saveBtnTxt}>Saved!</Text></>
                      : <Text style={s.saveBtnTxt}>Save</Text>
                  }
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity style={s.cancelBtn} onPress={() => setEditMode(false)}>
                <Text style={s.cancelBtnTxt}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Developer options toggle */}
          <TouchableOpacity style={s.devToggle} onPress={() => setShowDev(v => !v)}>
            <Ionicons name="code-slash-outline" size={15} color={colors.muted} />
            <Text style={s.devToggleTxt}>Developer Options</Text>
            <Ionicons name={showDev ? 'chevron-up' : 'chevron-down'} size={14} color={colors.muted} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>

          {showDev && (
            <View style={s.editCard}>
              <Field label="API URL" placeholder="https://your-app.railway.app" value={apiUrl}
                onChangeText={setLocalApiUrl} autoCapitalize="none" keyboardType="url" />
              <Field label="API Key" placeholder="Admin bypass only" value={apiKey}
                onChangeText={setLocalApiKey} autoCapitalize="none" secureTextEntry />

              <TouchableOpacity style={s.testBtn} onPress={async () => {
                const url = apiUrl.trim();
                try {
                  const res = await fetch(`${url}/users/ping-test-404`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
                  Alert.alert('Connected!', `HTTP ${res.status}\n${url}`);
                } catch (e: any) { Alert.alert('Failed', `${e.message}\n${url}`); }
              }}>
                <Text style={s.testBtnTxt}>Test Connection</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={save} disabled={saving} activeOpacity={0.85} style={[s.saveBtnWrap, { marginTop: 12 }]}>
                <LinearGradient
                  colors={['#25D366', '#128C4E']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={s.saveBtn}
                >
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.saveBtnTxt}>Save Settings</Text>}
                </LinearGradient>
              </TouchableOpacity>

              {/* IVR Notes */}
              <View style={{ marginTop: 20 }}>
                <Text style={s.fieldLabel}>IVR LEARNING NOTES</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TextInput
                    style={[s.input, { flex: 1 }]}
                    placeholder="Company name"
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
                      if (n) setIvrNote(n); else setNoteError('No notes found yet.');
                      setNoteLoading(false);
                    }}
                  >
                    {noteLoading ? <ActivityIndicator size="small" color={colors.blue} /> : <Text style={s.testBtnTxt}>Load</Text>}
                  </TouchableOpacity>
                </View>
                {noteError ? <Text style={{ color: colors.muted, fontSize: 13, marginTop: 8 }}>{noteError}</Text> : null}
                {ivrNote && (
                  <View style={{ marginTop: 12 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                      <View style={[s.outcomeBadge, { backgroundColor: ivrNote.outcome === 'human_reached' ? 'rgba(37,211,102,0.12)' : colors.card }]}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: ivrNote.outcome === 'human_reached' ? colors.green : colors.muted }}>
                          {ivrNote.outcome === 'human_reached' ? '✓ Human reached' : '✗ ' + ivrNote.outcome}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: colors.muted }}>{ivrNote.updated_at.slice(0, 10)}</Text>
                    </View>
                    {ivrNote.summary.split('\n').filter(l => l.trim().startsWith('-')).map((line, i) => {
                      const content = line.replace(/^[\s-]+/, '');
                      const parts   = content.split(/\*\*(.*?)\*\*/g);
                      return (
                        <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                          <Text style={{ fontSize: 16, color: colors.blue, lineHeight: 20 }}>›</Text>
                          <Text style={{ flex: 1, fontSize: 13, color: colors.subtext, lineHeight: 20 }}>
                            {parts.map((p, j) => j % 2 === 1 ? <Text key={j} style={{ fontWeight: '700', color: colors.text }}>{p}</Text> : p)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            </View>
          )}

      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function SettingRow({ icon, label, value, onPress, valueColor }: {
  icon: string; label: string; value?: string; onPress?: () => void; valueColor?: string;
}) {
  return (
    <TouchableOpacity style={sr.row} onPress={onPress} disabled={!onPress} activeOpacity={0.7}>
      <Ionicons name={icon as any} size={18} color={colors.muted} style={{ marginRight: 12 }} />
      <View style={{ flex: 1 }}>
        <Text style={sr.label}>{label}</Text>
        {value && <Text style={[sr.value, valueColor ? { color: valueColor } : {}]}>{value}</Text>}
      </View>
      {onPress && <Ionicons name="chevron-forward" size={15} color={colors.muted} />}
    </TouchableOpacity>
  );
}

function SettingDivider() {
  return <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 46 }} />;
}

function Field({ label, hint, ...p }: { label: string; hint?: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={s.fieldWrap}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput style={s.input} placeholderTextColor={colors.muted} {...p} />
      {hint && <Text style={s.fieldHint}>{hint}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: 120 },

  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 18, paddingBottom: 20 },
  title:      { fontSize: 26, fontWeight: '800', color: colors.text },
  signOutBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  signOutTxt: { fontSize: 14, fontWeight: '600', color: colors.red },

  avatarSection: { alignItems: 'center', paddingBottom: 28 },
  avatar:        { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarTxt:     { color: '#fff', fontSize: 28, fontWeight: '800' },
  displayName:   { fontSize: 20, fontWeight: '700', color: colors.text },
  displayEmail:  { fontSize: 13, color: colors.subtext, marginTop: 3 },

  section:      { marginHorizontal: 22, marginBottom: 16, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },

  editCard:     { marginHorizontal: 22, marginBottom: 12, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16 },
  editCardTitle:{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 4 },
  editCardHint: { fontSize: 12, color: colors.muted, marginBottom: 16, lineHeight: 17 },

  fieldWrap:  { marginBottom: 16 },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 0.8, marginBottom: 8 },
  input:      { height: 52, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 14, color: colors.text, fontSize: 15 },
  fieldHint:  { fontSize: 11, color: colors.muted, marginTop: 5, lineHeight: 16 },

  saveBtnWrap: { borderRadius: 14, overflow: 'hidden' },
  saveBtn:     { paddingVertical: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  saveBtnTxt:  { color: '#fff', fontSize: 15, fontWeight: '700' },
  cancelBtn:   { alignItems: 'center', paddingVertical: 12 },
  cancelBtnTxt:{ fontSize: 14, color: colors.muted },

  devToggle:    { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 22 },
  devToggleTxt: { fontSize: 13, fontWeight: '600', color: colors.muted },

  testBtn:    { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  testBtnTxt: { color: colors.subtext, fontSize: 13, fontWeight: '600' },

  outcomeBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
});

const sr = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  label: { fontSize: 15, color: colors.text },
  value: { fontSize: 13, color: colors.subtext, marginTop: 2 },
});
