import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, STATUS, ACTIVE_STATUSES } from '@/theme';
import { getUserId, setUserId, createUser, startCall, getCalls, getCall, endCall } from '@/api';
import type { Call } from '@/api';

interface CallTemplate {
  company: string;
  phone: string;
  goal: string;
  ivrLanguage: 'en' | 'zh-TW' | 'zh-CN';
}

export default function CallScreen() {
  const [company, setCompany]   = useState('');
  const [phone, setPhone]       = useState('');
  const [goal, setGoal]         = useState('');
  const [ivrLang, setIvrLang]   = useState<'en' | 'zh-TW' | 'zh-CN'>('en');
  const [loading, setLoading]   = useState(false);
  const [active, setActive]     = useState<Call[]>([]);
  const [templates, setTemplates] = useState<CallTemplate[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const submitting = useRef(false);

  const ensureUser = async () => {
    let uid = await getUserId();
    if (!uid) { const u = await createUser(); uid = u.id; await setUserId(uid); }
    return uid;
  };

  const loadTemplates = async () => {
    try {
      const uid = await getUserId();
      if (!uid) return;
      const calls = await getCalls(uid, 50);
      // Deduplicate by company+phone, keep most recent goal per combo
      const seen = new Map<string, CallTemplate>();
      for (const c of calls) {
        const key = `${c.company}||${c.phone_number}`;
        if (!seen.has(key)) {
          seen.set(key, {
            company: c.company,
            phone: c.phone_number,
            goal: c.goal ?? '',
            ivrLanguage: 'en',
          });
        }
      }
      setTemplates([...seen.values()].slice(0, 10));
    } catch {}
  };

  const refresh = async () => {
    try {
      const uid = await getUserId();
      if (!uid) return;
      const calls = await getCalls(uid, 5);
      const activeCalls = calls.filter((c: Call) => ACTIVE_STATUSES.includes(c.status));
      const detailed = await Promise.all(
        activeCalls.map(c => getCall(c.id).catch(() => c))
      );
      setActive(detailed);
    } catch {}
  };

  useEffect(() => {
    refresh();
    loadTemplates();
    timer.current = setInterval(refresh, 1000);
    return () => clearInterval(timer.current as any);
  }, []);

  const handleStart = async () => {
    if (submitting.current) return;
    if (!company.trim() || !phone.trim()) {
      Alert.alert('Missing info', 'Company name and phone number are required.');
      return;
    }
    submitting.current = true;
    setLoading(true);
    try {
      const uid = await ensureUser();
      await startCall(uid, { company: company.trim(), phoneNumber: phone.trim(), goal: goal.trim() || undefined, ivrLanguage: ivrLang });
      setCompany(''); setPhone(''); setGoal('');
      await Promise.all([refresh(), loadTemplates()]);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to start call');
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  // Full-screen active call view
  if (active.length > 0) {
    const call = active[0];
    const cfg = STATUS[call.status] ?? STATUS['ENDED'];
    const isHuman = ['HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'].includes(call.status);
    const confidence = call.human_confidence ?? 0;
    const transcripts = call.transcripts ?? [];

    return (
      <SafeAreaView style={s.callScreen}>
        {/* Header */}
        <View style={s.callHeader}>
          <View style={{ flex: 1 }}>
            <Text style={s.callCompany}>{call.company}</Text>
            <Text style={s.callPhone}>{call.phone_number}</Text>
          </View>
          <View style={[s.callBadge, { backgroundColor: cfg.bg }]}>
            <Text style={[s.callBadgeTxt, { color: cfg.color }]}>● {cfg.label}</Text>
          </View>
        </View>

        {/* Human reached banner */}
        {isHuman && (
          <View style={s.callHumanBanner}>
            <Ionicons name="checkmark-circle" size={20} color={colors.green} />
            <Text style={s.callHumanTxt}>Live representative reached! Check your phone.</Text>
          </View>
        )}

        {/* Confidence bar */}
        {!isHuman && (
          <View style={s.callConfWrap}>
            <View style={s.callConfRow}>
              <Text style={s.callConfLabel}>Human confidence</Text>
              <Text style={s.callConfPct}>{Math.round(confidence * 100)}%</Text>
            </View>
            <View style={s.callConfTrack}>
              <View style={[s.callConfFill, {
                width: `${Math.round(confidence * 100)}%` as any,
                backgroundColor: confidence > 0.6 ? colors.green : confidence > 0.3 ? colors.yellow : colors.muted,
              }]} />
            </View>
          </View>
        )}

        {/* Transcript — full screen, large text */}
        <ScrollView
          style={s.callTranscript}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          ref={ref => { if (ref && transcripts.length > 0) setTimeout(() => ref.scrollToEnd({ animated: true }), 100); }}
        >
          {transcripts.length === 0 ? (
            <Text style={s.callTranscriptEmpty}>Waiting for IVR to speak…</Text>
          ) : (
            transcripts.slice(-20).map((t, i) => {
              const pct = t.human_confidence != null ? Math.round(t.human_confidence * 100) : null;
              const isAI = t.speaker === 'AI';
              const isHumanSpeaker = t.speaker === 'HUMAN';
              return (
                <View key={t.id ?? i} style={[s.callLine, isAI && s.callLineAI]}>
                  <View style={s.callLineMeta}>
                    <Text style={[s.callLineSpeaker,
                      isAI && { color: colors.blue },
                      isHumanSpeaker && { color: colors.green },
                    ]}>
                      {t.speaker}
                    </Text>
                    {pct != null && (
                      <Text style={[s.callLineConf,
                        { color: pct > 60 ? colors.green : pct > 30 ? colors.yellow : colors.muted }
                      ]}>{pct}%</Text>
                    )}
                  </View>
                  <Text style={[s.callLineText, isAI && { color: '#93c5fd' }]}>{t.text}</Text>
                </View>
              );
            })
          )}
        </ScrollView>

        {/* End Call button */}
        <View style={s.callFooter}>
          <TouchableOpacity style={s.callEndBtn} onPress={() => endCall(call.id).then(refresh)}>
            <Ionicons name="call" size={22} color="#fff" />
            <Text style={s.callEndBtnTxt}>End Call</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        <View style={s.header}>
          <View style={s.logo}><Text style={s.logoTxt}>CA</Text></View>
          <Text style={s.heading}>CallerAgent</Text>
        </View>

        {/* New call form */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Start a New Call</Text>

          {/* Recent call templates */}
          {templates.length > 0 && (
            <View style={s.recentWrap}>
              <Text style={s.label}>Recent</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.recentScroll}>
                {templates.map((t, i) => (
                  <TouchableOpacity
                    key={i}
                    style={s.recentChip}
                    onPress={() => { setCompany(t.company); setPhone(t.phone); setGoal(t.goal); setIvrLang(t.ivrLanguage); }}
                  >
                    <Text style={s.recentChipCompany} numberOfLines={1}>{t.company}</Text>
                    {t.goal ? <Text style={s.recentChipGoal} numberOfLines={1}>{t.goal}</Text> : null}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          <Text style={s.label}>Company Name</Text>
          <TextInput style={s.input} placeholder="Verizon, Chase, AT&T…" placeholderTextColor={colors.muted}
            value={company} onChangeText={setCompany} />

          <Text style={s.label}>Their Phone Number</Text>
          <TextInput style={s.input} placeholder="+1 800 000 0000" placeholderTextColor={colors.muted}
            value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

          <Text style={s.label}>Goal <Text style={s.labelOpt}>(optional)</Text></Text>
          <TextInput style={s.input} placeholder="Dispute a charge, cancel plan…" placeholderTextColor={colors.muted}
            value={goal} onChangeText={setGoal} />

          <Text style={s.label}>IVR Language <Text style={s.labelOpt}>(their phone system)</Text></Text>
          <View style={s.langRow}>
            {([['en','🇺🇸','English'],['zh-TW','🇹🇼','繁體中文'],['zh-CN','🇨🇳','简体中文']] as const).map(([code, flag, label]) => (
              <TouchableOpacity key={code} style={[s.langBtn, ivrLang === code && s.langBtnActive]} onPress={() => setIvrLang(code)}>
                <Text style={s.langFlag}>{flag}</Text>
                <Text style={[s.langLabel, ivrLang === code && { color: colors.blue }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={s.callBtn} onPress={handleStart} disabled={loading}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <><Ionicons name="call" size={18} color="#fff" /><Text style={s.callBtnTxt}>Start AI Call</Text></>
            }
          </TouchableOpacity>
        </View>

        <View style={s.info}>
          <Ionicons name="information-circle-outline" size={15} color={colors.subtext} />
          <Text style={s.infoTxt}>
            The AI navigates the IVR and calls your phone when it finds a live representative. Set your callback number in Profile.
          </Text>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:            { flex: 1, backgroundColor: colors.bg },
  scroll:          { padding: 16, paddingBottom: 36 },
  header:          { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  logo:            { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  logoTxt:         { color: '#fff', fontWeight: '700', fontSize: 13 },
  heading:         { fontSize: 20, fontWeight: '700', color: colors.text },
  activeCard:      { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 },
  humanBanner:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#052e16', padding: 8, borderRadius: 8, marginBottom: 10 },
  humanBannerTxt:  { color: colors.green, fontWeight: '600', fontSize: 12 },
  row:             { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  activeCompany:   { fontSize: 15, fontWeight: '600', color: colors.text },
  activePhone:     { fontSize: 12, color: colors.subtext, marginTop: 2 },
  badge:           { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  badgeTxt:        { fontSize: 11, fontWeight: '600' },
  confRow:         { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  confLabel:       { fontSize: 11, color: colors.muted },
  confPct:         { fontSize: 11, fontWeight: '700', color: colors.subtext },
  confTrack:       { height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: 10, overflow: 'hidden' },
  confFill:        { height: 4, borderRadius: 2 },
  transcript:      { backgroundColor: '#0f172a', borderRadius: 8, padding: 10, marginBottom: 10, gap: 6 },
  transcriptRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  transcriptLine:  { fontSize: 12, color: colors.subtext, lineHeight: 17 },
  transcriptSpeaker:{ fontWeight: '700', color: colors.muted },
  confBadge:       { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, minWidth: 36, alignItems: 'center' },
  confBadgeTxt:    { fontSize: 10, fontWeight: '700' },
  endBtn:          { borderWidth: 1, borderColor: '#7f1d1d', borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  endBtnTxt:       { color: colors.red, fontSize: 13, fontWeight: '600' },
  card:            { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 12 },
  cardTitle:       { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 14 },
  label:           { fontSize: 11, fontWeight: '700', color: colors.subtext, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  labelOpt:        { color: colors.muted, textTransform: 'none', fontWeight: '400', fontSize: 11 },
  input:           { backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, color: colors.text, fontSize: 14, marginBottom: 12 },
  callBtn:         { backgroundColor: colors.blue, borderRadius: 10, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 },
  callBtnTxt:      { color: '#fff', fontSize: 15, fontWeight: '700' },
  langRow:         { flexDirection: 'row', gap: 8, marginBottom: 12 },
  langBtn:         { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 8, alignItems: 'center', gap: 2, backgroundColor: colors.input },
  langBtnActive:   { borderColor: colors.blue, backgroundColor: '#1e3a5f' },
  langFlag:        { fontSize: 18 },
  langLabel:       { fontSize: 10, fontWeight: '600', color: colors.subtext },
  info:              { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: colors.card, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  infoTxt:           { flex: 1, fontSize: 12, color: colors.subtext, lineHeight: 18 },
  recentWrap:        { marginBottom: 14 },
  recentScroll:      { marginTop: 6, marginHorizontal: -2 },
  recentChip:        { backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 3, maxWidth: 140 },
  recentChipCompany: { fontSize: 13, fontWeight: '700', color: colors.text },
  recentChipGoal:    { fontSize: 11, color: colors.muted, marginTop: 2 },

  // Full-screen active call styles
  callScreen:        { flex: 1, backgroundColor: '#0a0f1e' },
  callHeader:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1e293b' },
  callCompany:       { fontSize: 22, fontWeight: '800', color: '#f1f5f9' },
  callPhone:         { fontSize: 13, color: '#64748b', marginTop: 2 },
  callBadge:         { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  callBadgeTxt:      { fontSize: 12, fontWeight: '700' },
  callHumanBanner:   { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#052e16', margin: 12, padding: 14, borderRadius: 12 },
  callHumanTxt:      { flex: 1, color: colors.green, fontWeight: '600', fontSize: 15 },
  callConfWrap:      { paddingHorizontal: 20, paddingVertical: 10 },
  callConfRow:       { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  callConfLabel:     { fontSize: 13, color: '#64748b' },
  callConfPct:       { fontSize: 13, fontWeight: '700', color: '#94a3b8' },
  callConfTrack:     { height: 5, backgroundColor: '#1e293b', borderRadius: 3, overflow: 'hidden' },
  callConfFill:      { height: 5, borderRadius: 3 },
  callTranscript:    { flex: 1, backgroundColor: '#0f172a' },
  callTranscriptEmpty: { color: '#475569', fontSize: 16, textAlign: 'center', marginTop: 60 },
  callLine:          { marginBottom: 16, padding: 14, backgroundColor: '#1e293b', borderRadius: 12, borderLeftWidth: 3, borderLeftColor: '#334155' },
  callLineAI:        { backgroundColor: '#0f2040', borderLeftColor: colors.blue },
  callLineMeta:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  callLineSpeaker:   { fontSize: 12, fontWeight: '800', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 },
  callLineConf:      { fontSize: 11, fontWeight: '600' },
  callLineText:      { fontSize: 17, color: '#e2e8f0', lineHeight: 25 },
  callFooter:        { padding: 20, paddingBottom: 10 },
  callEndBtn:        { backgroundColor: '#dc2626', borderRadius: 16, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  callEndBtnTxt:     { color: '#fff', fontSize: 17, fontWeight: '700' },
});
