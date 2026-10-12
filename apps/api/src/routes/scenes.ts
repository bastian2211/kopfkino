import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Moderation } from "../adapters/moderation.js";
import type { Scene, SceneInterpreter } from "../adapters/scene.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { balanceOf, budgetStatus, creditsForEur, finishBudget, holdBudget, LedgerError, usdToEur } from "../ledger.js";

const body = z.object({
  idea: z.string().trim().min(3, "idea_short").max(600, "idea_long"),
  lang: z.enum(["de", "en"]).optional(),
});

// Szenen-Hash: ändert sich bei jeder wesentlichen Änderung (Personen, Ort, Handlung, Videoprompt).
// Spätere Einwilligungen hängen an diesem Hash – passt er nicht mehr, gilt keine alte Freigabe.
export function sceneHash(s: Scene): string {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
  const canonical = JSON.stringify({
    characters: s.characters.map((c) => [norm(c.name), norm(c.description)]),
    setting: norm(s.setting),
    beats: s.beats.map(norm),
    video_prompt: norm(s.video_prompt),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function sceneRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  interpreter: SceneInterpreter | null,
  moderation: Moderation | null,
) {
  // Vorsichtige Schätzung für den Claude-Aufruf (System-Prompt + Idee ≈ 2.000 Token rein, ≤ 1.500 raus)
  const claudeEur = (inTok: number, outTok: number) =>
    usdToEur((inTok * config.SCENE_USD_IN_PER_MTOK + outTok * config.SCENE_USD_OUT_PER_MTOK) / 1e6, config);
  const estEur = claudeEur(2500, 1500);
  const videoEur = () => usdToEur(config.VIDEO_USD_PER_SEC * config.VIDEO_SECONDS, config);

  app.post(
    "/api/scenes",
    {
      config: { rateLimit: { max: 20, timeWindow: "10 minutes", keyGenerator: (req) => req.user?.id ?? req.ip } },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
      if (!interpreter || !moderation) return reply.code(503).send({ error: "scene_disabled" });
      const parsed = body.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
      const { idea } = parsed.data;
      const lang = parsed.data.lang ?? (req.user.locale as "de" | "en");
      const userId = req.user.id;

      const save = async (row: {
        status: "ok" | "rejected";
        rejectReason?: string;
        rejectSource?: "moderation" | "interpreter";
        scene?: Scene;
        hash?: string;
        model?: string;
        cost: number;
        mod: unknown;
      }) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into scenes (user_id, idea, lang, status, reject_reason, reject_source, scene, scene_hash, model, cost_eur, moderation)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [
            userId,
            idea,
            lang,
            row.status,
            row.rejectReason ?? null,
            row.rejectSource ?? null,
            row.scene ? JSON.stringify(row.scene) : null,
            row.hash ?? null,
            row.model ?? null,
            row.cost,
            JSON.stringify(row.mod),
          ],
        );
        return rows[0]!.id;
      };

      // 1. Idee selbst prüfen (kostenlos) – bei Treffer gar nicht erst Claude fragen
      let modIdea;
      try {
        modIdea = await moderation.check([idea]);
      } catch (err) {
        req.log.error({ err: (err as Error).message }, "Moderation nicht verfügbar");
        return reply.code(502).send({ error: "moderation_unavailable" });
      }
      if (modIdea.flagged) {
        const id = await save({ status: "rejected", rejectSource: "moderation", cost: 0, mod: { idea: modIdea } });
        req.log.info({ categories: modIdea.categories }, "Idee von Moderation abgelehnt");
        return { id, status: "rejected", source: "moderation", categories: modIdea.categories };
      }

      // 2. Szene schreiben lassen – Kosten zählen zum Monatslimit
      let month: string;
      try {
        ({ month } = await holdBudget(db, config, estEur));
      } catch (err) {
        if (err instanceof LedgerError) return reply.code(409).send({ error: err.code });
        throw err;
      }
      let result;
      try {
        result = await interpreter.interpret(idea, { lang, seconds: config.VIDEO_SECONDS });
      } catch (err) {
        await finishBudget(db, month, estEur, 0);
        req.log.error({ err: (err as Error).message }, "Szenen-KI fehlgeschlagen");
        return reply.code(502).send({ error: "scene_failed" });
      }
      const cost = interpreter.name === "fake" ? 0 : claudeEur(result.inputTokens, result.outputTokens);
      await finishBudget(db, month, estEur, cost);
      const scene = result.scene;

      if (scene.decision === "rejected") {
        const id = await save({
          status: "rejected",
          rejectSource: "interpreter",
          rejectReason: scene.reject_reason,
          scene,
          model: result.model,
          cost,
          mod: { idea: modIdea },
        });
        req.log.info({ category: scene.reject_category }, "Idee von Szenen-KI abgelehnt");
        return {
          id,
          status: "rejected",
          source: "interpreter",
          category: scene.reject_category,
          reason: scene.reject_reason,
        };
      }

      // 3. Fertige Szene noch einmal unabhängig prüfen (vor allem den Videoprompt)
      let modScene;
      try {
        modScene = await moderation.check([scene.video_prompt, scene.title, scene.summary, ...scene.beats]);
      } catch (err) {
        req.log.error({ err: (err as Error).message }, "Moderation nicht verfügbar");
        return reply.code(502).send({ error: "moderation_unavailable" });
      }
      if (modScene.flagged) {
        const id = await save({
          status: "rejected",
          rejectSource: "moderation",
          scene,
          model: result.model,
          cost,
          mod: { idea: modIdea, scene: modScene },
        });
        req.log.info({ categories: modScene.categories }, "Szene von Moderation abgelehnt");
        return { id, status: "rejected", source: "moderation", categories: modScene.categories };
      }

      const hash = sceneHash(scene);
      const id = await save({
        status: "ok",
        scene,
        hash,
        model: result.model,
        cost,
        mod: { idea: modIdea, scene: modScene },
      });

      // 4. Kostenschätzung fürs Video
      const vEur = videoEur();
      const credits = creditsForEur(vEur, config);
      const [balance, budget] = await Promise.all([balanceOf(db, userId), budgetStatus(db, config)]);
      return {
        id,
        status: "ok",
        scene: {
          title: scene.title,
          summary: scene.summary,
          characters: scene.characters,
          setting: scene.setting,
          mood: scene.mood,
          beats: scene.beats,
          note: scene.note,
        },
        estimate: { credits, seconds: config.VIDEO_SECONDS },
        balance,
        budgetOk: budget.availableEur >= vEur,
      };
    },
  );
}
