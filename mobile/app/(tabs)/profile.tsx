import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Switch,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { colors } from '@/theme';
import { getUser, updateUser, getApiUrl, setApiUrl, getApiKey, setApiKey, getIvrNotes, IvrNote } from '@/api';
import { useCallStore } from '@/store';
import { auth, signOut } from '@/firebase';
import i18n, { AppLanguage } from '@/i18n';

const LANG_OPTIONS: { value: AppLanguage; tKey: string }[] = [
  { value: 'en',    tKey: 'lang_en' },
  { value: 'zh-TW', tKey: 'lang_zh_TW' },
  { value: 'zh-CN', tKey: 'lang_zh_CN' },
];

export default function ProfileScreen() {
  const { t } = useTranslation();
  const { userId } = useCallStore();
  const firebaseUser = auth.currentUser;

  const [name, setName]         = useState('');
  const [phone, setPhone]       = useState('');
  const [birthday, setBirthday] = useState('');
  const [email, setEmail]       = useState('');
  const [language, setLanguage] = useState<AppLanguage>(i18n.language as AppLanguage);
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
      if (u.language)     setLanguage(u.language);
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
      data.language = language;
      if (Object.keys(data).length) await updateUser(userId, data);
      i18n.changeLanguage(language);
      setSaved(true); setEditMode(false);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      Alert.alert(t('error'), e.message ?? t('save_failed'));
    } finally { setSaving(false); }
  };

  const handleSignOut = () => {
    Alert.alert(t('sign_out_confirm_title'), t('sign_out_confirm_body'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('sign_out'), style: 'destructive', onPress: () => signOut().catch(console.warn) },
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
            <Text style={s.title}>{t('you')}</Text>
            <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut}>
              <Ionicons name="log-out-outline" size={17} color={colors.red} />
              <Text style={s.signOutTxt}>{t('sign_out')}</Text>
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
            <Text style={s.sectionTitle}>{t('preferences')}</Text>

            <SettingRow
              icon="call-outline"
              label={t('callback_phone')}
              value={phone || t('not_set')}
              onPress={() => setEditMode(v => !v)}
              valueColor={phone ? colors.text : colors.red}
              chevronDir={editMode ? 'up' : 'forward'}
            />
            <SettingDivider />
            <SettingRow
              icon="language-outline"
              label={t('language_label')}
              value={t(LANG_OPTIONS.find(l => l.value === language)?.tKey ?? 'lang_en')}
              onPress={() => {
                const next = LANG_OPTIONS[(LANG_OPTIONS.findIndex(l => l.value === language) + 1) % LANG_OPTIONS.length];
                setLanguage(next.value);
                i18n.changeLanguage(next.value);
              }}
              chevronDir="forward"
            />
          </View>

          {/* Edit personal info (shown when editMode) */}
          {editMode && (
            <View style={s.editCard}>
              <Text style={s.editCardTitle}>{t('personal_info_title')}</Text>
              <Text style={s.editCardHint}>{t('personal_info_hint')}</Text>

              <Field label={t('full_name')}      placeholder={t('full_name_placeholder')} value={name}  onChangeText={setName} />
              <Field label={t('callback_phone')} placeholder="234 567 8900"               value={phone} onChangeText={setPhone} keyboardType="phone-pad"
                hint={t('phone_hint')} required />
              <View style={s.fieldWrap}>
                <Text style={s.fieldLabel}>{t('dob')}</Text>
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
              <Field label={t('email')} placeholder="you@email.com" value={email} onChangeText={setEmail}
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
                      ? <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={s.saveBtnTxt}>{t('saved')}</Text></>
                      : <Text style={s.saveBtnTxt}>{t('save')}</Text>
                  }
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity style={s.cancelBtn} onPress={() => setEditMode(false)}>
                <Text style={s.cancelBtnTxt}>{t('collapse')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Developer options toggle */}
          <TouchableOpacity style={s.devToggle} onPress={() => setShowDev(v => !v)}>
            <Ionicons name="code-slash-outline" size={15} color={colors.muted} />
            <Text style={s.devToggleTxt}>{t('dev_options')}</Text>
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
                  Alert.alert(t('connected'), `HTTP ${res.status}\n${url}`);
                } catch (e: any) { Alert.alert(t('failed'), `${e.message}\n${url}`); }
              }}>
                <Text style={s.testBtnTxt}>{t('test_connection')}</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={save} disabled={saving} activeOpacity={0.85} style={[s.saveBtnWrap, { marginTop: 12 }]}>
                <LinearGradient
                  colors={['#25D366', '#128C4E']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={s.saveBtn}
                >
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.saveBtnTxt}>{t('save_settings')}</Text>}
                </LinearGradient>
              </TouchableOpacity>

              {/* IVR Notes */}
              <View style={{ marginTop: 20 }}>
                <Text style={s.fieldLabel}>{t('ivr_notes_label')}</Text>
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
                    {noteLoading ? <ActivityIndicator size="small" color={colors.blue} /> : <Text style={s.testBtnTxt}>{t('load')}</Text>}
                  </TouchableOpacity>
                </View>
                {noteError ? <Text style={{ color: colors.muted, fontSize: 13, marginTop: 8 }}>{t('no_ivr_notes')}</Text> : null}
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

function SettingRow({ icon, label, value, onPress, valueColor, chevronDir = 'forward' }: {
  icon: string; label: string; value?: string; onPress?: () => void; valueColor?: string; chevronDir?: 'forward' | 'up';
}) {
  return (
    <TouchableOpacity style={sr.row} onPress={onPress} disabled={!onPress} activeOpacity={0.7}>
      <Ionicons name={icon as any} size={18} color={colors.muted} style={{ marginRight: 12 }} />
      <View style={{ flex: 1 }}>
        <Text style={sr.label}>{label}</Text>
        {value && <Text style={[sr.value, valueColor ? { color: valueColor } : {}]}>{value}</Text>}
      </View>
      {onPress && <Ionicons name={chevronDir === 'up' ? 'chevron-up' : 'chevron-forward'} size={15} color={colors.muted} />}
    </TouchableOpacity>
  );
}

function SettingDivider() {
  return <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 46 }} />;
}

function Field({ label, hint, required, ...p }: { label: string; hint?: string; required?: boolean } & React.ComponentProps<typeof TextInput>) {
  const { t } = useTranslation();
  return (
    <View style={s.fieldWrap}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        <Text style={s.fieldLabel}>{label}</Text>
        {required && <Text style={s.fieldRequired}>{t('required')}</Text>}
      </View>
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

  fieldWrap:     { marginBottom: 16 },
  fieldLabel:    { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 0.8 },
  fieldRequired: { fontSize: 9, fontWeight: '800', color: colors.red, letterSpacing: 0.6, backgroundColor: 'rgba(239,68,68,0.10)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  input:         { height: 52, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 14, color: colors.text, fontSize: 15 },
  fieldHint:     { fontSize: 11, color: colors.muted, marginTop: 5, lineHeight: 16 },

  saveBtnWrap: { borderRadius: 14, overflow: 'hidden', marginTop: 4 },
  saveBtn:     { paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  saveBtnTxt:  { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  cancelBtn:   { alignItems: 'center', paddingVertical: 13, marginTop: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  cancelBtnTxt:{ fontSize: 14, fontWeight: '600', color: colors.muted },

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
