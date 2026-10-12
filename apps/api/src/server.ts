import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { loadUserFromToken, readToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { creditRoutes } from "./routes/credits.js";
import { sttRoutes } from "./routes/stt.js";
import { createStt } from "./adapters/stt.js";
import { createSceneInterpreter } from "./adapters/scene.js";
import { createModeration } from "./adapters/moderation.js";
import { sceneRoutes } from "./routes/scenes.js";
import { createPusher, pushRoutes } from "./routes/push.js";

export async function buildServer() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      // Zugangsdaten nie ins Log schreiben
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
    },
    // Hinter Caddy: echte Client-IP aus X-Forwarded-For übernehmen (wichtig für Rate-Limits)
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  // Global großzügig; strengere Grenzen setzen einzelne Routen selbst
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  app.addHook("onClose", async () => {
    await db.end();
  });

  const appOrigin = new URL(config.APP_URL).origin;

  app.addHook("onRequest", async (req, reply) => {
    const t = readToken(req);
    // Schutz gegen fremde Webseiten (CSRF): ändernde Anfragen mit Cookie nur von der eigenen Seite
    if (t?.via === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== appOrigin && config.NODE_ENV === "production") {
        return reply.code(403).send({ error: "bad_origin" });
      }
    }
    if (t) {
      const user = await loadUserFromToken(db, t.token);
      if (user) req.user = user;
    }
  });

  // Health-Check: prüft auch die Datenbank. Wird von Docker und vom Frontend genutzt.
  app.get("/api/health", { config: { rateLimit: false } }, async (_req, reply) => {
    let dbState: "ok" | "error" = "ok";
    try {
      await db.query("select 1");
    } catch (err) {
      app.log.error({ err }, "Datenbank nicht erreichbar");
      dbState = "error";
    }
    const ok = dbState === "ok";
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      db: dbState,
      version: config.APP_VERSION,
      time: new Date().toISOString(),
    });
  });

  const pusher = createPusher(db, config, app.log);
  authRoutes(app, db, config);
  creditRoutes(app, db, config);
  sttRoutes(app, db, config, createStt(config));
  sceneRoutes(app, db, config, createSceneInterpreter(config), createModeration(config));
  pushRoutes(app, db, config, pusher);

  return { app, config, db };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const { app, config, db } = await buildServer();
  await migrate(db, (m) => app.log.info(m));
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} empfangen, fahre herunter`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}
