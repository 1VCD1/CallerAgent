import { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { colors, STATUS } from '@/theme';
import { getCall, getApiUrl } from '@/api';
import type { Call, Transcript } from '@/api';

function timeAgo(d: string) {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function CallDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [call, setCall] = useState<Call | null>(null);
  const [loading, setLoading] = useState(true);
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
          (status) => { if (status.isLoaded && !status.isPlaying && status.didJustFinish) setIsPlaying(false); }
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
        <ActivityIndicator color={colors.blue} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  if (!call) {
    return (
      <SafeAreaView style={s.safe}>
        <Text style={s.errorTxt}>Call not found</Text>
      </SafeAreaView>
    );
  }

  const cfg = STATUS[call.status] ?? STATUS['ENDED'];
  const transcripts: Transcript[] = call.transcripts ?? [];

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={s.backTxt}>History</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {/* Header */}
        <Text style={s.company}>{call.company}</Text>
        <Text style={s.phone}>{call.phone_number}</Text>

        <View style={s.metaRow}>
          <View style={[s.badge, { backgroundColor: cfg.bg }]}>
            <Text style={[s.badgeTxt, { color: cfg.color }]}>● {cfg.label}</Text>
          </View>
          <Text style={s.meta}>{timeAgo(call.started_at)}</Text>
          {call.wait_duration_seconds ? <Text style={s.meta}>· {call.wait_duration_seconds}s wait</Text> : null}
          {call.human_reached && (
            <View style={s.humanPill}>
              <Ionicons name="checkmark-circle" size={12} color={colors.green} />
              <Text style={s.humanPillTxt}>Human reached</Text>
            </View>
          )}
        </View>

        {/* Recording player */}
        {call.recording_url && (
          <TouchableOpacity style={s.recordingBar} onPress={togglePlayback} disabled={audioLoading}>
            {audioLoading
              ? <ActivityIndicator size="small" color={colors.blue} />
              : <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={32} color={colors.blue} />
            }
            <View style={{ flex: 1 }}>
              <Text style={s.recordingTitle}>Call Recording</Text>
              <Text style={s.recordingSubtitle}>{isPlaying ? 'Playing…' : 'Tap to play'}</Text>
            </View>
            <Ionicons name="musical-notes-outline" size={18} color={colors.muted} />
          </TouchableOpacity>
        )}

        {/* Transcript */}
        <Text style={s.sectionTitle}>
          Transcript <Text style={s.sectionCount}>({transcripts.length} lines)</Text>
        </Text>

        {transcripts.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTxt}>No transcript recorded</Text>
          </View>
        ) : (
          transcripts.map((t, i) => {
            const pct = t.human_confidence != null ? Math.round(t.human_confidence * 100) : null;
            const isHighConf = pct != null && pct > 60;
            const isMidConf  = pct != null && pct > 30;
            return (
              <View key={t.id ?? i} style={s.line}>
                <View style={s.lineLeft}>
                  <Text style={s.lineTime}>{formatTime(t.timestamp)}</Text>
                  <View style={[s.speakerBadge, t.speaker === 'HUMAN' && s.speakerHuman, t.speaker === 'AI' && s.speakerAI]}>
                    <Text style={[s.speakerTxt, t.speaker === 'HUMAN' && { color: colors.green }, t.speaker === 'AI' && { color: colors.blue }]}>
                      {t.speaker}
                    </Text>
                  </View>
                </View>
                <View style={[s.lineBody, t.speaker === 'AI' && s.lineBodyAI]}>
                  <Text style={s.lineText}>{t.text}</Text>
                  {pct != null && (
                    <View style={s.lineConf}>
                      <View style={[s.confDot, {
                        backgroundColor: isHighConf ? colors.green : isMidConf ? colors.yellow : colors.muted,
                      }]} />
                      <Text style={[s.confTxt, {
                        color: isHighConf ? colors.green : isMidConf ? colors.yellow : colors.muted,
                      }]}>
                        {pct}% human confidence
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: colors.bg },
  topBar:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn:      { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backTxt:      { fontSize: 16, color: colors.text },
  scroll:       { padding: 16, paddingBottom: 48 },
  company:      { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 2 },
  phone:        { fontSize: 14, color: colors.subtext, marginBottom: 12 },
  metaRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 24 },
  badge:        { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  badgeTxt:     { fontSize: 11, fontWeight: '600' },
  meta:         { fontSize: 12, color: colors.muted },
  humanPill:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#052e16', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99 },
  humanPillTxt: { fontSize: 11, color: colors.green, fontWeight: '600' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.subtext, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  sectionCount: { fontWeight: '400', color: colors.muted },
  empty:        { padding: 24, alignItems: 'center' },
  emptyTxt:     { color: colors.muted, fontSize: 14 },
  line:         { flexDirection: 'row', gap: 10, marginBottom: 14 },
  lineLeft:     { alignItems: 'center', gap: 4, width: 52 },
  lineTime:     { fontSize: 9, color: colors.muted, textAlign: 'center' },
  speakerBadge: { backgroundColor: colors.border, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2 },
  speakerHuman: { backgroundColor: '#052e16' },
  speakerAI:    { backgroundColor: '#1e3a5f' },
  speakerTxt:   { fontSize: 9, fontWeight: '700', color: colors.muted },
  lineBody:     { flex: 1, backgroundColor: colors.card, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.border },
  lineBodyAI:   { backgroundColor: '#0f1f35', borderColor: '#1e3a5f' },
  lineText:     { fontSize: 13, color: colors.text, lineHeight: 19 },
  lineConf:     { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  confDot:      { width: 6, height: 6, borderRadius: 3 },
  confTxt:      { fontSize: 10, fontWeight: '600' },
  errorTxt:        { color: colors.muted, textAlign: 'center', marginTop: 60 },
  recordingBar:    { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: colors.border },
  recordingTitle:  { fontSize: 14, fontWeight: '600', color: colors.text },
  recordingSubtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
});
