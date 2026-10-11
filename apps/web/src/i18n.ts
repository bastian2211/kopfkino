export type Lang = "de" | "en";

const texts = {
  de: {
    claim: "Gedacht. Eingesprochen. Gelacht.",
    micHint: "Tippen und Idee einsprechen",
    micSoon: "Aufnahme kommt im nächsten Schritt",
    serverOk: "Server verbunden",
    serverDown: "Server nicht erreichbar",
    serverChecking: "Verbinde …",
    installHint: "Teilen-Symbol → „Zum Home-Bildschirm“",
    rotate: "Bitte iPhone hochkant halten",
  },
  en: {
    claim: "Thought. Spoken. Laughed.",
    micHint: "Tap and say your idea",
    micSoon: "Recording arrives in the next step",
    serverOk: "Server connected",
    serverDown: "Server unreachable",
    serverChecking: "Connecting …",
    installHint: "Share icon → “Add to Home Screen”",
    rotate: "Please hold your iPhone upright",
  },
} as const;

export type TextKey = keyof (typeof texts)["de"];

export function t(lang: Lang, key: TextKey): string {
  return texts[lang][key];
}

const STORAGE_KEY = "kopfkino.lang";

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "de" || saved === "en") return saved;
  } catch {
    /* Speicher nicht verfügbar – Standard nehmen */
  }
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* egal */
  }
}
