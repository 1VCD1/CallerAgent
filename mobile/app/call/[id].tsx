import { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { useTranslation } from 'react-i18next';
import { colors, STATUS } from '@/theme';
import { getCall, getApiUrl, getCompanyNote, saveCompanyNote } from '@/api';
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
  const [showTranscript, setShowTranscript] = useState(false);
  const [note, setNote] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    getCall(id).then(c => {
      setCall(c);
      if (c.ended_at) {
        getCompanyNote(c.company).then(n => setNote(n ?? '')).catch(() => {});
      }
    }).catch(console.warn).finally(() => setLoading(false));
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    return () => { soundRef.current?.unloadAsync(); };
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

  async function togglePlayback() {
    if (!call?.recording_url) return;
    if (isPlaying) {
      await soundRef.current?.pauseAsync();
      setIsPlaying(false);
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
          { shouldPlay: true },
          status => { if (status.isLoaded && !status.isPlaying && status.didJustFinish) setIsPlaying(false); }
        );
        soundRef.current = sound;
      }
      setIsPlaying(true);
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

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Header */}
        <Text style={s.company}>{call.company}</Text>
        {call.goal ? <Text style={s.goal}>{call.goal}</Text> : null}
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
          <TouchableOpacity style={s.recordingBar} onPress={togglePlayback} disabled={audioLoading}>
            {audioLoading
              ? <ActivityIndicator size="small" color={colors.blue} />
              : <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={34} color={colors.blue} />
            }
            <View style={{ flex: 1 }}>
              <Text style={s.recordingTitle}>{t('recording_title')}</Text>
              <Text style={s.recordingSubtitle}>{isPlaying ? t('recording_playing') : t('recording_tap')}</Text>
            </View>
            <Ionicons name="musical-notes-outline" size={16} color={colors.muted} />
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
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

  noteCard:        { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 16 },
  noteTitle:       { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1, marginBottom: 6 },
  noteHint:        { fontSize: 12, color: colors.muted, lineHeight: 17, marginBottom: 12 },
  noteInput:       { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, color: colors.text, fontSize: 14, lineHeight: 20, minHeight: 60 },
  noteSaveBtn:     { marginTop: 10, alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  noteSaveBtnDone: { borderColor: colors.green },
  noteSaveBtnTxt:  { fontSize: 13, fontWeight: '600', color: colors.subtext },

  recordingBar:     { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, marginTop: 24 },
  recordingTitle:   { fontSize: 14, fontWeight: '600', color: colors.text },
  recordingSubtitle:{ fontSize: 12, color: colors.muted, marginTop: 2 },

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
