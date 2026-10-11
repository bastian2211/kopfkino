import type { FastifyInstance } from "fastify";
import webpush from "web-push";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db.js";

const subscriptionBody = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
});

export type Pusher = {
  enabled: boolean;
  sendToUser: (userId: string, payload: { title: string; body: string; url?: string }) => Promise<number>;
};

export function createPusher(db: Db, config: Config, log: { warn: (o: object, m: string) => void }): Pusher {
  const enabled = !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
  if (enabled) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);

  return {
    enabled,
    async sendToUser(userId, payload) {
      if (!enabled) return 0;
      const { rows } = await db.query("select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1", [
        userId,
      ]);
      let sent = 0;
      for (const s of rows) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            { TTL: 3600, urgency: "normal" },
          );
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410: Abo existiert nicht mehr (App gelöscht, Erlaubnis entzogen) → aufräumen
          if (status === 404 || status === 410) {
            await db.query("delete from push_subscriptions where id = $1", [s.id]);
          } else {
            log.warn({ status, err: String(err) }, "Push fehlgeschlagen");
          }
        }
      }
      return sent;
    },
  };
}

export function pushRoutes(app: FastifyInstance, db: Db, config: Config, pusher: Pusher) {
  app.get("/api/push/key", async () => ({ enabled: pusher.enabled, publicKey: config.VAPID_PUBLIC_KEY ?? null }));

  app.post("/api/push/subscribe", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const r = subscriptionBody.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: "invalid_subscription" });
    const { endpoint, keys } = r.data;
    await db.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth],
    );
    return { ok: true };
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const r = z.object({ endpoint: z.string().url() }).safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: "invalid" });
    await db.query("delete from push_subscriptions where endpoint = $1 and user_id = $2", [r.data.endpoint, req.user.id]);
    return { ok: true };
  });

  // Test: schickt nach kurzer Verzögerung eine Nachricht, damit man die App vorher schließen kann
  app.post(
    "/api/push/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
      if (!pusher.enabled) return reply.code(503).send({ error: "push_disabled" });
      const userId = req.user.id;
      const delay = z.coerce.number().int().min(0).max(30).catch(5).parse((req.body as { delay?: unknown })?.delay);
      setTimeout(() => {
        void pusher.sendToUser(userId, {
          title: "Kopfkino",
          body: "Test geklappt! So meldet sich Kopfkino, wenn dein Video fertig ist. 🎬",
          url: "/",
        });
      }, delay * 1000);
      return { ok: true, delay };
    },
  );
}
