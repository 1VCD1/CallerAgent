import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '@/hooks/useTheme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function tabIcon(name: IoniconName) {
  return ({ color, size }: { focused: boolean; color: ColorValue; size: number }) => (
    <Ionicons name={name} size={size} color={color as string} />
  );
}

export default function TabLayout() {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.tabBar,
          borderTopColor: c.tabBarBorder,
          borderTopWidth: 0.5,
          paddingBottom: 4,
        },
        tabBarActiveTintColor: '#25D366',
        tabBarInactiveTintColor: c.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index"   options={{ title: t('tab_agent'),    tabBarIcon: tabIcon('headset') }} />
      <Tabs.Screen name="history" options={{ title: t('tab_sessions'), tabBarIcon: tabIcon('time-outline') }} />
      <Tabs.Screen name="profile" options={{ title: t('tab_you'),      tabBarIcon: tabIcon('person-outline') }} />
    </Tabs>
  );
}
