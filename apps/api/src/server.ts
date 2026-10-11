import Fastify from "fastify";
import pg from "pg";
import { loadConfig } from "./config.js";

export async function buildServer() {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });

  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    // Hinter Caddy: echte Client-IP aus X-Forwarded-For übernehmen (wichtig für spätere Rate-Limits).
    trustProxy: true,
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  // Health-Check: prüft auch die Datenbank. Wird von Docker und vom Frontend genutzt.
  app.get("/api/health", async (_req, reply) => {
    let db: "ok" | "error" = "ok";
    try {
      await pool.query("select 1");
    } catch (err) {
      app.log.error({ err }, "Datenbank nicht erreichbar");
      db = "error";
    }
    const ok = db === "ok";
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      db,
      version: config.APP_VERSION,
      time: new Date().toISOString(),
    });
  });

  return { app, config };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const { app, config } = await buildServer();
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} empfangen, fahre herunter`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}
