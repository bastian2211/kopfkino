// Video-Worker: läuft im API-Prozess, arbeitet die Aufträge aus der Datenbank ab.
// Der Stand liegt komplett in der DB – nach einem Neustart geht es nahtlos weiter.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { VideoProvider } from "./adapters/video.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { release, settle, usdToEur } from "./ledger.js";

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
type Notify = (userId: string, payload: { title: string; body: string; url?: string }) => Promise<unknown>;

const TIMEOUT_MIN = 15; // Doku: bis zu 6 Minuten zu Stoßzeiten – großzügiger Puffer

export function videoCostEur(config: Config): number {
  return usdToEur(config.VIDEO_USD_PER_SEC * config.VIDEO_SECONDS, config);
}

export function createVideoWorker(opts: {
  db: Db;
  config: Config;
  provider: VideoProvider;
  log: Log;
  notify?: Notify;
  intervalMs?: number;
}) {
  const { db, config, provider, log } = opts;
  const notify: Notify = opts.notify ?? (async () => undefined);
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const fail = async (
    job: { id: string; user_id: string; reservation_id: string },
    code: string,
    detail: string,
    actualEur = 0,
  ) => {
    // Erst Guthaben zurück, dann Status – release() ist wiederholbar, falls wir dazwischen abstürzen
    await release(db, job.reservation_id, actualEur);
    await db.query(
      `update video_jobs set status = 'failed', error_code = $2, error_detail = $3, cost_eur = $4, finished_at = now()
        where id = $1 and status in ('queued', 'running')`,
      [job.id, code, detail.slice(0, 500), actualEur],
    );
    log.warn({ jobId: job.id, code, detail: detail.slice(0, 200) }, "Video fehlgeschlagen – Credits erstattet");
    await notify(job.user_id, {
      title: "Kopfkino",
      body: "Dein Video hat leider nicht geklappt. Deine Credits sind wieder da.",
      url: `/?job=${job.id}`,
    }).catch(() => undefined);
  };

  type JobRow = {
    id: string;
    user_id: string;
    reservation_id: string;
    operation: string | null;
    started_at: Date | null;
    video_prompt: string | null;
  };

  async function pollRunning() {
    const { rows } = await db.query<JobRow>(
      `select j.id, j.user_id, j.reservation_id, j.operation, j.started_at, s.scene->>'video_prompt' as video_prompt
         from video_jobs j join scenes s on s.id = j.scene_id
        where j.status = 'running' order by j.started_at limit 20`,
    );
    for (const job of rows) {
      const ageMin = job.started_at ? (Date.now() - job.started_at.getTime()) / 60000 : 0;
      if (!job.operation) {
        // Start ist abgebrochen (z. B. Neustart zwischen Übernahme und Start)
        if (ageMin > 2) await fail(job, "start_failed", "keine Operation gespeichert");
        continue;
      }
      let result;
      try {
        result = await provider.poll(job.operation);
      } catch (err) {
        log.warn({ jobId: job.id, err: (err as Error).message }, "Statusabfrage fehlgeschlagen");
        if (ageMin > TIMEOUT_MIN) await fail(job, "timeout", (err as Error).message);
        continue;
      }
      if (result.state === "running") {
        if (ageMin > TIMEOUT_MIN) await fail(job, "timeout", `länger als ${TIMEOUT_MIN} Minuten`);
        continue;
      }
      if (result.state === "failed") {
        // Laut Doku werden blockierte Videos nicht berechnet
        await fail(job, result.code, result.detail);
        continue;
      }
      const fileName = `${job.id}.mp4`;
      const cost = provider.name === "fake" ? 0 : videoCostEur(config);
      let bytes: number;
      try {
        await mkdir(config.VIDEO_DIR, { recursive: true });
        bytes = await provider.download(result.videoUri, path.join(config.VIDEO_DIR, fileName));
      } catch (err) {
        // Das Video wurde erzeugt (kostet uns), aber nicht geladen: Nutzer bekommt alles zurück
        await fail(job, "download_failed", (err as Error).message, cost);
        continue;
      }
      const { charged } = await settle(db, job.reservation_id, cost);
      await db.query(
        `update video_jobs set status = 'done', file_name = $2, file_bytes = $3, cost_eur = $4,
                finished_at = now(), expires_at = now() + interval '30 days'
          where id = $1 and status = 'running'`,
        [job.id, fileName, bytes, cost],
      );
      log.info({ jobId: job.id, bytes, costEur: cost, charged }, "Video fertig");
      await notify(job.user_id, {
        title: "Kopfkino 🎬",
        body: "Dein Video ist fertig!",
        url: `/?job=${job.id}`,
      }).catch(() => undefined);
    }
  }

  async function startQueued() {
    const { rows: cnt } = await db.query<{ n: string }>("select count(*) as n from video_jobs where status = 'running'");
    const slots = config.VIDEO_MAX_PARALLEL - Number(cnt[0]?.n ?? 0);
    if (slots <= 0) return;
    // Aufträge übernehmen – SKIP LOCKED, damit nie zwei Worker denselben starten
    const { rows } = await db.query<JobRow>(
      `update video_jobs j set status = 'running', started_at = now()
         from scenes s
        where s.id = j.scene_id and j.id in (
          select id from video_jobs where status = 'queued' order by created_at limit $1 for update skip locked)
        returning j.id, j.user_id, j.reservation_id, j.operation, j.started_at, s.scene->>'video_prompt' as video_prompt`,
      [slots],
    );
    for (const job of rows) {
      try {
        if (!job.video_prompt) throw new Error("Szene ohne Videoprompt");
        const { operation } = await provider.start(job.video_prompt, { seconds: config.VIDEO_SECONDS });
        await db.query("update video_jobs set operation = $2 where id = $1", [job.id, operation]);
        log.info({ jobId: job.id }, "Video gestartet");
      } catch (err) {
        await fail(job, "start_failed", (err as Error).message);
      }
    }
  }

  async function tick() {
    if (running) return running;
    running = (async () => {
      try {
        await pollRunning();
        await startQueued();
      } catch (err) {
        log.error({ err: (err as Error).message }, "Video-Worker-Fehler");
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    tick,
    start() {
      if (!timer) timer = setInterval(() => void tick(), opts.intervalMs ?? 5000);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}

export type VideoWorker = ReturnType<typeof createVideoWorker>;
