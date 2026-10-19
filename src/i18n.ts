import { useSyncExternalStore } from "react";

export type LanguageMode = "ko" | "en" | "system";
export type ResolvedLanguage = "ko" | "en";

const STORAGE_KEY = "gajae:language";

/**
 * Korean is the source language and stays at the call site, so a missing English
 * entry falls back to a readable Korean string instead of a raw key.
 * `i18n.test.ts` checks that every `t("...")` call has an entry in the dictionary.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isLanguageMode(value: unknown): value is LanguageMode {
  return value === "ko" || value === "en" || value === "system";
}

export function systemLanguage(
  languages: readonly string[] | undefined =
    typeof navigator === "undefined"
      ? undefined
      : navigator.languages?.length
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : undefined,
): ResolvedLanguage {
  return languages?.some((value) => value.toLowerCase().startsWith("ko"))
    ? "ko"
    : "en";
}

export function resolveLanguage(
  mode: LanguageMode,
  system: ResolvedLanguage = systemLanguage(),
): ResolvedLanguage {
  return mode === "system" ? system : mode;
}

export function readLanguageMode(
  storage: Pick<Storage, "getItem"> | null | undefined = browserStorage(),
): LanguageMode {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isLanguageMode(stored) ? stored : "ko";
  } catch {
    return "ko";
  }
}

export function storeLanguageMode(
  mode: LanguageMode,
  storage: Pick<Storage, "setItem"> | null | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    // A disabled storage must not make the selector unusable.
  }
}

let currentMode: LanguageMode = readLanguageMode();
let currentLanguage: ResolvedLanguage = resolveLanguage(currentMode);
let englishMessages: Readonly<Record<string, string>> | null = null;
let englishLoad: Promise<void> | null = null;

/**
 * Installs an English dictionary that is already in memory.
 *
 * The production app loads that module only after the language resolves to
 * English. Tests install it up front so a language change and the translated
 * string can be asserted in the same turn.
 */
export function installEnglishDictionary(
  messages: Readonly<Record<string, string>>,
): void {
  englishMessages = messages;
  englishLoad = Promise.resolve();
}

/** Drops the cached dictionary so a test can observe the load. */
export function unloadEnglishDictionary(): void {
  englishMessages = null;
  englishLoad = null;
}

/**
 * Loads the English dictionary if this session is going to use it.
 *
 * Korean stays on the source strings, so the dictionary is not part of the
 * initial chunk. When it arrives for a session that is still set to English,
 * listeners render again with the translated copy.
 */
export function ensureEnglishDictionary(): Promise<void> {
  if (englishMessages) return Promise.resolve();
  englishLoad ??= import("./i18n-messages").then((mod) => {
    englishMessages = mod.MESSAGES;
    if (resolveLanguage(currentMode) === "en" && currentLanguage !== "en") {
      currentLanguage = "en";
      applyDocumentLanguage("en");
      for (const listener of listeners) listener();
    }
  });
  return englishLoad;
}

function applyDocumentLanguage(language: ResolvedLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export function getLanguageMode(): LanguageMode {
  return currentMode;
}

export function getLanguage(): ResolvedLanguage {
  return currentLanguage;
}

export function setLanguageMode(mode: LanguageMode): ResolvedLanguage {
  currentMode = mode;
  storeLanguageMode(mode);
  const resolved = resolveLanguage(mode);
  // The preference has to record English immediately. The visible copy stays on
  // the Korean source until the dictionary arrives, then the language snapshot
  // changes and subscribers render the translation.
  if (resolved === "en" && englishMessages === null) {
    void ensureEnglishDictionary();
    for (const listener of listeners) listener();
    return resolved;
  }
  currentLanguage = resolved;
  applyDocumentLanguage(currentLanguage);
  for (const listener of listeners) listener();
  return currentLanguage;
}

export function initializeLanguage(): void {
  currentMode = readLanguageMode();
  currentLanguage = resolveLanguage(currentMode);
  applyDocumentLanguage(currentLanguage);
  if (currentLanguage === "en") void ensureEnglishDictionary();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguageMode(): LanguageMode {
  return useSyncExternalStore(subscribe, getLanguageMode, getLanguageMode);
}

export function useLanguage(): ResolvedLanguage {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

function interpolate(
  template: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function englishTemplate(key: string): string {
  return englishMessages?.[key] ?? key;
}

function translate(key: string, params?: Readonly<Record<string, string | number>>): string {
  const template = currentLanguage === "en" ? englishTemplate(key) : key;
  return interpolate(template, params);
}

/**
 * Translates a Korean source string or a tagged template.
 *
 * Tagged template calls turn their expressions into numbered placeholders, so
 * English can reorder values without duplicating the expressions at the call site.
 */
export function t(
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string;
export function t(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string;
export function t(
  first: string | TemplateStringsArray,
  second?: Readonly<Record<string, string | number>> | unknown,
  ...rest: unknown[]
): string {
  if (typeof first === "string") {
    return translate(first, second as Readonly<Record<string, string | number>> | undefined);
  }
  const values = first.length > 1 ? [second, ...rest] : [];
  const key = first.reduce(
    (result, part, index) =>
      `${result}${part}${index < values.length ? `{${index}}` : ""}`,
    "",
  );
  const params = Object.fromEntries(values.map((value, index) => [String(index), String(value)]));
  const template = currentLanguage === "en" ? englishTemplate(key) : key;
  return template.replace(/\{(\d+)\}/gu, (match, index) => params[index] ?? match);
}

/** Locale for dates, times, and numbers in the current language. */
export function locale(): string {
  return currentLanguage === "ko" ? "ko-KR" : "en-US";
}
