import {createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import es from './locales/es.json';
import en from './locales/en.json';

export type Language = 'es' | 'en';
type MessageKey = keyof typeof es;
type Messages = Record<MessageKey, string>;
type Values = Record<string, string | number>;
export type TranslationValues = Values;

const messages: Record<Language, Messages> = {es, en};
const LanguageContext = createContext<{
  lang: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, values?: Values) => string;
  formatLocale: string;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatPrice: (cop: number) => string;
} | null>(null);

const COP_PER_USD_APPROX = 3316.7; // TRM certified for 2026-11-14; display remains explicitly approximate.

function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem('lang') ?? localStorage.getItem('aiverse-language');
    if (stored === 'es' || stored === 'en') return stored;
  } catch {}
  const preferences = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const preference of preferences) {
    const base = preference.toLowerCase().split('-')[0];
    if (base === 'es' || base === 'en') return base;
  }
  return 'es';
}

function getFormatLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale.includes('-') ? locale : locale.toLowerCase().startsWith('es') ? 'es-CO' : 'en-US';
  } catch {
    return 'es-CO';
  }
}

function interpolate(message: string, values?: Values): string {
  if (!values) return message;
  return message.replace(/\{\{([^}]+)}}/g, (placeholder, name: string) => String(values[name.trim()] ?? placeholder));
}

export function I18nProvider({children}: {children: ReactNode}) {
  const [lang, setLang] = useState<Language>(detectLanguage);
  const activeLanguage = useRef(lang);
  const formatLocale = useMemo(getFormatLocale, []);

  const setLanguage = useCallback((language: Language) => {
    activeLanguage.current = language;
    setLang(language);
    try {
      localStorage.setItem('lang', language);
      localStorage.removeItem('aiverse-language');
    } catch {}
  }, []);

  const t = useCallback((key: MessageKey, values?: Values) => interpolate(messages[activeLanguage.current][key] ?? messages.es[key] ?? key, values), []);

  const formatDate = useCallback((value: Date | string | number, options?: Intl.DateTimeFormatOptions) => {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(formatLocale, options).format(date);
  }, [formatLocale]);

  const formatNumber = useCallback((value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(formatLocale, options).format(value), [formatLocale]);

  const formatPrice = useCallback((cop: number) => {
    const region = (() => {
      try { return new Intl.Locale(formatLocale).region ?? ''; }
      catch { return ''; }
    })();
    if (region === 'CO') {
      return new Intl.NumberFormat(formatLocale, {style: 'currency', currency: 'COP', maximumFractionDigits: 0}).format(cop);
    }
    const usd = cop / COP_PER_USD_APPROX;
    const amount = new Intl.NumberFormat(formatLocale, {style: 'currency', currency: 'USD', maximumFractionDigits: 2}).format(usd);
  return `≈ ${amount}`;
  }, [formatLocale, lang]);

  useLayoutEffect(() => {
    document.documentElement.lang = lang;
    const openGraphLocale = document.querySelector<HTMLMetaElement>('meta[property="og:locale"]');
    if (openGraphLocale) openGraphLocale.content = lang === 'es' ? 'es_CO' : 'en_US';
  }, [lang]);

  const value = useMemo(() => ({lang, setLanguage, t, formatLocale, formatDate, formatNumber, formatPrice}), [lang, setLanguage, t, formatLocale, formatDate, formatNumber, formatPrice]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

export type {MessageKey};
