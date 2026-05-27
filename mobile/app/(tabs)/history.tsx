import { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { colors, STATUS, ACTIVE_STATUSES } from '@/theme';
import { getUserId, getCalls, endCall } from '@/api';
import type { Call } from '@/api';

function timeAgo(d: string) {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function HistoryScreen() {
  const router = useRouter();
  const [calls, setCalls]         = useState<Call[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const uid = await getUserId();
      if (uid) setCalls(await getCalls(uid, 30));
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.title}>History</Text>
        <Text style={s.count}>{calls.length} calls</Text>
      </View>
      <FlatList
        data={calls}
        keyExtractor={c => c.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Ionicons name="call-outline" size={44} color={colors.muted} />
            <Text style={s.emptyTxt}>No calls yet</Text>
            <Text style={s.emptySubTxt}>Start a call from the Call tab</Text>
          </View>
        }
        renderItem={({ item }) => {
          const cfg = STATUS[item.status] ?? STATUS['ENDED'];
          const isActive = ACTIVE_STATUSES.includes(item.status);
          return (
            <TouchableOpacity style={s.card} onPress={() => router.push(`/call/${item.id}` as any)} activeOpacity={0.7}>
              <View style={s.topRow}>
                <Text style={s.company}>{item.company}</Text>
                <View style={[s.badge, { backgroundColor: cfg.bg }]}>
                  <Text style={[s.badgeTxt, { color: cfg.color }]}>● {cfg.label}</Text>
                </View>
              </View>
              <Text style={s.phone}>{item.phone_number}</Text>
              <View style={s.metaRow}>
                <Text style={s.meta}>{timeAgo(item.started_at)}</Text>
                {item.wait_duration_seconds ? <Text style={s.meta}>· {item.wait_duration_seconds}s wait</Text> : null}
                {item.human_reached && (
                  <View style={s.pill}>
                    <Ionicons name="checkmark-circle" size={11} color={colors.green} />
                    <Text style={s.pillTxt}>Human reached</Text>
                  </View>
                )}
                {isActive && (
                  <TouchableOpacity style={s.endBtn} onPress={(e) => { e.stopPropagation(); endCall(item.id).then(load); }}>
                    <Text style={s.endBtnTxt}>End</Text>
                  </TouchableOpacity>
                )}
                <Ionicons name="chevron-forward" size={14} color={colors.muted} style={{ marginLeft: 'auto' }} />
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: colors.bg },
  header:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  title:    { fontSize: 22, fontWeight: '700', color: colors.text },
  count:    { fontSize: 13, color: colors.muted },
  list:     { padding: 16, paddingTop: 8, paddingBottom: 32 },
  card:     { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 10 },
  topRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  company:  { fontSize: 15, fontWeight: '600', color: colors.text, flex: 1, marginRight: 8 },
  phone:    { fontSize: 12, color: colors.subtext, marginBottom: 8 },
  badge:    { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeTxt: { fontSize: 11, fontWeight: '600' },
  metaRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  meta:     { fontSize: 12, color: colors.muted },
  pill:     { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#052e16', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99 },
  pillTxt:  { fontSize: 11, color: colors.green, fontWeight: '600' },
  endBtn:   { borderWidth: 1, borderColor: '#7f1d1d', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 3 },
  endBtnTxt:{ color: colors.red, fontSize: 11, fontWeight: '600' },
  empty:    { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTxt: { fontSize: 16, fontWeight: '600', color: colors.subtext },
  emptySubTxt: { fontSize: 13, color: colors.muted },
});
