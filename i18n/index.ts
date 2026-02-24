import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

import zh from './locales/zh.json';
import en from './locales/en.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import ar from './locales/ar.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

const LANGUAGE_KEY = 'pixnap_language';

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'pt', label: 'Português', flag: '🇵🇹' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
] as const;

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

function getSystemLanguage(): string {
  const locales = getLocales();
  if (locales.length > 0) {
    const code = locales[0].languageCode ?? '';
    if (SUPPORTED_CODES.includes(code as any)) return code;
  }
  return 'en';
}

const resources = {
  zh: { translation: zh },
  en: { translation: en },
  fr: { translation: fr },
  es: { translation: es },
  pt: { translation: pt },
  ar: { translation: ar },
  ja: { translation: ja },
  ko: { translation: ko },
};

i18n.use(initReactI18next).init({
  resources,
  lng: getSystemLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// Load persisted language preference asynchronously
export const i18nReady = AsyncStorage.getItem(LANGUAGE_KEY).then((saved) => {
  if (saved && SUPPORTED_CODES.includes(saved as any)) {
    return i18n.changeLanguage(saved);
  }
});

export async function changeLanguage(lang: string) {
  await i18n.changeLanguage(lang);
  await AsyncStorage.setItem(LANGUAGE_KEY, lang);
}

export default i18n;
