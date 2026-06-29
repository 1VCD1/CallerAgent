import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PALETTES, type Palette, type ThemeMode } from '@/theme';

const STORAGE_KEY = 'themeMode';

interface ThemeStore {
  mode: ThemeMode;
  hydrated: boolean;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  hydrate: () => Promise<void>;
}

// Default is 'light' — a first-time user (no stored value) gets light mode.
export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: 'light',
  hydrated: false,
  setMode: (mode) => {
    set({ mode });
    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => {});
  },
  toggle: () => get().setMode(get().mode === 'dark' ? 'light' : 'dark'),
  hydrate: async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      set({ mode: stored === 'dark' ? 'dark' : 'light', hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
}));

// Active palette for the current theme. Re-renders consumers on mode change.
export const useThemeColors = (): Palette => useThemeStore((s) => PALETTES[s.mode]);
