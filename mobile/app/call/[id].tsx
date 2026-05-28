import { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { colors, STATUS } from '@/theme';
import { getCall, getApiUrl } from '@/api';
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
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const [call, setCall]           = useState<Call | null>(null);
  const [loading, setLoading]     = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    getCall(id).then(setCall).catch(console.warn).finally(() => setLoading(false));
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    return () => { soundRef.current?.unloadAsync(); };
  }, [id]);

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
          <Text style={s.backTxt}>Sessions</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.muted, fontSize: 15 }}>Session not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const cfg        = STATUS[call.status] ?? STATUS['ENDED'];
  const transcripts: Transcript[] = call.transcripts ?? [];

  return (
    <SafeAreaView style={s.safe}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={s.backTxt}>Sessions</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Header */}
        <Text style={s.company}>{call.company}</Text>
        <Text style={s.phone}>{call.phone_number}</Text>

        <View style={s.badges}>
          <View style={[s.badge, { backgroundColor: cfg.bg }]}>
            <Text style={[s.badgeTxt, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
          {call.human_reached && (
            <View style={s.humanPill}>
              <Ionicons name="checkmark-circle" size={12} color={colors.green} />
              <Text style={s.humanPillTxt}>Human reached</Text>
            </View>
          )}
        </View>

        {/* Stats grid */}
        <View style={s.statsGrid}>
          <StatCell label="Started" value={formatDate(call.started_at)} />
          <StatCell label="Duration" value={formatDuration(call.started_at, call.ended_at)} />
          {call.wait_duration_seconds != null && (
            <StatCell label="Wait time" value={`${call.wait_duration_seconds}s`} />
          )}
          {call.human_confidence != null && (
            <StatCell label="Confidence" value={`${Math.round(call.human_confidence * 100)}%`} />
          )}
        </View>

        {/* Recording */}
        {call.recording_url && (
          <TouchableOpacity style={s.recordingBar} onPress={togglePlayback} disabled={audioLoading}>
            {audioLoading
              ? <ActivityIndicator size="small" color={colors.blue} />
              : <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={34} color={colors.blue} />
            }
            <View style={{ flex: 1 }}>
              <Text style={s.recordingTitle}>Call Recording</Text>
              <Text style={s.recordingSubtitle}>{isPlaying ? 'Playing…' : 'Tap to play'}</Text>
            </View>
            <Ionicons name="musical-notes-outline" size={16} color={colors.muted} />
          </TouchableOpacity>
        )}

        {/* Transcript */}
        <View style={s.sectionRow}>
          <Text style={s.sectionTitle}>TRANSCRIPT</Text>
          <Text style={s.sectionCount}>{transcripts.length} lines</Text>
        </View>

        {transcripts.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTxt}>No transcript recorded</Text>
          </View>
        ) : (
          <View style={s.timeline}>
            {transcripts.map((t, i) => {
              const pct       = t.human_confidence != null ? Math.round(t.human_confidence * 100) : null;
              const isAI      = t.speaker === 'AI';
              const isHuman   = t.speaker === 'HUMAN';
              const isLast    = i === transcripts.length - 1;
              const dotColor  = isAI ? colors.blue : isHuman ? colors.green : colors.muted;
              return (
                <View key={t.id ?? i} style={s.timelineRow}>
                  {/* Left: dot + line */}
                  <View style={s.timelineLeft}>
                    <View style={[s.dot, { backgroundColor: dotColor }]} />
                    {!isLast && <View style={s.connector} />}
                  </View>
                  {/* Right: bubble */}
                  <View style={[s.bubble, isAI && s.bubbleAI, { marginBottom: isLast ? 0 : 12 }]}>
                    <View style={s.bubbleMeta}>
                      <Text style={[s.speaker, { color: dotColor }]}>{t.speaker}</Text>
                      <Text style={s.lineTime}>{formatTime(t.timestamp)}</Text>
                    </View>
                    <Text style={s.lineText}>{t.text}</Text>
                    {pct != null && (
                      <View style={s.confRow}>
                        <View style={[s.confDot, {
                          backgroundColor: pct > 60 ? colors.green : pct > 30 ? colors.yellow : colors.muted,
                        }]} />
                        <Text style={[s.confTxt, {
                          color: pct > 60 ? colors.green : pct > 30 ? colors.yellow : colors.muted,
                        }]}>{pct}% human confidence</Text>
                      </View>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
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
  topBar:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backTxt:  { fontSize: 16, color: colors.text },
  scroll:   { padding: 20, paddingBottom: 56 },

  company:  { fontSize: 24, fontWeight: '800', color: colors.text, marginBottom: 3 },
  phone:    { fontSize: 14, color: colors.subtext, marginBottom: 14 },

  badges:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  badge:    { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '600' },
  humanPill:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(37,211,102,0.12)', borderWidth: 1, borderColor: 'rgba(37,211,102,0.25)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99 },
  humanPillTxt: { fontSize: 12, color: colors.green, fontWeight: '600' },

  statsGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  statCell:   { flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12 },
  statLabel:  { fontSize: 10, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  statValue:  { fontSize: 15, fontWeight: '700', color: colors.text },

  recordingBar:     { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 24 },
  recordingTitle:   { fontSize: 14, fontWeight: '600', color: colors.text },
  recordingSubtitle:{ fontSize: 12, color: colors.muted, marginTop: 2 },

  sectionRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  sectionCount: { fontSize: 12, color: colors.muted },

  empty:    { padding: 28, alignItems: 'center' },
  emptyTxt: { color: colors.muted, fontSize: 14 },

  timeline:     { paddingBottom: 8 },
  timelineRow:  { flexDirection: 'row', gap: 12 },
  timelineLeft: { alignItems: 'center', width: 16 },
  dot:          { width: 10, height: 10, borderRadius: 5, marginTop: 12 },
  connector:    { flex: 1, width: 2, backgroundColor: colors.border, marginTop: 4 },

  bubble:     { flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border },
  bubbleAI:   { backgroundColor: '#0f1f35', borderColor: '#1e3a5f' },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  speaker:    { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  lineTime:   { fontSize: 10, color: colors.muted },
  lineText:   { fontSize: 13, color: colors.text, lineHeight: 20 },
  confRow:    { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  confDot:    { width: 5, height: 5, borderRadius: 3 },
  confTxt:    { fontSize: 10, fontWeight: '600' },
});
