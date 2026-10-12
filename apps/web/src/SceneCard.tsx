import { useState } from "react";
import { api, errorCode } from "./api";
import { formatCredits } from "./Credits";
import { errText, t, type Lang } from "./i18n";

type SceneOk = {
  id: string;
  status: "ok";
  scene: {
    title: string;
    summary: string;
    characters: { name: string; description: string }[];
    setting: string;
    mood: string;
    beats: string[];
    note: string;
  };
  estimate: { credits: number; seconds: number };
  balance: number;
  budgetOk: boolean;
};

type SceneRejected = {
  id: string;
  status: "rejected";
  source: "moderation" | "interpreter";
  reason?: string;
};

export type SceneResponse = SceneOk | SceneRejected;

type State = { kind: "idle" } | { kind: "loading" } | { kind: "error"; code: string } | { kind: "done"; data: SceneResponse };

// Knopf „Szene bauen“ + Ergebnis-Karte. Wird zurückgesetzt, sobald sich die Idee ändert (key im Aufrufer).
export function SceneBuilder({ lang, idea }: { lang: Lang; idea: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const build = async () => {
    setState({ kind: "loading" });
    try {
      const data = await api<SceneResponse>("/api/scenes", { body: { idea, lang } });
      setState({ kind: "done", data });
    } catch (err) {
      setState({ kind: "error", code: errorCode(err) });
    }
  };

  if (state.kind === "idle" || state.kind === "error") {
    return (
      <>
        {state.kind === "error" && <p className="err">{errText(lang, state.code)}</p>}
        <button className="btn btn--coral" onClick={build} disabled={idea.trim().length < 3}>
          🎬 {t(lang, "sceneBuild")}
        </button>
      </>
    );
  }

  if (state.kind === "loading") {
    return (
      <p className="thinking">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {t(lang, "sceneLoading")}
      </p>
    );
  }

  const d = state.data;
  if (d.status === "rejected") {
    return (
      <div className="scene scene--rejected">
        <p className="scene-badge">🚫 {t(lang, "sceneRejectedTitle")}</p>
        <p>{d.source === "interpreter" && d.reason ? d.reason : t(lang, "sceneRejectedModeration")}</p>
        <button className="btn" onClick={() => setState({ kind: "idle" })}>
          {t(lang, "sceneTryAgain")}
        </button>
      </div>
    );
  }

  const s = d.scene;
  const enough = d.balance >= d.estimate.credits;
  return (
    <div className="scene">
      <p className="scene-badge">🎬 {t(lang, "sceneReady")}</p>
      <h2 className="scene-title">{s.title}</h2>
      <p>{s.summary}</p>
      <div className="scene-chips">
        {s.characters.map((c) => (
          <span key={c.name} className="chip-text" title={c.description}>
            <b>{c.name}</b> · {c.description}
          </span>
        ))}
      </div>
      <p className="meta">
        📍 {s.setting} · 🎭 {s.mood}
      </p>
      <ol className="beats">
        {s.beats.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ol>
      {s.note && <p className="scene-note">ℹ️ {s.note}</p>}

      <div className="estimate">
        <div>
          <span>
            {t(lang, "sceneVideo")} ({d.estimate.seconds} s)
          </span>
          <b>{formatCredits(d.estimate.credits, lang)} Credits</b>
        </div>
        <div>
          <span>{t(lang, "sceneBalance")}</span>
          <b>{formatCredits(d.balance, lang)} Credits</b>
        </div>
      </div>
      {!enough && <p className="err">{t(lang, "sceneNotEnough")}</p>}
      {!d.budgetOk && <p className="err">{errText(lang, "budget_exhausted")}</p>}
      <button className="btn btn--coral" disabled>
        {t(lang, "sceneGenerateSoon")}
      </button>
      <p className="hint-small">{t(lang, "sceneCostHint")}</p>
    </div>
  );
}
