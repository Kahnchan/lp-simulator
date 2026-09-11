import english from "./locales/en.json";

export type Locale = "zh-CN" | "en-US";
export const LANGUAGE_STORAGE_KEY = "lp-simulator:language";
const messages: Record<string, string> = english;
export function resolveLocale(
  saved: string | null,
  browserLanguages: readonly string[],
): Locale {
  if (saved === "zh-CN" || saved === "en-US") return saved;
  return browserLanguages[0]?.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US";
}
const escapePattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.entries(messages)
  .filter(([key]) => /\{\d+\}/.test(key))
  .map(([key, value]) => ({
    pattern: new RegExp(
      "^" +
        key
          .split(/\{\d+\}/)
          .map(escapePattern)
          .join("([\\s\\S]+?)") +
        "$",
    ),
    value,
  }));
const fragments = Object.keys(messages)
  .filter((key) => !/\{\d+\}/.test(key))
  .sort((a, b) => b.length - a.length);
const fragmentPattern = new RegExp(fragments.map(escapePattern).join("|"), "g");

/** Translate application messages at render time so stored errors follow the selected language. */
export function translate(
  locale: Locale,
  key: string,
  ...values: (string | number)[]
): string {
  let text = key;
  if (locale === "en-US") {
    if (key.startsWith("历史读取失败：")) {
      return (
        messages["历史读取失败："] +
        translate(locale, key.slice("历史读取失败：".length))
      );
    }
    text = messages[key] ?? key;
    if (text === key && !values.length) {
      for (const { pattern, value } of patterns) {
        const match = key.match(pattern);
        if (match)
          return value.replace(/\{(\d+)\}/g, (_, index) =>
            translate(locale, match[Number(index) + 1]),
          );
      }
      text = key.replace(fragmentPattern, (part) => messages[part]);
    }
  }
  return text.replace(/\{(\d+)\}/g, (placeholder, index) =>
    values[Number(index)] === undefined
      ? placeholder
      : String(values[Number(index)]),
  );
}
