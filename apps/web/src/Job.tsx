import { useEffect, useState } from "react";
import { api, errorCode } from "./api";
import { formatCredits } from "./Credits";
import { errText, t, type Lang, type TextKey } from "./i18n";

export type Job = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  errorCode: string | null;
  title: string | null;
  seconds: number;
  credits: number | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  videoUrl: string | null;
};

// Guthaben-Anzeige oben neu laden lassen (App hört darauf)
export function balanceChanged() {
  window.dispatchEvent(new Event("kk:balance"));
}

const FAIL_TEXT: Record<string, TextKey> = {
  filtered: "jobFailFiltered",
  timeout: "jobFailTimeout",
};

// Zeigt den Stand eines Video-Auftrags und am Ende das Video
export function JobView({ lang, jobId, initial }: { lang: Lang; jobId: string; initial?: Job }) {
  const [job, setJob] = useState<Job | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const j = await api<Job>(`/api/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        setError(null);
        if (j.status === "done" || j.status === "failed") {
          balanceChanged();
          return;
        }
      } catch (err) {
        if (!stop) setError(errText(lang, errorCode(err)));
      }
      if (!stop) timer = window.setTimeout(load, 4000);
    };
    void load();
    // Zurück in die App (z. B. nach Push) → sofort neu laden
    const onVisible = () => document.visibilityState === "visible" && !stop && (clearTimeout(timer), void load());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [jobId, lang]);

  if (!job) return <p className="hint">{error ?? "…"}</p>;

  if (job.status === "queued" || job.status === "running") {
    return (
      <div className="job">
        <p className="scene-badge">🎬 {job.title}</p>
        <div className="clapper" aria-hidden="true">
          🎬
        </div>
        <p className="thinking">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {t(lang, job.status === "queued" ? "jobQueued" : "jobRunning")}
        </p>
        <p className="hint-small">{t(lang, "jobWaitHint")}</p>
        {error && <p className="err">{error}</p>}
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div className="job scene--rejected">
        <p className="scene-badge">😕 {t(lang, "jobFailedTitle")}</p>
        <p>{t(lang, FAIL_TEXT[job.errorCode ?? ""] ?? "jobFailGeneric")}</p>
        <p className="ok">{t(lang, "jobRefunded")}</p>
      </div>
    );
  }

  return (
    <div className="job">
      <p className="scene-badge">🎉 {job.title}</p>
      <div className="player">
        {job.videoUrl && <video src={job.videoUrl} controls playsInline autoPlay muted loop preload="auto" />}
        <span className="ai-label">{t(lang, "aiLabel")}</span>
      </div>
      <p className="hint-small">
        {job.credits !== null && `${formatCredits(job.credits, lang)} Credits · `}
        {t(lang, "jobKeepHint")}
      </p>
    </div>
  );
}

// Liste der eigenen Videos (Konto-Seite)
export function MyVideos({ lang, onOpen }: { lang: Lang; onOpen: (id: string) => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  useEffect(() => {
    api<{ jobs: Job[] }>("/api/jobs")
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, []);
  if (!jobs) return null;
  const icon = { queued: "⏳", running: "⏳", done: "🎬", failed: "😕" } as const;
  const date = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "2-digit" });
  return (
    <section className="card">
      <h2>{t(lang, "myVideos")}</h2>
      {jobs.length === 0 ? (
        <p className="hint-small">{t(lang, "myVideosEmpty")}</p>
      ) : (
        <ul className="ledger">
          {jobs.map((j) => (
            <li key={j.id}>
              <button className="linkrow" onClick={() => onOpen(j.id)}>
                <span>
                  {icon[j.status]} <strong>{j.title}</strong>
                </span>
                <span className="ledger-date">{date.format(new Date(j.createdAt))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint-small">{t(lang, "myVideosExpire")}</p>
    </section>
  );
}
