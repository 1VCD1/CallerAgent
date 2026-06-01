import { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { useTranslation } from 'react-i18next';
import { colors, STATUS } from '@/theme';
import { translateGoal } from '@/i18n';
import { getCall, getApiUrl, getCompanyNote, saveCompanyNote, submitCallFeedback } from '@/api';
import { getOutcomeConfig } from '@/outcome';
import type { Call, Transcript } from '@/api';

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startedAt: string, endedAt?: string) {
  const ms = new Date(endedAt ?? Date.now()).getTime() - new Date(startedAt).getTime();
  const s  = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m  = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export default function CallDetailScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const [call, setCall]           = useState<Call | null>(null);
  const [loading, setLoading]     = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [position, setPosition] = useState(0);   // ms
  const [duration, setDuration] = useState(0);   // ms
  const [playbackDone, setPlaybackDone] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [userConfirmed, setUserConfirmed] = useState<boolean | null | undefined>(undefined);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [note, setNote] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const soundRef      = useRef<Audio.Sound | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPosRef    = useRef(0);
  const durationRef   = useRef(0); // mirror of duration state, always current inside intervals

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startPolling = () => {
    stopPolling();
    let wasPlaying = false;
    pollRef.current = setInterval(async () => {
      if (!soundRef.current) return;
      const status = await soundRef.current.getStatusAsync();
      if (!status.isLoaded) return;
      if ((status.durationMillis ?? 0) > 0) {
        durationRef.current = status.durationMillis!;
        setDuration(status.durationMillis!);
      }
      const pos = status.positionMillis ?? 0;
      if (pos > 0) lastPosRef.current = pos;
      setPosition(pos);

      if (status.isPlaying) {
        wasPlaying = true;
      } else if (wasPlaying && !status.isPlaying) {
        // was playing → now stopped = finished naturally
        setIsPlaying(false);
        setPlaybackDone(true); // stays at 100% until user presses play again
        stopPolling();
      }
    }, 500);
  };

  useEffect(() => {
    getCall(id).then(c => {
      setCall(c);
      setUserConfirmed(c.user_confirmed ?? null);
      if (c.ended_at) {
        getCompanyNote(c.company).then(n => setNote(n ?? '')).catch(() => {});
        // Use call duration as fallback for recording duration
        const ms = new Date(c.ended_at).getTime() - new Date(c.started_at).getTime();
        if (ms > 0) { durationRef.current = ms; setDuration(ms); }
      }
    }).catch(console.warn).finally(() => setLoading(false));
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    return () => {
      stopPolling();
      soundRef.current?.unloadAsync();
    };
  }, [id]);

  const saveNote = async () => {
    if (!call) return;
    setNoteSaving(true);
    try {
      await saveCompanyNote(call.company, note);
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 2000);
    } catch {} finally { setNoteSaving(false); }
  };

  const submitFeedback = async (confirmed: boolean) => {
    if (!call) return;
    setFeedbackSaving(true);
    try {
      await submitCallFeedback(call.id, confirmed);
      setUserConfirmed(confirmed);
    } catch {} finally { setFeedbackSaving(false); }
  };

  async function togglePlayback() {
    if (!call?.recording_url) return;
    if (isPlaying) {
      await soundRef.current?.pauseAsync();
      setIsPlaying(false);
      setPlaybackDone(false);
      stopPolling();
      return;
    }
    setAudioLoading(true);
    try {
      if (soundRef.current) {
        await soundRef.current.playAsync();
      } else {
        const apiUrl = await getApiUrl();
        const { sound } = await Audio.Sound.createAsync(
          { uri: `${apiUrl}/api/calls/${id}/recording` },
          { shouldPlay: true }
        );
        soundRef.current = sound;
      }
      setIsPlaying(true);
      setPlaybackDone(false);
      setPosition(0);
      startPolling();
    } catch (e) {
      console.warn('Audio error:', e);
    } finally {
      setAudioLoading(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={s.safe}>
        <ActivityIndicator color={colors.green} style={{ marginTop: 80 }} size="large" />
      </SafeAreaView>
    );
  }

  if (!call) {
    return (
      <SafeAreaView style={s.safe}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={s.backTxt}>{t('back_sessions')}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.muted, fontSize: 15 }}>{t('session_not_found')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const cfg        = STATUS[call.status] ?? STATUS['ENDED'];
  const outcome    = getOutcomeConfig(call);
  const transcripts: Transcript[] = call.transcripts ?? [];
  const isTerminal = !!call.ended_at;

  return (
    <SafeAreaView style={s.safe}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={s.backTxt}>{t('back_sessions')}</Text>
        </TouchableOpacity>
        {isTerminal && (
          <View style={[s.outcomePill, { backgroundColor: outcome.bg, borderColor: outcome.border }]}>
            {call.human_reached
              ? <Ionicons name="checkmark-circle" size={11} color={outcome.color} />
              : outcome.icon
              ? <Ionicons name={outcome.icon as any} size={11} color={outcome.color} />
              : null}
            <Text style={[s.outcomePillTxt, { color: outcome.color }]}>{outcome.label}</Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <Text style={s.company}>{call.company}</Text>
        {call.goal ? <Text style={s.goal}>{translateGoal(call.goal, t)}</Text> : null}
        <Text style={s.phone}>{call.phone_number}</Text>

        <View style={s.badges}>
          <View style={[s.badge, { backgroundColor: cfg.bg }]}>
            <Text style={[s.badgeTxt, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        </View>

        {/* Action hint banner — shown when there's something the user should do */}
        {isTerminal && outcome.actionHint && (
          <View style={[s.actionBanner, { borderColor: outcome.border, backgroundColor: outcome.bg }]}>
            <Ionicons name={outcome.icon as any ?? 'information-circle-outline'} size={18} color={outcome.color} style={{ flexShrink: 0 }} />
            <Text style={[s.actionBannerTxt, { color: outcome.color }]}>{outcome.actionHint}</Text>
          </View>
        )}

        {/* Stats grid */}
        <View style={s.statsGrid}>
          <StatCell label={t('stat_started')} value={formatDate(call.started_at)} />
          <StatCell label={t('stat_duration')} value={formatDuration(call.started_at, call.ended_at)} />
          {call.wait_duration_seconds != null && (
            <StatCell label={t('stat_wait_time')} value={`${call.wait_duration_seconds}s`} />
          )}
          {!!call.human_confidence && (
            <StatCell label={t('stat_confidence')} value={`${Math.round(call.human_confidence * 100)}%`} />
          )}
        </View>

        {/* Transcript */}
        <View style={s.transcriptCard}>
          <TouchableOpacity style={s.sectionRow} onPress={() => setShowTranscript(v => !v)} activeOpacity={0.7}>
            <Text style={s.sectionTitle}>{t('transcript')}</Text>
            <View style={s.sectionRight}>
              <Text style={s.sectionCount}>{t('transcript_lines', { count: transcripts.length })}</Text>
              <Ionicons name={showTranscript ? 'chevron-up' : 'chevron-down'} size={14} color={colors.muted} />
            </View>
          </TouchableOpacity>

          {showTranscript && (
            transcripts.length === 0 ? (
              <View style={s.empty}>
                <Text style={s.emptyTxt}>{t('no_transcript')}</Text>
              </View>
            ) : (
              <View style={{ paddingTop: 8, gap: 8 }}>
                {transcripts.map((tr, i) => {
                  const pct        = tr.human_confidence ? Math.round(tr.human_confidence * 100) : null;
                  const isAI       = tr.speaker === 'AI';
                  const isHumanSpk = tr.speaker === 'HUMAN';
                  return (
                    <View key={tr.id ?? i} style={[s.chatRow, isAI ? s.chatRowRight : s.chatRowLeft]}>
                      <View style={[s.chatBubble, isAI ? s.chatBubbleAI : isHumanSpk ? s.chatBubbleHuman : s.chatBubbleIVR]}>
                        <View style={s.chatMeta}>
                          <Text style={[s.chatSpeaker, { color: isAI ? colors.blue : isHumanSpk ? colors.green : colors.muted }]}>
                            {tr.speaker}
                          </Text>
                          <Text style={s.chatTime}>{formatTime(tr.timestamp)}</Text>
                        </View>
                        <Text style={[s.chatText, isAI && { color: '#93c5fd' }]}>{tr.text}</Text>
                        {pct != null && (
                          <View style={s.confRow}>
                            <View style={[s.confDot, {
                              backgroundColor: pct > 60 ? colors.green : pct > 30 ? colors.yellow : colors.muted,
                            }]} />
                            <Text style={[s.confTxt, {
                              color: pct > 60 ? colors.green : pct > 30 ? colors.yellow : colors.muted,
                            }]}>{t('human_confidence', { pct })}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )
          )}
        </View>

        {/* Feedback card — shown when AI detected human, user can confirm or reject */}
        {isTerminal && call.human_reached && (
          <View style={s.feedbackCard}>
            <Text style={s.feedbackTitle}>{t('feedback_title')}</Text>
            <Text style={s.feedbackHint}>{t('feedback_hint')}</Text>
            {userConfirmed === null || userConfirmed === undefined ? (
              <View style={s.feedbackBtns}>
                <TouchableOpacity
                  style={[s.feedbackBtn, s.feedbackBtnYes]}
                  onPress={() => submitFeedback(true)}
                  disabled={feedbackSaving}
                >
                  <Ionicons name="checkmark-circle-outline" size={16} color={colors.green} />
                  <Text style={[s.feedbackBtnTxt, { color: colors.green }]}>{t('feedback_yes')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.feedbackBtn, s.feedbackBtnNo]}
                  onPress={() => submitFeedback(false)}
                  disabled={feedbackSaving}
                >
                  <Ionicons name="close-circle-outline" size={16} color={colors.red} />
                  <Text style={[s.feedbackBtnTxt, { color: colors.red }]}>{t('feedback_no')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[s.feedbackResult, { borderColor: userConfirmed ? colors.green : colors.red }]}>
                <Ionicons
                  name={userConfirmed ? 'checkmark-circle' : 'close-circle'}
                  size={16}
                  color={userConfirmed ? colors.green : colors.red}
                />
                <Text style={[s.feedbackResultTxt, { color: userConfirmed ? colors.green : colors.red }]}>
                  {userConfirmed ? t('feedback_confirmed') : t('feedback_rejected')}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Tip for next call — only shown on completed calls */}
        {isTerminal && (
          <View style={s.noteCard}>
            <Text style={s.noteTitle}>{t('tip_title')}</Text>
            <Text style={s.noteHint}>{t('tip_hint', { company: call.company })}</Text>
            <TextInput
              style={s.noteInput}
              placeholder={t('tip_placeholder')}
              placeholderTextColor={colors.muted}
              value={note}
              onChangeText={setNote}
              maxLength={200}
              multiline
            />
            <TouchableOpacity
              style={[s.noteSaveBtn, noteSaved && s.noteSaveBtnDone]}
              onPress={saveNote}
              disabled={noteSaving}
            >
              {noteSaving
                ? <ActivityIndicator size="small" color={colors.green} />
                : <Text style={[s.noteSaveBtnTxt, noteSaved && { color: colors.green }]}>
                    {noteSaved ? t('tip_saved') : t('save_tip')}
                  </Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* Recording — bottom */}
        {call.recording_url && (
          <TouchableOpacity style={s.recordingBar} onPress={togglePlayback} disabled={audioLoading} activeOpacity={0.8}>
            {audioLoading
              ? <ActivityIndicator size="small" color={colors.blue} />
              : <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={34} color={colors.blue} />
            }
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={s.recordingTitle}>{t('recording_title')}</Text>
                {(isPlaying || position > 0) && (
                  <Text style={s.recordingTime}>{fmtMs(position)}</Text>
                )}
              </View>
              <Text style={s.recordingSubtitle}>
                {isPlaying ? t('recording_playing') : t('recording_tap')}
              </Text>
              {(isPlaying || position > 0 || playbackDone) && (
                <View style={s.recordingProgressTrack}>
                  <View style={[s.recordingProgressFill, {
                    width: playbackDone
                      ? '100%'
                      : duration > 0
                        ? `${Math.min((position / duration) * 100, 100)}%` as any
                        : '0%',
                  }]} />
                </View>
              )}
            </View>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.statCell}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: colors.bg },
  topBar:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backTxt:  { fontSize: 16, color: colors.text },

  outcomePill:    { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99 },
  outcomePillTxt: { fontSize: 12, fontWeight: '600' },
  actionBanner:   { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 16 },
  actionBannerTxt:{ fontSize: 13, flex: 1, lineHeight: 19, fontWeight: '500' },
  scroll:   { padding: 20, paddingBottom: 56 },

  company:  { fontSize: 24, fontWeight: '800', color: colors.text, marginBottom: 4 },
  goal:     { fontSize: 14, color: colors.subtext, marginBottom: 4 },
  phone:    { fontSize: 13, color: colors.muted, marginBottom: 14 },

  badges:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  badge:    { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '600' },

  statsGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  statCell:   { flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12 },
  statLabel:  { fontSize: 10, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  statValue:  { fontSize: 15, fontWeight: '700', color: colors.text },

  feedbackCard:      { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 16 },
  feedbackTitle:     { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1, marginBottom: 6 },
  feedbackHint:      { fontSize: 12, color: colors.muted, lineHeight: 17, marginBottom: 14 },
  feedbackBtns:      { flexDirection: 'row', gap: 10 },
  feedbackBtn:       { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 12, borderWidth: 1 },
  feedbackBtnYes:    { borderColor: colors.green, backgroundColor: 'rgba(37,211,102,0.08)' },
  feedbackBtnNo:     { borderColor: colors.red,   backgroundColor: 'rgba(239,68,68,0.08)' },
  feedbackBtnTxt:    { fontSize: 13, fontWeight: '600' },
  feedbackResult:    { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, backgroundColor: 'rgba(255,255,255,0.03)' },
  feedbackResultTxt: { fontSize: 13, fontWeight: '600' },

  noteCard:        { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 16 },
  noteTitle:       { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1, marginBottom: 6 },
  noteHint:        { fontSize: 12, color: colors.muted, lineHeight: 17, marginBottom: 12 },
  noteInput:       { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, color: colors.text, fontSize: 14, lineHeight: 20, minHeight: 60 },
  noteSaveBtn:     { marginTop: 10, alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  noteSaveBtnDone: { borderColor: colors.green },
  noteSaveBtnTxt:  { fontSize: 13, fontWeight: '600', color: colors.subtext },

  recordingBar:          { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, marginTop: 24 },
  recordingTitle:        { fontSize: 14, fontWeight: '600', color: colors.text },
  recordingSubtitle:     { fontSize: 12, color: colors.muted, marginTop: 2 },
  recordingTime:         { fontSize: 11, color: colors.muted },
  recordingProgressTrack:{ height: 3, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden', marginTop: 8 },
  recordingProgressFill: { height: 3, backgroundColor: colors.blue, borderRadius: 2 },

  transcriptCard: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 16 },
  sectionRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  sectionRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionCount: { fontSize: 12, color: colors.muted },

  empty:    { padding: 28, alignItems: 'center' },
  emptyTxt: { color: colors.muted, fontSize: 14 },

  chatRow:         { flexDirection: 'row' },
  chatRowLeft:     { justifyContent: 'flex-start' },
  chatRowRight:    { justifyContent: 'flex-end' },
  chatBubble:      { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  chatBubbleIVR:   { backgroundColor: '#1e293b', borderTopLeftRadius: 4 },
  chatBubbleHuman: { backgroundColor: '#052e16', borderTopLeftRadius: 4 },
  chatBubbleAI:    { backgroundColor: '#0c1a2e', borderTopRightRadius: 4 },
  chatMeta:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  chatSpeaker:     { fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  chatTime:        { fontSize: 9, color: colors.muted },
  chatText:        { fontSize: 13, color: colors.text, lineHeight: 19 },
  confRow:    { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  confDot:    { width: 5, height: 5, borderRadius: 3 },
  confTxt:    { fontSize: 10, fontWeight: '600' },
});
