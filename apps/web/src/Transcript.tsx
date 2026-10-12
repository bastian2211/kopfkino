import { useEffect, useRef, useState } from "react";
import { errText, t, type Lang } from "./i18n";
import type { Recording } from "./recorder";
import { SceneBuilder } from "./SceneCard";

type State = { kind: "loading" } | { kind: "done"; text: string } | { kind: "error"; code: string };

async function transcribe(rec: Recording, lang: Lang): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/stt?lang=${lang}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": rec.mimeType },
      body: rec.blob,
    });
  } catch {
    throw new Error("network");
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(res.status === 429 ? "rate_limited" : (data.error ?? "unknown"));
  return data.text ?? "";
}

// Schickt die Aufnahme zur Spracherkennung und zeigt den Text zum Prüfen/Korrigieren an
export function Transcript({ lang, recording }: { lang: Lang; recording: Recording }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const active = useRef(recording.url);

  useEffect(() => {
    active.current = recording.url;
    setState({ kind: "loading" });
    if (!recording.mimeType.includes("wav")) {
      setState({ kind: "error", code: "audio_invalid" });
      return;
    }
    transcribe(recording, lang)
      .then((txt) => {
        if (active.current !== recording.url) return; // inzwischen neue Aufnahme
        setText(txt);
        setState({ kind: "done", text: txt });
      })
      .catch((err: Error) => {
        if (active.current === recording.url) setState({ kind: "error", code: err.message });
      });
    // Sprache absichtlich nicht als Abhängigkeit: Umschalten soll nicht neu (kostenpflichtig) erkennen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.url, attempt]);

  return (
    <div className="playback transcript">
      {state.kind === "loading" && (
        <p className="thinking">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {t(lang, "sttLoading")}
        </p>
      )}
      {state.kind === "error" && (
        <>
          <p className="err">{errText(lang, state.code)}</p>
          {state.code !== "audio_invalid" && state.code !== "budget_exhausted" && (
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              {t(lang, "sttRetry")}
            </button>
          )}
        </>
      )}
      {state.kind === "done" && (
        <>
          <label className="transcript-label" htmlFor="idea">
            {t(lang, "sttYouSaid")}
          </label>
          <textarea id="idea" value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={600} />
          <p className="hint-small">{t(lang, "sttEditHint")}</p>
          {/* Neue Szene, sobald die Idee geändert wird */}
          <SceneBuilder key={text} lang={lang} idea={text} />
        </>
      )}
      <details className="listen">
        <summary>
          {t(lang, "sttListen")} ({recording.seconds.toFixed(1)} s)
        </summary>
        <audio key={recording.url} src={recording.url} controls playsInline preload="metadata" />
      </details>
    </div>
  );
}
