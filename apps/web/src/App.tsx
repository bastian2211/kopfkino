import { useEffect, useState } from "react";
import { initialLang, saveLang, t, type Lang } from "./i18n";

type ServerState = "checking" | "ok" | "down";

function isStandalone(): boolean {
  // iOS meldet installierte Web-Apps über navigator.standalone, andere über display-mode.
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [server, setServer] = useState<ServerState>("checking");
  const [version, setVersion] = useState<string>("");
  const [tapped, setTapped] = useState(false);
  const standalone = isStandalone();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { version?: string };
        if (cancelled) return;
        setServer(res.ok ? "ok" : "down");
        setVersion(body.version ?? "");
      })
      .catch(() => !cancelled && setServer("down"));
    return () => {
      cancelled = true;
    };
  }, []);

  const switchLang = () => {
    const next: Lang = lang === "de" ? "en" : "de";
    setLang(next);
    saveLang(next);
    document.documentElement.lang = next;
  };

  const serverText =
    server === "ok" ? t(lang, "serverOk") : server === "down" ? t(lang, "serverDown") : t(lang, "serverChecking");

  return (
    <main className="screen">
      <header className="topbar">
        <span className="logo">Kopfkino</span>
        <button className="lang" onClick={switchLang} aria-label="Sprache wechseln / switch language">
          {lang === "de" ? "EN" : "DE"}
        </button>
      </header>

      <section className="center">
        <p className="claim">{t(lang, "claim")}</p>
        <button
          className={`mic ${tapped ? "mic--tapped" : ""}`}
          onClick={() => setTapped(true)}
          aria-label={t(lang, "micHint")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
          </svg>
        </button>
        <p className="hint">{tapped ? t(lang, "micSoon") : t(lang, "micHint")}</p>
      </section>

      <footer className="footer">
        <span className={`dot dot--${server}`} /> {serverText}
        {version && <span className="version"> · {version}</span>}
        {!standalone && <p className="install">{t(lang, "installHint")}</p>}
      </footer>

      <div className="rotate" role="alert">
        {t(lang, "rotate")}
      </div>
    </main>
  );
}
