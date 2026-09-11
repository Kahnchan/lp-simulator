import { useSyncExternalStore } from "react";
import {
  LANGUAGE_STORAGE_KEY,
  resolveLocale,
  translate,
  type Locale,
} from "./i18n";
let saved: string | null = null;
try {
  saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
} catch {
  /* Language still works without storage. */
}
let locale = resolveLocale(
  saved,
  typeof navigator === "undefined" ? ["zh-CN"] : navigator.languages,
);
const listeners = new Set<() => void>();
export const getLocale = () => locale;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setLocale(next: Locale) {
  if (next === locale) return;
  locale = next;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    /* Keep the session preference. */
  }
  listeners.forEach((listener) => listener());
}
const translators = {
  "zh-CN": (key: string, ...values: (string | number)[]) =>
    translate("zh-CN", key, ...values),
  "en-US": (key: string, ...values: (string | number)[]) =>
    translate("en-US", key, ...values),
};
export function useI18n() {
  const current = useSyncExternalStore(subscribe, getLocale, getLocale);
  return { locale: current, t: translators[current], setLocale };
}
