import { useEffect, useState } from "react";
import { initialLang, saveLang, t, type Lang, type TextKey } from "./i18n";
import { loadEngine, MAX_SECONDS, saveEngine, useRecorder, type Engine, type RecorderError } from "./recorder";
import { Lab } from "./Lab";
import { Transcript } from "./Transcript";
import { JobView } from "./Job";
import { Account, Login, Register } from "./Auth";
import { api, type Me } from "./api";
import { formatCredits, useBalance } from "./Credits";

function readInviteCode(): string | null {
  return new URLSearchParams(window.location.search).get("invite");
}

type ServerState = "checking" | "ok" | "down";

function isStandalone(): boolean {
  // iOS meldet installierte Web-Apps über navigator.standalone, andere über display-mode.
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

const ERROR_TEXT: Record<RecorderError, TextKey> = {
  unsupported: "micUnsupported",
  denied: "micDenied",
  nodevice: "micNoDevice",
  empty: "micEmpty",
  unknown: "micUnknown",
};

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [server, setServer] = useState<ServerState>("checking");
  const [version, setVersion] = useState<string>("");
  const [view, setView] = useState<"home" | "lab" | "account">("home");
  // undefined = wird geladen, null = nicht angemeldet
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [invite, setInvite] = useState<string | null>(readInviteCode);
  // Video aus Push-Nachricht oder Liste öffnen (?job=…)
  const [openJob, setOpenJob] = useState<string | null>(() => new URLSearchParams(window.location.search).get("job"));

  const loadMe = () =>
    api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));

  useEffect(() => {
    void loadMe();
  }, []);

  const credits = useBalance(!!me);
  useEffect(() => {
    const reload = () => credits.reload();
    window.addEventListener("kk:balance", reload);
    return () => window.removeEventListener("kk:balance", reload);
  }, [credits]);

  const afterAuth = () => {
    // Einladungscode aus der Adresse entfernen, damit er nicht im Verlauf bleibt
    if (invite) window.history.replaceState(null, "", "/");
    setInvite(null);
    setView("home");
    void loadMe();
  };
  const [engine, setEngineState] = useState<Engine>(loadEngine);
  const setEngine = (e: Engine) => {
    setEngineState(e);
    saveEngine(e);
  };
  const rec = useRecorder(engine);
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

  const onMic = () => {
    if (rec.state === "recording") rec.stop();
    else if (rec.state === "idle") void rec.start();
  };

  const serverText =
    server === "ok" ? t(lang, "serverOk") : server === "down" ? t(lang, "serverDown") : t(lang, "serverChecking");

  const recording = rec.state === "recording";
  const remaining = Math.max(0, Math.ceil(MAX_SECONDS - rec.elapsed));
  const hint =
    rec.state === "starting"
      ? t(lang, "micStarting")
      : recording
        ? t(lang, "micRecording")
        : t(lang, "micHint");

  return (
    <main className="screen">
      <header className="topbar">
        <span className="logo">Kopfkino</span>
        {me && view === "home" && (
          <button className="lang avatar" onClick={() => setView("account")} aria-label={t(lang, "account")}>
            {me.displayName.slice(0, 1).toUpperCase()}
          </button>
        )}
        <button className="lang" onClick={switchLang} aria-label="Sprache wechseln / switch language">
          {lang === "de" ? "EN" : "DE"}
        </button>
      </header>

      {invite && !me ? (
        <Register lang={lang} code={invite} onDone={afterAuth} />
      ) : me === undefined ? (
        <p className="hint center">…</p>
      ) : me === null ? (
        <Login lang={lang} onDone={afterAuth} />
      ) : view === "account" ? (
        <Account
          lang={lang}
          me={me}
          onBack={() => {
            credits.reload();
            setView("home");
          }}
          onBalanceChange={credits.reload}
          onOpenJob={(id) => {
            setOpenJob(id);
            setView("home");
          }}
          onLogout={() => {
            setMe(null);
            setView("home");
          }}
        />
      ) : view === "lab" ? (
        <Lab lang={lang} engine={engine} onEngine={setEngine} onBack={() => setView("home")} />
      ) : (
        <section className="center">
          {openJob && (
            <div className="playback transcript">
              <button
                className="back"
                onClick={() => {
                  setOpenJob(null);
                  window.history.replaceState(null, "", "/");
                }}
              >
                × {t(lang, "close")}
              </button>
              <JobView lang={lang} jobId={openJob} key={openJob} />
            </div>
          )}
          <p className="claim">{t(lang, "claim")}</p>
          {credits.balance !== null && (
            <button className="creditpill" onClick={() => setView("account")}>
              🎟 {formatCredits(credits.balance, lang)} Credits
            </button>
          )}
          <button
            className={`mic ${recording ? "mic--rec" : ""}`}
            onClick={onMic}
            disabled={rec.state === "starting" || rec.state === "stopping"}
            aria-label={hint}
          >
            {recording ? (
              <span className="countdown">{remaining}</span>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
              </svg>
            )}
          </button>
          <p className="hint">{hint}</p>
          {rec.error && <p className="err">{t(lang, ERROR_TEXT[rec.error])}</p>}

          {rec.recording && !recording && <Transcript lang={lang} recording={rec.recording} />}
        </section>
      )}

      <footer className="footer">
        <span className={`dot dot--${server}`} /> {serverText}
        <span className="version">
          {" · "}App {__APP_VERSION__.replace("sha-", "")}
          {version && version !== __APP_VERSION__ ? ` · Server ${version.replace("sha-", "")}` : ""}
        </span>
        {me && view === "home" && (
          <>
            {" · "}
            <button className="linkbtn" onClick={() => setView("lab")}>
              {t(lang, "labLink")}
            </button>
          </>
        )}
        {!standalone && <p className="install">{t(lang, "installHint")}</p>}
      </footer>

      <div className="rotate" role="alert">
        {t(lang, "rotate")}
      </div>
    </main>
  );
}
