import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import en from './locales/en';
import zhTW from './locales/zh-TW';
import zhCN from './locales/zh-CN';

export type AppLanguage = 'en' | 'zh-TW' | 'zh-CN';

export function resolveLocale(tag: string): AppLanguage {
  if (tag.startsWith('zh-Hant') || tag.startsWith('zh-TW') || tag.startsWith('zh-HK') || tag.startsWith('zh-MO')) return 'zh-TW';
  if (tag.startsWith('zh')) return 'zh-CN';
  return 'en';
}

const deviceLocale = Localization.getLocales()[0]?.languageTag ?? 'en';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en:      { translation: en },
      'zh-TW': { translation: zhTW },
      'zh-CN': { translation: zhCN },
    },
    lng: resolveLocale(deviceLocale),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    compatibilityJSON: 'v4',
  });

export default i18n;
