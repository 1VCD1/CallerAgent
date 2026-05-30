import { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { colors, STATUS, ACTIVE_STATUSES } from '@/theme';
import { getCalls, endCall } from '@/api';
import { useCallStore } from '@/store';
import { getOutcomeConfig, NON_FAILURE_REASONS } from '@/outcome';
import { translateGoal } from '@/i18n';

function useTimeAgo() {
  const { t } = useTranslation();
  return (d: string) => {
    const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
    if (m < 1) return t('just_now');
    if (m < 60) return t('time_min', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('time_hour', { n: h });
    return t('time_day', { n: Math.floor(h / 24) });
  };
}

function fmtSeconds(s: number) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Filter = 'all' | 'success' | 'failed';

export default function HistoryScreen() {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter]         = useState<Filter>('all');
  const { callHistory, setCallHistory } = useCallStore();

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all',     label: t('filter_all') },
    { key: 'success', label: t('filter_success') },
    { key: 'failed',  label: t('filter_failed') },
  ];

  const load = useCallback(async () => {
    try { setCallHistory(await getCalls(30)); } catch {}
  }, [setCallHistory]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = callHistory.filter(c => {
    if (filter === 'success') return c.human_reached;
    if (filter === 'failed')  return !c.human_reached && !ACTIVE_STATUSES.includes(c.status) && !NON_FAILURE_REASONS.has(c.ended_reason ?? '');
    return true;
  });

  // Stats — success rate excludes non-failure reasons (closed, voicemail, etc.)
  const total         = callHistory.length;
  const humanReach    = callHistory.filter(c => c.human_reached);
  const countableBase = callHistory.filter(c => !ACTIVE_STATUSES.includes(c.status) && !NON_FAILURE_REASONS.has(c.ended_reason ?? ''));
  const waits         = humanReach.map(c => c.wait_duration_seconds).filter((w): w is number => w != null);
  const avgWait       = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;
  const successRate   = countableBase.length > 0 ? Math.round((humanReach.length / countableBase.length) * 100) : null;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.title}>{t('sessions')}</Text>
      </View>

      {/* Stats row */}
      {total > 0 && (
        <View style={s.statsRow}>
          <View style={s.statCell}>
            <Text style={s.statValue}>{total}</Text>
            <Text style={s.statLabel}>{t('stat_total')}</Text>
          </View>
          <View style={s.statDivider} />
          {avgWait != null && (
            <>
              <View style={s.statCell}>
                <Text style={s.statValue}>{fmtSeconds(avgWait)}</Text>
                <Text style={s.statLabel}>{t('stat_avg_wait')}</Text>
              </View>
              <View style={s.statDivider} />
            </>
          )}
          {successRate != null && (
            <View style={s.statCell}>
              <Text style={[s.statValue, { color: colors.green }]}>{successRate}%</Text>
              <Text style={s.statLabel}>{t('stat_success_rate')}</Text>
            </View>
          )}
        </View>
      )}

      {/* Filter chips */}
      <View style={s.filterRow}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f.key}
            style={[s.filterTab, filter === f.key && (
              f.key === 'failed' ? s.filterTabFailed : s.filterTabActive
            )]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[s.filterTxt,
              filter === f.key && f.key !== 'failed' && s.filterTxtActive,
              filter === f.key && f.key === 'failed' && s.filterTxtFailed,
            ]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.green} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <View style={s.emptyIcon}>
              <Ionicons name="call-outline" size={30} color={colors.muted} />
            </View>
            <Text style={s.emptyTxt}>{filter === 'all' ? t('no_sessions') : t('no_matching_sessions')}</Text>
            <Text style={s.emptySubTxt}>{filter === 'all' ? t('start_from_agent') : t('try_filter')}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const cfg      = STATUS[item.status] ?? STATUS['ENDED'];
          const isActive = ACTIVE_STATUSES.includes(item.status);
          const outcome  = getOutcomeConfig(item);
          const accentColor = item.human_reached ? colors.green
                            : item.status === 'FAILED' ? colors.red
                            : isActive ? cfg.color
                            : outcome.color === '#64748b' ? colors.border : outcome.color;
          return (
            <TouchableOpacity
              style={[s.card, { borderLeftColor: accentColor }]}
              onPress={() => router.push(`/call/${item.id}` as any)}
              activeOpacity={0.75}
            >
              {/* Row 1: company + outcome pill */}
              <View style={s.cardTop}>
                <Text style={s.company} numberOfLines={1}>{item.company}</Text>
                {isActive ? (
                  <View style={[s.badge, { backgroundColor: cfg.bg }]}>
                    <Text style={[s.badgeTxt, { color: cfg.color }]}>{cfg.label}</Text>
                  </View>
                ) : (
                  <View style={[s.outcomePill, { backgroundColor: outcome.bg, borderColor: outcome.border }]}>
                    {outcome.icon && <Ionicons name={outcome.icon as any} size={11} color={outcome.color} />}
                    {item.human_reached && <Ionicons name="checkmark-circle" size={11} color={outcome.color} />}
                    <Text style={[s.outcomePillTxt, { color: outcome.color }]}>{outcome.label}</Text>
                  </View>
                )}
              </View>

              {/* Row 1b: goal */}
              {item.goal ? (
                <Text style={s.goal} numberOfLines={1}>{translateGoal(item.goal, t)}</Text>
              ) : null}

              {/* Row 2: time */}
              <View style={s.cardSub}>
                <Text style={s.timeAgo}>{timeAgo(item.started_at)}</Text>
              </View>

              {/* Row 3: stats + actions */}
              <View style={s.cardMeta}>
                {item.ended_at ? (() => {
                  const secs = Math.floor((new Date(item.ended_at).getTime() - new Date(item.started_at).getTime()) / 1000);
                  return (
                    <View style={s.statChip}>
                      <Ionicons name="hourglass-outline" size={11} color={colors.muted} />
                      <Text style={s.statChipTxt}>{t('saved_time', { time: fmtSeconds(secs) })}</Text>
                    </View>
                  );
                })() : null}
                {item.wait_duration_seconds ? (
                  <View style={s.statChip}>
                    <Ionicons name="time-outline" size={11} color={colors.muted} />
                    <Text style={s.statChipTxt}>{t('wait_time', { time: fmtSeconds(item.wait_duration_seconds) })}</Text>
                  </View>
                ) : null}

                {isActive && (
                  <TouchableOpacity
                    style={s.endBtn}
                    onPress={e => { e.stopPropagation(); endCall(item.id).then(load); }}
                  >
                    <Text style={s.endBtnTxt}>{t('end')}</Text>
                  </TouchableOpacity>
                )}

                <Ionicons name="chevron-forward" size={13} color={colors.muted} style={{ marginLeft: 'auto' }} />
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 14 },
  title:  { fontSize: 26, fontWeight: '800', color: colors.text },

  statsRow:    { flexDirection: 'row', alignItems: 'center', marginHorizontal: 22, marginBottom: 16, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, paddingVertical: 14 },
  statCell:    { flex: 1, alignItems: 'center' },
  statValue:   { fontSize: 22, fontWeight: '800', color: colors.text },
  statLabel:   { fontSize: 11, color: colors.muted, marginTop: 2 },
  statDivider: { width: 1, height: 32, backgroundColor: colors.border },

  filterRow:       { flexDirection: 'row', paddingHorizontal: 22, gap: 8, marginBottom: 12 },
  filterTab:       { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  filterTabActive: { borderColor: colors.green, backgroundColor: 'rgba(37,211,102,0.10)' },
  filterTabFailed: { borderColor: colors.red,   backgroundColor: 'rgba(239,68,68,0.08)' },
  filterTxt:       { fontSize: 12, fontWeight: '600', color: colors.muted },
  filterTxtActive: { color: colors.green },
  filterTxtFailed: { color: colors.red },

  list: { paddingHorizontal: 22, paddingBottom: 40 },

  card:    { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 10 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
  company: { fontSize: 17, fontWeight: '700', color: colors.text, flex: 1 },

  goal:    { fontSize: 12, color: colors.subtext, marginBottom: 6, marginTop: 2 },
  cardSub: { marginBottom: 8 },
  timeAgo: { fontSize: 12, color: colors.muted },

  badge:    { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 1 },
  badgeTxt: { fontSize: 11, fontWeight: '600' },

  outcomePill:    { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99 },
  outcomePillTxt: { fontSize: 11, fontWeight: '600' },

  cardMeta:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statChip:  { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 },
  statChipTxt: { fontSize: 11, color: colors.muted },

  endBtn:    { borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 3 },
  endBtnTxt: { color: colors.red, fontSize: 11, fontWeight: '600' },

  empty:      { alignItems: 'center', paddingTop: 80, gap: 10 },
  emptyIcon:  { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTxt:   { fontSize: 16, fontWeight: '600', color: colors.subtext },
  emptySubTxt:{ fontSize: 13, color: colors.muted },
});
