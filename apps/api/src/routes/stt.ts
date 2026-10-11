import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseWav, SttError, type SpeechToText } from "../adapters/stt.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { finishBudget, holdBudget, LedgerError, usdToEur } from "../ledger.js";

const MIN_SECONDS = 0.5;
const MAX_SECONDS = 25; // App nimmt höchstens 20 s auf, etwas Luft
const WAV_TYPES = ["audio/wav", "audio/x-wav", "audio/wave"];

export function sttRoutes(app: FastifyInstance, db: Db, config: Config, stt: SpeechToText | null) {
  // Aufnahme kommt als rohe WAV-Datei (kein JSON). 16 kHz mono 16 bit × 25 s ≈ 0,8 MB.
  app.addContentTypeParser(WAV_TYPES, { parseAs: "buffer", bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  // Kosten: Abrechnung pro angefangener Minute angenommen (vorsichtig gerechnet, Annahme – nicht belegt)
  const eurFor = (seconds: number) => usdToEur(Math.max(1, Math.ceil(seconds / 60)) * config.STT_USD_PER_MIN, config);

  app.post(
    "/api/stt",
    {
      config: {
        rateLimit: {
          max: 15,
          timeWindow: "5 minutes",
          keyGenerator: (req) => req.user?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
      if (!stt) return reply.code(503).send({ error: "stt_disabled" });
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "audio_invalid" });
      const wav = parseWav(body);
      if (!wav) return reply.code(400).send({ error: "audio_invalid" });
      if (wav.seconds < MIN_SECONDS) return reply.code(400).send({ error: "audio_empty" });
      if (wav.seconds > MAX_SECONDS) return reply.code(400).send({ error: "audio_too_long" });

      const lang = z.enum(["de", "en"]).catch(req.user.locale as "de" | "en").parse((req.query as { lang?: unknown }).lang);
      const estEur = eurFor(wav.seconds);

      let month: string;
      try {
        ({ month } = await holdBudget(db, config, estEur));
      } catch (err) {
        if (err instanceof LedgerError) return reply.code(409).send({ error: err.code });
        throw err;
      }

      const userId = req.user.id;
      const log = async (row: { model: string; billed: number | null; cost: number; language: string | null; ok: boolean; error?: string }) =>
        db.query(
          `insert into stt_requests (user_id, provider, model, audio_seconds, billed_seconds, cost_eur, language, ok, error)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [userId, stt.name, row.model, wav.seconds.toFixed(2), row.billed, row.cost, row.language, row.ok, row.error ?? null],
        );

      try {
        const result = await stt.transcribe(body, { mimeType: "audio/wav", language: lang, seconds: wav.seconds });
        const cost = stt.name === "fake" ? 0 : eurFor(result.billedSeconds);
        await finishBudget(db, month, estEur, cost);
        await log({ model: result.model, billed: result.billedSeconds, cost, language: result.language, ok: true });
        req.log.info({ seconds: wav.seconds, costEur: cost, provider: stt.name }, "Spracherkennung");
        if (!result.text) return reply.code(422).send({ error: "stt_empty" });
        return { text: result.text, language: result.language, seconds: Math.round(wav.seconds * 10) / 10 };
      } catch (err) {
        // Fehlgeschlagener Aufruf: Belegung freigeben (Anbieter rechnet Fehler i. d. R. nicht ab – Annahme)
        await finishBudget(db, month, estEur, 0);
        const message = err instanceof Error ? err.message : String(err);
        await log({ model: config.STT_MODEL, billed: null, cost: 0, language: null, ok: false, error: message.slice(0, 300) });
        req.log.error({ err: message, status: err instanceof SttError ? err.status : undefined }, "Spracherkennung fehlgeschlagen");
        return reply.code(502).send({ error: "stt_failed" });
      }
    },
  );
}
