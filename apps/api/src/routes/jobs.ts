import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { VideoProvider } from "../adapters/video.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { creditsForEur, LedgerError, release, reserve } from "../ledger.js";
import { videoCostEur, type VideoWorker } from "../video-worker.js";

type JobRow = {
  id: string;
  status: string;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
  seconds: number;
  title: string | null;
  credits: number | null;
  file_name: string | null;
};

const JOB_SELECT = `
  select j.id, j.status, j.error_code, j.created_at, j.finished_at, j.expires_at, j.seconds, j.file_name,
         s.scene->>'title' as title,
         coalesce(r.charged_credits, r.credits) as credits
    from video_jobs j
    join scenes s on s.id = j.scene_id
    join reservations r on r.id = j.reservation_id`;

function view(j: JobRow) {
  return {
    id: j.id,
    status: j.status,
    errorCode: j.error_code,
    title: j.title,
    seconds: j.seconds,
    credits: j.status === "failed" ? 0 : j.credits,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    expiresAt: j.expires_at,
    videoUrl: j.status === "done" && j.file_name ? `/api/videos/${j.id}.mp4` : null,
  };
}

export function jobRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  provider: VideoProvider | null,
  worker: VideoWorker | null,
) {
  // Video aus einer freigegebenen Szene erzeugen
  app.post(
    "/api/jobs",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes", keyGenerator: (req) => req.user?.id ?? req.ip } } },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
      if (!provider || !worker) return reply.code(503).send({ error: "video_disabled" });
      const b = z.object({ sceneId: z.string().uuid(), key: z.string().uuid() }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: "invalid" });
      const userId = req.user.id;

      // Wiederholung mit gleichem Schlüssel (z. B. doppelt getippt) → derselbe Auftrag
      const existing = await db.query<JobRow>(`${JOB_SELECT} where j.user_id = $1 and j.client_key = $2`, [userId, b.data.key]);
      if (existing.rows[0]) return view(existing.rows[0]);

      const scene = await db.query<{ status: string; title: string; fresh: boolean }>(
        `select status, scene->>'title' as title, created_at > now() - interval '30 days' as fresh
           from scenes where id = $1 and user_id = $2`,
        [b.data.sceneId, userId],
      );
      const s = scene.rows[0];
      if (!s) return reply.code(404).send({ error: "not_found" });
      if (s.status !== "ok" || !s.fresh) return reply.code(409).send({ error: "scene_not_ok" });

      // Pro Nutzer immer nur ein Video gleichzeitig
      const busy = await db.query("select 1 from video_jobs where user_id = $1 and status in ('queued', 'running')", [userId]);
      if (busy.rowCount) return reply.code(409).send({ error: "job_running" });

      let reservationId: string;
      try {
        ({ reservationId } = await reserve(db, config, {
          userId,
          estEur: videoCostEur(config),
          purpose: (s.title || "Video").slice(0, 120),
        }));
      } catch (err) {
        if (err instanceof LedgerError) return reply.code(409).send({ error: err.code });
        throw err;
      }
      let jobId: string;
      try {
        const { rows } = await db.query<{ id: string }>(
          `insert into video_jobs (user_id, scene_id, client_key, reservation_id, provider, model, seconds)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [userId, b.data.sceneId, b.data.key, reservationId, provider.name, provider.model, config.VIDEO_SECONDS],
        );
        jobId = rows[0]!.id;
      } catch (err) {
        // Gleichzeitige Doppel-Anfrage: Reservierung zurückgeben, vorhandenen Auftrag liefern
        await release(db, reservationId);
        const again = await db.query<JobRow>(`${JOB_SELECT} where j.user_id = $1 and j.client_key = $2`, [userId, b.data.key]);
        if (again.rows[0]) return view(again.rows[0]);
        throw err;
      }
      req.log.info({ jobId }, "Video-Auftrag angelegt");
      void worker.tick();
      const { rows } = await db.query<JobRow>(`${JOB_SELECT} where j.id = $1`, [jobId]);
      return reply.code(201).send(view(rows[0]!));
    },
  );

  app.get("/api/jobs/:id", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: "not_found" });
    const { rows } = await db.query<JobRow>(`${JOB_SELECT} where j.id = $1 and j.user_id = $2`, [id.data, req.user.id]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    return view(rows[0]);
  });

  app.get("/api/jobs", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { rows } = await db.query<JobRow>(
      `${JOB_SELECT} where j.user_id = $1 and (j.expires_at is null or j.expires_at > now())
        order by j.created_at desc limit 20`,
      [req.user.id],
    );
    return { jobs: rows.map(view), videoCredits: creditsForEur(videoCostEur(config), config) };
  });

  // Video-Datei – nur für den Besitzer. Unterstützt Range-Anfragen (nötig für Safari/iOS).
  app.get("/api/videos/:file", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const m = /^([0-9a-f-]{36})\.mp4$/.exec((req.params as { file: string }).file);
    if (!m) return reply.code(404).send({ error: "not_found" });
    const { rows } = await db.query<{ file_name: string }>(
      `select file_name from video_jobs
        where id = $1 and user_id = $2 and status = 'done' and file_name is not null and expires_at > now()`,
      [m[1], req.user.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    const filePath = path.join(config.VIDEO_DIR, path.basename(rows[0].file_name));
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.header("content-type", "video/mp4");
    reply.header("accept-ranges", "bytes");
    reply.header("cache-control", "private, max-age=3600");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        reply.header("content-range", `bytes */${size}`);
        return reply.code(416).send();
      }
      reply.code(206);
      reply.header("content-range", `bytes ${start}-${end}/${size}`);
      reply.header("content-length", String(end - start + 1));
      return reply.send(createReadStream(filePath, { start, end }));
    }
    reply.header("content-length", String(size));
    return reply.send(createReadStream(filePath));
  });
}
