import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ColorValue } from 'react-native';
import { colors } from '@/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function tabIcon(name: IoniconName) {
  return ({ color, size }: { focused: boolean; color: ColorValue; size: number }) => (
    <Ionicons name={name} size={size} color={color as string} />
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'rgba(15,23,42,0.96)',
          borderTopColor: 'rgba(30,41,59,0.6)',
          borderTopWidth: 0.5,
          paddingBottom: 4,
        },
        tabBarActiveTintColor: '#25D366',
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index"   options={{ title: 'Agent',    tabBarIcon: tabIcon('headset') }} />
      <Tabs.Screen name="history" options={{ title: 'Sessions', tabBarIcon: tabIcon('time-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'You',      tabBarIcon: tabIcon('person-outline') }} />
    </Tabs>
  );
}
