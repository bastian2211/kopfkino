export type Lang = "de" | "en";

const texts = {
  de: {
    claim: "Gedacht. Eingesprochen. Gelacht.",
    micHint: "Tippen und Idee einsprechen",
    micRecording: "Ich höre zu … nochmal tippen zum Stoppen",
    micStarting: "Mikrofon wird geöffnet …",
    micDone: "Aufnahme",
    micDenied: "Mikrofon nicht erlaubt. Einstellungen → Safari → Mikrofon → Erlauben.",
    micUnsupported: "Dieses Gerät kann im Browser nicht aufnehmen.",
    micNoDevice: "Kein Mikrofon gefunden.",
    micEmpty: "Die Aufnahme war leer. Bitte nochmal versuchen.",
    micUnknown: "Aufnahme fehlgeschlagen. Bitte nochmal versuchen.",
    serverOk: "Server verbunden",
    serverDown: "Server nicht erreichbar",
    serverChecking: "Verbinde …",
    installHint: "Teilen-Symbol → „Zum Home-Bildschirm“",
    rotate: "Bitte iPhone hochkant halten",
    labLink: "Technik-Test",
    labTitle: "Technik-Test",
    back: "Zurück",
    error: "Fehler",
    camTitle: "1 · Frontkamera",
    camStart: "Kamera starten",
    camShoot: "Foto machen",
    camAgain: "Nochmal",
    camOk: "Kamera funktioniert",
    camDenied: "Kamera nicht erlaubt. Einstellungen → Safari → Kamera → Erlauben.",
    shareTitle: "2 · Video teilen / sichern",
    shareBtn: "Teilen …",
    shareDownload: "Video herunterladen",
    shareHint: "Im Teilen-Menü „Video sichern“ wählen – dann muss es in Fotos auftauchen.",
    shareOk: "Teilen-Menü wurde benutzt",
    shareAborted: "Abgebrochen",
    shareLoadFail: "Test-Video konnte nicht geladen werden",
    infoTitle: "3 · Geräteinfo",
    infoStandalone: "Als App installiert",
    infoFormat: "Aufnahmeformat",
  },
  en: {
    claim: "Thought. Spoken. Laughed.",
    micHint: "Tap and say your idea",
    micRecording: "Listening … tap again to stop",
    micStarting: "Opening microphone …",
    micDone: "Recording",
    micDenied: "Microphone blocked. Settings → Safari → Microphone → Allow.",
    micUnsupported: "This device can't record in the browser.",
    micNoDevice: "No microphone found.",
    micEmpty: "The recording was empty. Please try again.",
    micUnknown: "Recording failed. Please try again.",
    serverOk: "Server connected",
    serverDown: "Server unreachable",
    serverChecking: "Connecting …",
    installHint: "Share icon → “Add to Home Screen”",
    rotate: "Please hold your iPhone upright",
    labLink: "Tech test",
    labTitle: "Tech test",
    back: "Back",
    error: "Error",
    camTitle: "1 · Front camera",
    camStart: "Start camera",
    camShoot: "Take photo",
    camAgain: "Again",
    camOk: "Camera works",
    camDenied: "Camera blocked. Settings → Safari → Camera → Allow.",
    shareTitle: "2 · Share / save video",
    shareBtn: "Share …",
    shareDownload: "Download video",
    shareHint: "Choose “Save Video” in the share sheet – it should appear in Photos.",
    shareOk: "Share sheet was used",
    shareAborted: "Cancelled",
    shareLoadFail: "Test video could not be loaded",
    infoTitle: "3 · Device info",
    infoStandalone: "Installed as app",
    infoFormat: "Recording format",
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
