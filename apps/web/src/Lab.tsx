import { useEffect, useRef, useState } from "react";
import { pickMimeType, type Engine } from "./recorder";
import { errText, t, type Lang } from "./i18n";
import { api, errorCode } from "./api";

const TEST_VIDEO = "/test/kopfkino-test.mp4";

function Camera({ lang }: { lang: Lang }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setLive(false);
  };

  useEffect(() => stopCamera, []);

  const startCamera = async () => {
    setError(null);
    setPhoto(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setLive(true);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : String(err);
      setError(name === "NotAllowedError" ? t(lang, "camDenied") : `${t(lang, "error")}: ${name}`);
      stopCamera();
    }
  };

  const takePhoto = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Spiegeln wie in der Vorschau, damit das Selfie natürlich aussieht
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0);
    setPhoto(canvas.toDataURL("image/jpeg", 0.85));
    stopCamera();
  };

  return (
    <section className="card">
      <h2>{t(lang, "camTitle")}</h2>
      <div className="cam">
        <video ref={videoRef} playsInline muted className={live ? "" : "hidden"} />
        {photo && <img src={photo} alt="Selfie" />}
        {!live && !photo && <div className="cam-empty">📷</div>}
      </div>
      {!live ? (
        <button className="btn" onClick={startCamera}>
          {photo ? t(lang, "camAgain") : t(lang, "camStart")}
        </button>
      ) : (
        <button className="btn btn--coral" onClick={takePhoto}>
          {t(lang, "camShoot")}
        </button>
      )}
      {photo && <p className="ok">✓ {t(lang, "camOk")}</p>}
      {error && <p className="err">{error}</p>}
    </section>
  );
}

function Share({ lang }: { lang: Lang }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Datei VORHER laden: iOS erlaubt navigator.share nur direkt nach dem Tipp,
  // ein Download dazwischen würde die Erlaubnis kosten.
  useEffect(() => {
    fetch(TEST_VIDEO)
      .then((r) => r.blob())
      .then((b) => setFile(new File([b], "kopfkino-test.mp4", { type: "video/mp4" })))
      .catch(() => setResult(t(lang, "shareLoadFail")));
  }, [lang]);

  const canShareFile = !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: "Kopfkino" });
      setResult(`✓ ${t(lang, "shareOk")}`);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : String(err);
      setResult(name === "AbortError" ? t(lang, "shareAborted") : `${t(lang, "error")}: ${name}`);
    }
  };

  return (
    <section className="card">
      <h2>{t(lang, "shareTitle")}</h2>
      <video className="testvideo" src={TEST_VIDEO} controls playsInline preload="metadata" />
      {canShareFile ? (
        <button className="btn" onClick={share}>
          {t(lang, "shareBtn")}
        </button>
      ) : (
        <a className="btn" href={TEST_VIDEO} download>
          {t(lang, "shareDownload")}
        </a>
      )}
      <p className="hint-small">{t(lang, "shareHint")}</p>
      {result && <p className={result.startsWith("✓") ? "ok" : "err"}>{result}</p>}
    </section>
  );
}

function DeviceInfo({ lang }: { lang: Lang }) {
  const nav = navigator as Navigator & { standalone?: boolean };
  const yes = (b: boolean) => (b ? "✓" : "✗");
  const rows: [string, string][] = [
    [t(lang, "infoStandalone"), yes(nav.standalone === true || matchMedia("(display-mode: standalone)").matches)],
    ["MediaRecorder", yes(typeof MediaRecorder !== "undefined")],
    [t(lang, "infoFormat"), pickMimeType() ?? "—"],
    ["getUserMedia", yes(!!navigator.mediaDevices?.getUserMedia)],
    ["Web Share (Dateien)", yes(typeof navigator.canShare === "function")],
    ["Push", yes("PushManager" in window && "serviceWorker" in navigator)],
    ["Notification", typeof Notification !== "undefined" ? Notification.permission : "—"],
  ];
  return (
    <section className="card">
      <h2>{t(lang, "infoTitle")}</h2>
      <table className="info">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ua">{navigator.userAgent}</p>
    </section>
  );
}

function EnginePicker({ lang, engine, onEngine }: { lang: Lang; engine: Engine; onEngine: (e: Engine) => void }) {
  return (
    <section className="card">
      <h2>{t(lang, "engineTitle")}</h2>
      <div className="segmented" role="radiogroup">
        <button
          role="radio"
          aria-checked={engine === "mediarecorder"}
          className={engine === "mediarecorder" ? "on" : ""}
          onClick={() => onEngine("mediarecorder")}
        >
          MediaRecorder
        </button>
        <button role="radio" aria-checked={engine === "wav"} className={engine === "wav" ? "on" : ""} onClick={() => onEngine("wav")}>
          WAV
        </button>
      </div>
      <p className="hint-small">{t(lang, "engineHint")}</p>
    </section>
  );
}


function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Push-Test: Erlaubnis holen, Gerät beim Server anmelden, Testnachricht anfordern
function Push({ lang }: { lang: Lang }) {
  const supported = "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub && Notification.permission === "granted"));
  }, [supported]);

  const say = (text: string, error = false) => {
    setStatus(text);
    setIsError(error);
  };

  const enable = async () => {
    setBusy(true);
    say("");
    try {
      // Erlaubnis MUSS direkt aus dem Tippen heraus angefragt werden (iOS)
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        say(t(lang, "pushDenied"), true);
        return;
      }
      const key = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/key");
      if (!key.enabled || !key.publicKey) {
        say(errText(lang, "push_disabled"), true);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key.publicKey),
        }));
      await api("/api/push/subscribe", { body: sub.toJSON() });
      setSubscribed(true);
      say(t(lang, "pushOn"));
    } catch (err) {
      const code = errorCode(err);
      say(code === "unknown" ? `${t(lang, "error")}: ${err instanceof Error ? err.message : String(err)}` : errText(lang, code), true);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await api("/api/push/test", { body: { delay: 5 } });
      say(t(lang, "pushSent"));
    } catch (err) {
      say(errText(lang, errorCode(err)), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>{t(lang, "pushTitle")}</h2>
      {!supported ? (
        <p className="err">{t(lang, "pushNeedsInstall")}</p>
      ) : (
        <>
          <p className="hint">{t(lang, "pushHint")}</p>
          {!subscribed ? (
            <button className="btn btn--coral" onClick={enable} disabled={busy}>
              {busy ? "…" : t(lang, "pushEnable")}
            </button>
          ) : (
            <button className="btn btn--coral" onClick={test} disabled={busy}>
              {busy ? "…" : t(lang, "pushTest")}
            </button>
          )}
        </>
      )}
      {status && <p className={isError ? "err" : "ok"}>{status}</p>}
    </section>
  );
}

export function Lab({
  lang,
  engine,
  onEngine,
  onBack,
}: {
  lang: Lang;
  engine: Engine;
  onEngine: (e: Engine) => void;
  onBack: () => void;
}) {
  return (
    <div className="lab">
      <button className="back" onClick={onBack}>
        ← {t(lang, "back")}
      </button>
      <h1>{t(lang, "labTitle")}</h1>
      <EnginePicker lang={lang} engine={engine} onEngine={onEngine} />
      <Camera lang={lang} />
      <Share lang={lang} />
      <DeviceInfo lang={lang} />
      <Push lang={lang} />
    </div>
  );
}
