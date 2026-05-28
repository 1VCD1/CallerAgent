import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Animated, Image,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { colors, STATUS, ACTIVE_STATUSES } from '@/theme';
import { startCall, getCalls, getCall, endCall, getApiUrl, getCompanyStats, getCompanySuggestions } from '@/api';
import { useCallStore } from '@/store';
import { useSSE } from '@/hooks/useSSE';
import type { Call, CompanyStats } from '@/api';

const TERMINAL = new Set(['ENDED', 'FAILED']);

interface CallTemplate {
  company: string;
  phone: string;
  goal: string;
}

// ─── Dynamic Orb ─────────────────────────────────────────────────────────────

type OrbState = 'idle' | 'dialing' | 'navigating' | 'waiting' | 'human';

const ORB_CFG: Record<OrbState, {
  c: [string, string, string];
  dur: number; oMin: number; oMax: number; scale: number;
}> = {
  idle:      { c: ['#60a5fa', '#818cf8', '#a78bfa'], dur: 2200, oMin: 0.15, oMax: 0.50, scale: 1.04 },
  dialing:   { c: ['#60a5fa', '#3b82f6', '#2563eb'], dur: 1400, oMin: 0.20, oMax: 0.70, scale: 1.06 },
  navigating:{ c: ['#818cf8', '#a78bfa', '#c084fc'], dur: 800,  oMin: 0.30, oMax: 0.95, scale: 1.08 },
  waiting:   { c: ['#fbbf24', '#f59e0b', '#d97706'], dur: 3000, oMin: 0.10, oMax: 0.38, scale: 1.03 },
  human:     { c: ['#25D366', '#22c55e', '#16a34a'], dur: 550,  oMin: 0.35, oMax: 1.00, scale: 1.08 },
};

function DynamicOrb({ orbState, speakingTick = 0 }: { orbState: OrbState; speakingTick?: number }) {
  const breathe      = useRef(new Animated.Value(1)).current;
  const outerOpacity = useRef(new Animated.Value(0.35)).current;
  const burstScale   = useRef(new Animated.Value(1)).current;
  const burstOpacity = useRef(new Animated.Value(0)).current;

  const cfg = ORB_CFG[orbState];

  useEffect(() => {
    const b = Animated.loop(Animated.sequence([
      Animated.timing(breathe,      { toValue: cfg.scale, duration: cfg.dur,        useNativeDriver: true }),
      Animated.timing(breathe,      { toValue: 1,         duration: cfg.dur,        useNativeDriver: true }),
    ]));
    const o = Animated.loop(Animated.sequence([
      Animated.timing(outerOpacity, { toValue: cfg.oMax,  duration: cfg.dur * 1.4,  useNativeDriver: true }),
      Animated.timing(outerOpacity, { toValue: cfg.oMin,  duration: cfg.dur * 1.4,  useNativeDriver: true }),
    ]));
    b.start(); o.start();
    return () => { b.stop(); o.stop(); };
  }, [orbState]);

  useEffect(() => {
    if (speakingTick === 0) return;
    burstScale.setValue(1);
    burstOpacity.setValue(0.75);
    Animated.parallel([
      Animated.timing(burstScale,   { toValue: 2.1, duration: 750, useNativeDriver: true }),
      Animated.timing(burstOpacity, { toValue: 0,   duration: 750, useNativeDriver: true }),
    ]).start();
  }, [speakingTick]);

  const { c: gradColors } = cfg;

  return (
    <View style={orb.wrap}>
      {/* Voice-activity burst ring */}
      <Animated.View style={[orb.ringBurst, {
        borderColor: gradColors[0], opacity: burstOpacity, transform: [{ scale: burstScale }],
      }]} />
      {/* Outer faint ring — pulses opacity */}
      <Animated.View style={[orb.ringOuter, { borderColor: gradColors[0], opacity: outerOpacity }]} />
      {/* Mid ring — breathes scale */}
      <Animated.View style={[orb.ringMid, { borderColor: gradColors[0] + '60', transform: [{ scale: breathe }] }]} />
      {/* Inner gradient ring */}
      <LinearGradient colors={gradColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={orb.ringGradient}>
        <View style={orb.ringCutout}>
          {orbState === 'human'
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
  ringBurst:   { position: 'absolute', width: 204, height: 204, borderRadius: 102, borderWidth: 2 },
  ringOuter:   { position: 'absolute', width: 204, height: 204, borderRadius: 102, borderWidth: 1 },
  ringMid:     { position: 'absolute', width: 170, height: 170, borderRadius: 85,  borderWidth: 1.5 },
  ringGradient:{ width: 136, height: 136, borderRadius: 68, alignItems: 'center', justifyContent: 'center' },
  ringCutout:  { width: 131, height: 131, borderRadius: 65.5, backgroundColor: '#020617', alignItems: 'center', justifyContent: 'center' },
  appIcon:     { width: 64, height: 64 },
});

// ─── Active Call Screen ───────────────────────────────────────────────────────

function getOrbState(status: string): OrbState {
  if (['HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'].includes(status)) return 'human';
  if (status === 'ON_HOLD')                                             return 'waiting';
  if (['IVR_NAVIGATION', 'EXPLORATION'].includes(status))              return 'navigating';
  if (['INIT', 'DIALING'].includes(status))                            return 'dialing';
  return 'navigating';
}

// Step labels resolved in component via t() — keys only here
const STEP_KEYS = [
  { key: 'dialing'    as OrbState, tKey: 'step_dialing',    color: '#3b82f6' },
  { key: 'navigating' as OrbState, tKey: 'step_navigating', color: '#a78bfa' },
  { key: 'waiting'    as OrbState, tKey: 'step_hold',       color: '#f59e0b' },
  { key: 'human'      as OrbState, tKey: 'step_human',      color: '#25D366' },
];

interface ActiveCallViewProps {
  call: Call;
  cfg: { label: string; color: string; bg: string };
  isHuman: boolean;
  isActive: boolean;
  confidence: number;
  transcripts: NonNullable<Call['transcripts']>;
  onEnd: () => void;
}

function ActiveCallView({ call, cfg, isHuman, confidence, transcripts, onEnd }: ActiveCallViewProps) {
  const { t } = useTranslation();
  const [showTranscript, setShowTranscript] = useState(false);
  const orbState     = getOrbState(call.status);
  const prevLen      = useRef(0);
  const transcriptRef = useRef<ScrollView>(null);
  const [speakingTick, setSpeakingTick] = useState(0);

  useEffect(() => {
    if (transcripts.length > prevLen.current) {
      prevLen.current = transcripts.length;
      setSpeakingTick(t => t + 1);
    }
  }, [transcripts.length]);

  const STEPS = STEP_KEYS.map(s => ({ ...s, label: t(s.tKey) }));
  const stepIdx = STEPS.findIndex(st => st.key === orbState);
  const activeStep = STEPS[stepIdx] ?? STEPS[0];

  return (
    <SafeAreaView style={s.callScreen}>
      {/* Header — company name + End button only */}
      <View style={s.callHeader}>
        <Text style={s.callHeaderTitle} numberOfLines={1}>{call.company}</Text>
        <TouchableOpacity style={s.callEndBtnSmall} onPress={onEnd} activeOpacity={0.8}>
          <Ionicons name="call" size={14} color="#fff" />
          <Text style={s.callEndBtnSmallTxt}>{t('end')}</Text>
        </TouchableOpacity>
      </View>

      {/* Center: Orb + status block + transcript */}
      <View style={[s.callCenter, showTranscript && { justifyContent: 'flex-start' }]}>
        <View style={[s.callOrbBlock, showTranscript && { paddingTop: 12, paddingBottom: 4 }]}>
        <DynamicOrb orbState={orbState} speakingTick={speakingTick} />

        {isHuman ? (
          <View style={s.callHumanTextBlock}>
            <Text style={s.callHumanTitle}>{t('human_found')}</Text>
            <Text style={s.callHumanSub}>{t('keep_phone')}</Text>
          </View>
        ) : (
          <View style={s.callStatusBlock}>
            <Text style={[s.callStatusLabel, { color: activeStep.color }]}>{cfg.label}</Text>
            {/* Step progress dots */}
            <View style={s.stepRow}>
              {STEPS.map((st, i) => (
                <View
                  key={st.key}
                  style={[
                    s.stepDot,
                    i < stepIdx  && s.stepDotDone,
                    i === stepIdx && { backgroundColor: activeStep.color, width: 22, borderRadius: 4 },
                  ]}
                />
              ))}
            </View>
            {/* Confidence bar (shown when AI detects a possible human) */}
            {confidence > 0 && (
              <View style={s.callConfBlock}>
                <Text style={s.callConfHint}>{t('sounds_human')}</Text>
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
            )}
          </View>
        )}
        </View>{/* end callOrbBlock */}

        {/* Transcript toggle */}
        <TouchableOpacity style={s.transcriptToggle} onPress={() => setShowTranscript(v => !v)}>
          <Ionicons name="document-text-outline" size={15} color={colors.muted} />
          <Text style={s.transcriptToggleTxt}>{t('live_transcript')}</Text>
          {transcripts.length > 0 && (
            <View style={s.transcriptBadge}>
              <Text style={s.transcriptBadgeTxt}>{transcripts.length}</Text>
            </View>
          )}
          <Ionicons name={showTranscript ? 'chevron-up' : 'chevron-down'} size={15} color={colors.muted} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>

        {showTranscript && (
          <ScrollView
            ref={transcriptRef}
            style={s.transcriptList}
            contentContainerStyle={{ padding: 12, paddingTop: 8 }}
            onContentSizeChange={() => transcriptRef.current?.scrollToEnd({ animated: true })}
          >
            {transcripts.length === 0 ? (
              <Text style={s.transcriptEmpty}>{t('waiting_ivr')}</Text>
            ) : (
              transcripts.map((t, i) => {
                const isAI       = t.speaker === 'AI';
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
            <Text style={s.callInfoTxt}>{t('call_info')}</Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────

export default function CallScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [company, setCompany]     = useState('');
  const [phone, setPhone]         = useState('');
  const [goal, setGoal]           = useState('');
  const [companyStats, setCompanyStats] = useState<CompanyStats | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ company: string; phone: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSelectedRef = useRef(false);
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

  useEffect(() => {
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    if (company.trim().length < 2) { setCompanyStats(null); return; }
    statsTimerRef.current = setTimeout(() => {
      getCompanyStats(company.trim()).then(setCompanyStats).catch(() => setCompanyStats(null));
    }, 500);
    return () => { if (statsTimerRef.current) clearTimeout(statsTimerRef.current); };
  }, [company]);

  useEffect(() => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    if (justSelectedRef.current) { justSelectedRef.current = false; return; }
    if (company.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
    suggestTimerRef.current = setTimeout(() => {
      getCompanySuggestions(company.trim()).then(res => {
        setSuggestions(res);
        setShowSuggestions(res.length > 0);
      }).catch(() => setSuggestions([]));
    }, 200);
    return () => { if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current); };
  }, [company]);

  const handleStart = async () => {
    if (submitting.current) return;
    if (!company.trim() || !phone.trim()) {
      Alert.alert(t('missing_info_title'), t('missing_info_body'));
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
      } else if (e.code === 'DAILY_LIMIT_REACHED') {
        Alert.alert(t('daily_limit_title'), e.message);
      } else if (e.code === 'MISSING_CALLBACK_PHONE') {
        Alert.alert(
          t('callback_required_title'),
          t('callback_required_body'),
          [
            { text: t('cancel'), style: 'cancel' },
            { text: t('go_to_profile'), onPress: () => router.push('/(tabs)/profile') },
          ]
        );
      } else {
        Alert.alert(t('error'), e.message ?? t('save_failed'));
      }
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  // ── Active call — render full screen ──
  if (activeCall) {
    const call = activeCall;
    const cfg     = STATUS[call.status] ?? STATUS['ENDED'];
    const isHuman = ['HUMAN_DETECTED', 'USER_NOTIFIED', 'BRIDGED'].includes(call.status);
    return (
      <ActiveCallView
        call={call} cfg={cfg} isHuman={isHuman} isActive={false}
        confidence={call.human_confidence ?? 0}
        transcripts={call.transcripts ?? []}
        onEnd={() => endCall(call.id).then(refresh)}
      />
    );
  }

  // ── Home screen ──
  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAwareScrollView
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
        extraScrollHeight={120}
        enableOnAndroid
      >

        {/* Hero — left-aligned */}
        <View style={s.heroBlock}>
          <Text style={s.heroTitle}><Text style={{ color: colors.green }}>{t('hero_highlight')}</Text>{t('hero_title_rest')}</Text>
          <Text style={s.heroSub}>{t('hero_sub')}</Text>
        </View>

        {/* Orb — centered */}
        <View style={s.orbCenter}>
          <DynamicOrb orbState="idle" />
        </View>

        {/* Primary inputs + CTA — all visible without scrolling */}
        <View style={s.form}>

          <View style={s.companyWrap}>
            <View style={s.iconInput}>
              <Ionicons name="business-outline" size={18} color={colors.muted} style={s.iconInputIcon} />
              <TextInput
                style={s.iconInputField} placeholder={t('company_placeholder')}
                placeholderTextColor={colors.muted} value={company}
                onChangeText={setCompany}
              />
              {company.length > 0 && (
                <TouchableOpacity onPress={() => { setCompany(''); setSuggestions([]); setCompanyStats(null); }}>
                  <Ionicons name="close-circle" size={17} color={colors.muted} />
                </TouchableOpacity>
              )}
            </View>
            {showSuggestions && suggestions.length > 0 && (
              <View style={s.dropdown}>
                {suggestions.map((item, i) => (
                  <TouchableOpacity
                    key={`${item.company}-${i}`}
                    style={[s.dropdownItem, i < suggestions.length - 1 && s.dropdownItemBorder]}
                    onPress={() => {
                      justSelectedRef.current = true;
                      setCompany(item.company);
                      setPhone(item.phone.startsWith('+1') ? item.phone.slice(2) : item.phone);
                      setSuggestions([]);
                      setShowSuggestions(false);
                    }}
                  >
                    <Ionicons name="time-outline" size={14} color={colors.muted} style={{ marginRight: 8 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.dropdownCompany}>{item.company}</Text>
                      <Text style={s.dropdownPhone}>{item.phone}</Text>
                    </View>
                    <Ionicons name="arrow-up-outline" size={13} color={colors.muted} style={{ transform: [{ rotate: '45deg' }] }} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {companyStats && companyStats.total >= 1 && (
            <View style={s.statsHint}>
              <Ionicons name="bar-chart-outline" size={11} color={colors.muted} />
              <Text style={s.statsHintTxt}>
                {companyStats.total === 1 ? t('stats_calls_one') : t('stats_calls_other', { count: companyStats.total })}
                {' · '}{t('stats_success', { pct: companyStats.successPct })}
                {companyStats.avgWaitSecs ? ' · ' + t('stats_avg_wait', { min: Math.round(companyStats.avgWaitSecs / 60) }) : ''}
              </Text>
            </View>
          )}

          <View style={[s.iconInput, { marginBottom: 12 }]}>
            <Ionicons name="call-outline" size={18} color={colors.muted} style={s.iconInputIcon} />
            <TextInput
              style={s.iconInputField} placeholder={t('phone_placeholder')}
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
                : <><Ionicons name="sparkles" size={20} color="#fff" /><Text style={s.startBtnTxt}>{t('start_call')}</Text></>
              }
            </LinearGradient>
          </TouchableOpacity>

        </View>

        {/* ─ Secondary options (scroll to see) ─ */}

        <View style={s.formSecondary}>
          <Text style={s.fieldLabel}>{t('goal_label')} <Text style={s.fieldLabelOpt}>{t('goal_optional')}</Text></Text>
          <TextInput
            style={[s.input, { marginBottom: 8 }]} placeholder={t('goal_placeholder')}
            placeholderTextColor={colors.muted} value={goal} onChangeText={setGoal}
          />
          <View style={s.goalChips}>
            {([
              { value: 'Billing issue',       label: t('goal_billing') },
              { value: 'Cancel subscription', label: t('goal_cancel') },
              { value: 'Refund request',      label: t('goal_refund') },
              { value: 'Technical support',   label: t('goal_support') },
            ] as const).map(chip => (
              <TouchableOpacity
                key={chip.value}
                style={[s.goalChip, goal === chip.value && s.goalChipActive]}
                onPress={() => setGoal(goal === chip.value ? '' : chip.value)}
              >
                <Text style={[s.goalChipTxt, goal === chip.value && s.goalChipTxtActive]}>{chip.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

        </View>

        {/* Recent session pills */}
        {templates.length > 0 && (
          <View style={s.recentSection}>
            <Text style={[s.fieldLabel, { paddingHorizontal: 22, marginBottom: 10 }]}>{t('recent')}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 22 }}
            >
              {templates.map((t, i) => (
                <TouchableOpacity
                  key={i}
                  style={s.recentPill}
                  onPress={() => { justSelectedRef.current = true; setCompany(t.company); setPhone(t.phone); setGoal(t.goal); }}
                >
                  <Text style={s.recentPillCompany} numberOfLines={1}>{t.company}</Text>
                  {t.goal ? <Text style={s.recentPillGoal} numberOfLines={1}>{t.goal}</Text> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </KeyboardAwareScrollView>
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

  companyWrap:    { marginBottom: 12 },
  iconInput:      { flexDirection: 'row', alignItems: 'center', height: 56, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 18, paddingHorizontal: 16 },
  iconInputIcon:  { marginRight: 10 },
  iconInputField: { flex: 1, color: colors.text, fontSize: 15 },

  dropdown:          { marginTop: 4, backgroundColor: '#0f172a', borderWidth: 1, borderColor: colors.border, borderRadius: 14, overflow: 'hidden' },
  dropdownItem:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  dropdownItemBorder:{ borderBottomWidth: 1, borderBottomColor: colors.border },
  dropdownCompany:   { fontSize: 14, fontWeight: '600', color: colors.text },
  dropdownPhone:     { fontSize: 11, color: colors.muted, marginTop: 1 },
  statsHint:      { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: -6, marginBottom: 10, paddingHorizontal: 4 },
  statsHintTxt:   { fontSize: 11, color: colors.muted },

  startBtnWrap: { borderRadius: 18, overflow: 'hidden', marginTop: 4 },
  startBtn:     { paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  startBtnTxt:  { color: '#fff', fontSize: 16, fontWeight: '700' },

  // ── Active call ──
  callScreen:  { flex: 1, backgroundColor: '#060c18' },

  callHeader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(30,41,59,0.6)' },
  callHeaderTitle: { fontSize: 18, fontWeight: '800', color: colors.text },

  callCenter:  { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  callOrbBlock:{ alignItems: 'center' },

  callHumanTextBlock: { alignItems: 'center', marginTop: 24 },
  callHumanTitle:     { fontSize: 36, fontWeight: '800', color: colors.green, letterSpacing: -0.5 },
  callHumanSub:       { fontSize: 15, color: 'rgba(37,211,102,0.6)', marginTop: 6 },

  // Status block below orb
  callStatusBlock: { alignItems: 'center', marginTop: 20, marginBottom: 4 },
  callStatusLabel: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 14, letterSpacing: 0.1 },
  stepRow:         { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepDot:         { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)' },
  stepDotDone:     { backgroundColor: 'rgba(255,255,255,0.30)' },

  callConfBlock: { alignItems: 'center', marginTop: 16, width: '75%' },
  callConfHint:  { fontSize: 12, color: colors.subtext, marginBottom: 8, textAlign: 'center' },
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
  transcriptList:      { flex: 1 },
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
