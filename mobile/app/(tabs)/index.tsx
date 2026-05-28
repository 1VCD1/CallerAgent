import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Animated, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, STATUS, ACTIVE_STATUSES } from '@/theme';
import { startCall, getCalls, getCall, endCall, getApiUrl } from '@/api';
import { useCallStore } from '@/store';
import { useSSE } from '@/hooks/useSSE';
import type { Call } from '@/api';

const TERMINAL = new Set(['ENDED', 'FAILED']);

interface CallTemplate {
  company: string;
  phone: string;
  goal: string;
}

// ─── Dynamic Orb ─────────────────────────────────────────────────────────────

type OrbState = 'idle' | 'active' | 'human';

function DynamicOrb({ orbState }: { orbState: OrbState }) {
  const breathe      = useRef(new Animated.Value(1)).current;
  const outerOpacity = useRef(new Animated.Value(0.35)).current;

  const isHuman  = orbState === 'human';
  const isActive = orbState === 'active';
  const dur = isActive ? 800 : 2200;

  const gradColors: [string, string, string] = isHuman
    ? ['#25D366', '#22c55e', '#16a34a']
    : ['#60a5fa', '#818cf8', '#a78bfa'];  // blue → violet

  useEffect(() => {
    const b = Animated.loop(Animated.sequence([
      Animated.timing(breathe,      { toValue: 1.07, duration: dur,       useNativeDriver: true }),
      Animated.timing(breathe,      { toValue: 1,    duration: dur,       useNativeDriver: true }),
    ]));
    const o = Animated.loop(Animated.sequence([
      Animated.timing(outerOpacity, { toValue: 0.9,  duration: dur * 1.5, useNativeDriver: true }),
      Animated.timing(outerOpacity, { toValue: 0.15, duration: dur * 1.5, useNativeDriver: true }),
    ]));
    b.start(); o.start();
    return () => { b.stop(); o.stop(); };
  }, [orbState]);

  return (
    <View style={orb.wrap}>
      {/* Outer faint ring — pulses opacity */}
      <Animated.View style={[orb.ringOuter, { borderColor: gradColors[0], opacity: outerOpacity }]} />
      {/* Mid ring — breathes scale */}
      <Animated.View style={[orb.ringMid, { borderColor: gradColors[0] + '60', transform: [{ scale: breathe }] }]} />
      {/* Inner gradient ring: LinearGradient shell + dark cutout centre */}
      <LinearGradient
        colors={gradColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={orb.ringGradient}
      >
        <View style={orb.ringCutout}>
          {isHuman
            ? <Ionicons name="person" size={36} color={gradColors[0]} />
            : <Image source={require('../../assets/Logo_transparent.png')} style={orb.appIcon} />
          }
        </View>
      </LinearGradient>
    </View>
  );
}

const orb = StyleSheet.create({
  wrap:        { width: 210, height: 210, alignItems: 'center', justifyContent: 'center' },
  ringOuter:   { position: 'absolute', width: 204, height: 204, borderRadius: 102, borderWidth: 1 },
  ringMid:     { position: 'absolute', width: 170, height: 170, borderRadius: 85,  borderWidth: 1.5 },
  ringGradient:{ width: 136, height: 136, borderRadius: 68, alignItems: 'center', justifyContent: 'center' },
  ringCutout:  { width: 131, height: 131, borderRadius: 65.5, backgroundColor: '#020617', alignItems: 'center', justifyContent: 'center' },
  appIcon:     { width: 64, height: 64 },
});

// ─── Active Call Screen ───────────────────────────────────────────────────────

interface ActiveCallViewProps {
  call: Call;
  cfg: { label: string; color: string; bg: string };
  isHuman: boolean;
  isActive: boolean;
  confidence: number;
  transcripts: NonNullable<Call['transcripts']>;
  onEnd: () => void;
}

function ActiveCallView({ call, cfg, isHuman, isActive, confidence, transcripts, onEnd }: ActiveCallViewProps) {
  const [showTranscript, setShowTranscript] = useState(false);
  const orbState: OrbState = isHuman ? 'human' : isActive ? 'active' : 'idle';

  return (
    <SafeAreaView style={s.callScreen}>
      {/* Header */}
      <View style={s.callHeader}>
        <View style={{ flex: 1 }}>
          <Text style={s.callHeaderTitle} numberOfLines={1}>Talking to {call.company}</Text>
          <Text style={s.callHeaderSub} numberOfLines={2}>{cfg.label}</Text>
        </View>
        <TouchableOpacity style={s.callEndBtnSmall} onPress={onEnd} activeOpacity={0.8}>
          <Ionicons name="call" size={14} color="#fff" />
          <Text style={s.callEndBtnSmallTxt}>End</Text>
        </TouchableOpacity>
      </View>

      {/* Center: Orb + status text + transcript */}
      <View style={s.callCenter}>
        <DynamicOrb orbState={orbState} />

        {isHuman ? (
          <View style={s.callHumanTextBlock}>
            <Text style={s.callHumanTitle}>Human found.</Text>
            <Text style={s.callHumanSub}>Keep your phone nearby</Text>
          </View>
        ) : confidence > 0 ? (
          <View style={s.callConfBlock}>
            <Text style={s.callConfHint}>Sounds like a real representative</Text>
            <View style={s.callConfRow}>
              <View style={s.callConfTrack}>
                <View style={[s.callConfFill, {
                  width: `${Math.round(confidence * 100)}%` as any,
                  backgroundColor: confidence > 0.6 ? colors.green : confidence > 0.3 ? colors.yellow : colors.muted,
                }]} />
              </View>
              <Text style={[s.callConfPct, {
                color: confidence > 0.6 ? colors.green : confidence > 0.3 ? colors.yellow : colors.muted,
              }]}>{Math.round(confidence * 100)}%</Text>
            </View>
          </View>
        ) : null}

        {/* Transcript toggle */}
        <TouchableOpacity style={s.transcriptToggle} onPress={() => setShowTranscript(v => !v)}>
          <Ionicons name="document-text-outline" size={15} color={colors.muted} />
          <Text style={s.transcriptToggleTxt}>Live Transcript</Text>
          {transcripts.length > 0 && (
            <View style={s.transcriptBadge}>
              <Text style={s.transcriptBadgeTxt}>{transcripts.length}</Text>
            </View>
          )}
          <Ionicons name={showTranscript ? 'chevron-up' : 'chevron-down'} size={15} color={colors.muted} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>

        {showTranscript && (
          <ScrollView style={s.transcriptList} contentContainerStyle={{ padding: 12, paddingTop: 8 }}>
            {transcripts.length === 0 ? (
              <Text style={s.transcriptEmpty}>Waiting for IVR to speak…</Text>
            ) : (
              transcripts.slice(-12).map((t, i) => {
                const isAI      = t.speaker === 'AI';
                const isHumanSpk = t.speaker === 'HUMAN';
                return (
                  <View key={t.id ?? i} style={[s.chatRow, isAI ? s.chatRowRight : s.chatRowLeft]}>
                    <View style={[s.chatBubble, isAI ? s.chatBubbleAI : isHumanSpk ? s.chatBubbleHuman : s.chatBubbleIVR]}>
                      <Text style={[s.chatSpeaker, { color: isAI ? colors.blue : isHumanSpk ? colors.green : colors.muted }]}>
                        {t.speaker}
                      </Text>
                      <Text style={[s.chatText, isAI && { color: '#93c5fd' }]}>{t.text}</Text>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        )}
      </View>

      {/* Bottom: info box */}
      {!isHuman && (
        <View style={s.callBottom}>
          <View style={s.callInfoBox}>
            <View style={s.callInfoIconWrap}>
              <Ionicons name="phone-portrait" size={18} color={colors.green} />
            </View>
            <Text style={s.callInfoTxt}>We'll call you the moment a human picks up</Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────

export default function CallScreen() {
  const [company, setCompany]     = useState('');
  const [phone, setPhone]         = useState('');
  const [goal, setGoal]           = useState('');
  const [loading, setLoading]     = useState(false);
  const [templates, setTemplates] = useState<CallTemplate[]>([]);
  const [sseUrl, setSseUrl]       = useState<string | null>(null);
  const submitting = useRef(false);

  const { activeCall, setActiveCall, setCallHistory, patchCall } = useCallStore();

  useSSE(sseUrl, (event, data: any) => {
    if (event === 'status' && data?.callId && data?.status) {
      patchCall(data.callId, { status: data.status });
      if (TERMINAL.has(data.status)) {
        setSseUrl(null);
        setTimeout(() => setActiveCall(null), 1500);
      }
    }
  });

  useEffect(() => {
    if (!activeCall?.id || TERMINAL.has(activeCall.status)) { setSseUrl(null); return; }
    getApiUrl().then(base => setSseUrl(`${base}/calls/${activeCall.id}/events`));
  }, [activeCall?.id, activeCall?.status]);

  useEffect(() => {
    if (!activeCall?.id || TERMINAL.has(activeCall.status)) return;
    const t = setInterval(() => getCall(activeCall.id).then(setActiveCall).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [activeCall?.id, activeCall?.status]);

  const loadTemplates = async () => {
    try {
      const calls = await getCalls(50);
      const seen  = new Map<string, CallTemplate>();
      for (const c of calls) {
        const key = `${c.company}||${c.phone_number}`;
        if (!seen.has(key)) seen.set(key, { company: c.company, phone: c.phone_number, goal: c.goal ?? '' });
      }
      setTemplates([...seen.values()].slice(0, 10));
    } catch {}
  };

  const refresh = async () => {
    try {
      const calls = await getCalls(5);
      setCallHistory(calls);
      const active = calls.filter((c: Call) => ACTIVE_STATUSES.includes(c.status));
      if (active.length > 0) {
        setActiveCall(await getCall(active[0].id).catch(() => active[0]));
      } else {
        setActiveCall(null);
      }
    } catch {}
  };

  useEffect(() => { refresh(); loadTemplates(); }, []);

  const handleStart = async () => {
    if (submitting.current) return;
    if (!company.trim() || !phone.trim()) {
      Alert.alert('Missing info', 'Company name and phone number are required.');
      return;
    }
    submitting.current = true;
    setLoading(true);
    try {
      const raw = phone.trim();
      const phoneNumber = raw.startsWith('+') ? raw : `+1${raw.replace(/\D/g, '')}`;
      await startCall({ company: company.trim(), phoneNumber, goal: goal.trim() || undefined });
      setCompany(''); setPhone(''); setGoal('');
      await refresh(); await loadTemplates();
    } catch (e: any) {
      if (e.status === 409) {
        if (e.callId) {
          const stuck = await getCall(e.callId).catch(() => null);
          if (stuck) setActiveCall(stuck);
        } else { await refresh(); }
      } else {
        Alert.alert('Error', e.message ?? 'Failed to start call');
      }
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  // ── Active call — render full screen ──
  if (activeCall) {
    const call = activeCall;
    const cfg  = STATUS[call.status] ?? STATUS['ENDED'];
    const isHuman  = ['HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'].includes(call.status);
    const isActive = ACTIVE_STATUSES.includes(call.status) && !isHuman;
    return (
      <ActiveCallView
        call={call} cfg={cfg} isHuman={isHuman} isActive={isActive}
        confidence={call.human_confidence ?? 0}
        transcripts={call.transcripts ?? []}
        onEnd={() => endCall(call.id).then(refresh)}
      />
    );
  }

  // ── Home screen ──
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* Hero — left-aligned */}
        <View style={s.heroBlock}>
          <Text style={s.heroTitle}><Text style={{ color: colors.green }}>Skip</Text> the{'\n'}hold music.</Text>
          <Text style={s.heroSub}>CallerAgent navigates the phone system{'\n'}so you don't have to.</Text>
        </View>

        {/* Orb — centered */}
        <View style={s.orbCenter}>
          <DynamicOrb orbState="idle" />
        </View>

        {/* Primary inputs + CTA — all visible without scrolling */}
        <View style={s.form}>

          <View style={s.iconInput}>
            <Ionicons name="business-outline" size={18} color={colors.muted} style={s.iconInputIcon} />
            <TextInput
              style={s.iconInputField} placeholder="Company name"
              placeholderTextColor={colors.muted} value={company} onChangeText={setCompany}
            />
          </View>

          <View style={s.iconInput}>
            <Ionicons name="call-outline" size={18} color={colors.muted} style={s.iconInputIcon} />
            <TextInput
              style={s.iconInputField} placeholder="Phone number"
              placeholderTextColor={colors.muted} value={phone} onChangeText={setPhone} keyboardType="phone-pad"
            />
          </View>

          <TouchableOpacity onPress={handleStart} disabled={loading} activeOpacity={0.85} style={s.startBtnWrap}>
            <LinearGradient
              colors={['#25D366', '#128C4E']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={s.startBtn}
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="sparkles" size={20} color="#fff" /><Text style={s.startBtnTxt}>Start AI Call</Text></>
              }
            </LinearGradient>
          </TouchableOpacity>

        </View>

        {/* ─ Secondary options (scroll to see) ─ */}

        <View style={s.formSecondary}>
          <Text style={s.fieldLabel}>WHAT I NEED HELP WITH <Text style={s.fieldLabelOpt}>· optional</Text></Text>
          <TextInput
            style={[s.input, { marginBottom: 8 }]} placeholder="Describe what you need…"
            placeholderTextColor={colors.muted} value={goal} onChangeText={setGoal}
          />
          <View style={s.goalChips}>
            {['Billing issue', 'Cancel subscription', 'Refund request', 'Technical support'].map(g => (
              <TouchableOpacity
                key={g}
                style={[s.goalChip, goal === g && s.goalChipActive]}
                onPress={() => setGoal(goal === g ? '' : g)}
              >
                <Text style={[s.goalChipTxt, goal === g && s.goalChipTxtActive]}>{g}</Text>
              </TouchableOpacity>
            ))}
          </View>

        </View>

        {/* Recent session pills */}
        {templates.length > 0 && (
          <View style={s.recentSection}>
            <Text style={[s.fieldLabel, { paddingHorizontal: 22, marginBottom: 10 }]}>RECENT</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 22 }}
            >
              {templates.map((t, i) => (
                <TouchableOpacity
                  key={i}
                  style={s.recentPill}
                  onPress={() => { setCompany(t.company); setPhone(t.phone); setGoal(t.goal); }}
                >
                  <Text style={s.recentPillCompany} numberOfLines={1}>{t.company}</Text>
                  {t.goal ? <Text style={s.recentPillGoal} numberOfLines={1}>{t.goal}</Text> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: 48 },

  // Home hero
  heroBlock: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 4 },
  heroTitle: { fontSize: 34, fontWeight: '800', color: colors.text, lineHeight: 42, letterSpacing: -0.5 },
  heroSub:   { fontSize: 14, color: colors.subtext, lineHeight: 21, marginTop: 10 },

  // Orb
  orbCenter: { alignItems: 'center', paddingVertical: 8 },

  // Recent pills
  recentPill:        { backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, marginRight: 8, minWidth: 100, maxWidth: 160 },
  recentPillCompany: { fontSize: 13, color: colors.text, fontWeight: '700' },
  recentPillGoal:    { fontSize: 11, color: colors.muted, marginTop: 3 },

  // Form
  form:          { paddingHorizontal: 22 },
  fieldLabel:    { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1, marginBottom: 8 },
  fieldLabelOpt: { fontWeight: '400', letterSpacing: 0 },
  input:         { height: 56, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 18, paddingHorizontal: 16, color: colors.text, fontSize: 15, marginBottom: 20 },

  goalChips:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  goalChip:          { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: 'rgba(255,255,255,0.04)' },
  goalChipActive:    { borderColor: colors.green, backgroundColor: 'rgba(37,211,102,0.12)' },
  goalChipTxt:       { fontSize: 13, color: colors.subtext },
  goalChipTxtActive: { color: colors.green, fontWeight: '600' },

  formSecondary: { paddingHorizontal: 22, paddingTop: 8, marginBottom: 8 },
  recentSection: { marginBottom: 40 },

  iconInput:      { flexDirection: 'row', alignItems: 'center', height: 56, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 18, paddingHorizontal: 16, marginBottom: 12 },
  iconInputIcon:  { marginRight: 10 },
  iconInputField: { flex: 1, color: colors.text, fontSize: 15 },

  startBtnWrap: { borderRadius: 18, overflow: 'hidden', marginTop: 4 },
  startBtn:     { paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  startBtnTxt:  { color: '#fff', fontSize: 16, fontWeight: '700' },

  // ── Active call ──
  callScreen:  { flex: 1, backgroundColor: '#060c18' },

  callHeader:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(30,41,59,0.6)' },
  callHeaderTitle: { fontSize: 20, fontWeight: '800', color: colors.text },
  callHeaderSub:   { fontSize: 13, color: colors.subtext, marginTop: 3, lineHeight: 18 },
  callActiveDot:   { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center' },
  callActiveDotInner: { width: 10, height: 10, borderRadius: 5 },

  callCenter:  { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },

  callHumanTextBlock: { alignItems: 'center', marginTop: 24 },
  callHumanTitle:     { fontSize: 36, fontWeight: '800', color: colors.green, letterSpacing: -0.5 },
  callHumanSub:       { fontSize: 15, color: 'rgba(37,211,102,0.6)', marginTop: 6 },

  callConfBlock: { alignItems: 'center', marginTop: 20, width: '75%' },
  callConfHint:  { fontSize: 13, color: colors.subtext, marginBottom: 10, textAlign: 'center' },
  callConfRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%' },
  callConfTrack: { flex: 1, height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' },
  callConfFill:  { height: 4, borderRadius: 2 },
  callConfPct:   { fontSize: 13, fontWeight: '700', minWidth: 36 },

  callBottom:  { paddingHorizontal: 20, paddingBottom: 28 },

  callInfoBox:     { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(37,211,102,0.08)', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(37,211,102,0.2)' },
  callInfoIconWrap:{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(37,211,102,0.15)', alignItems: 'center', justifyContent: 'center' },
  callInfoTxt:     { flex: 1, fontSize: 13, color: colors.text, lineHeight: 19, fontWeight: '500' },

  transcriptToggle:    { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8 },
  transcriptToggleTxt: { fontSize: 13, fontWeight: '600', color: colors.subtext },
  transcriptBadge:     { backgroundColor: colors.border, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  transcriptBadgeTxt:  { fontSize: 10, fontWeight: '700', color: colors.muted },
  transcriptList:      { maxHeight: 220, marginBottom: 8 },
  transcriptEmpty:     { color: colors.muted, fontSize: 13, textAlign: 'center', paddingVertical: 16 },

  // Chat bubble layout
  chatRow:         { marginBottom: 8, flexDirection: 'row' },
  chatRowLeft:     { justifyContent: 'flex-start' },
  chatRowRight:    { justifyContent: 'flex-end' },
  chatBubble:      { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  chatBubbleIVR:   { backgroundColor: '#1e293b', borderTopLeftRadius: 4 },
  chatBubbleHuman: { backgroundColor: '#052e16', borderTopLeftRadius: 4 },
  chatBubbleAI:    { backgroundColor: '#0c1a2e', borderTopRightRadius: 4 },
  chatSpeaker:     { fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
  chatText:        { fontSize: 13, color: colors.text, lineHeight: 19 },

  callEndBtnSmall:    { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#be1c1c', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  callEndBtnSmallTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
