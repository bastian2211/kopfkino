import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  burnPasswordCheck,
  clearSessionCookie,
  createInvite,
  createSession,
  deleteSession,
  hashPassword,
  INVITE_DAYS,
  inviteLink,
  setSessionCookie,
  sha256,
  verifyPassword,
} from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,24}$/, "username");
const password = z.string().min(10, "password_short").max(200);

const registerBody = z.object({
  invite: z.string().min(10).max(100),
  username,
  displayName: z.string().trim().min(1).max(40),
  password,
  adult: z.literal(true, { errorMap: () => ({ message: "adult_required" }) }),
  locale: z.enum(["de", "en"]).default("de"),
});

const loginBody = z.object({ username, password: z.string().min(1).max(200) });

// Einheitliche Fehlerantwort: Code für die App (übersetzt sie selbst), kein Freitext
function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: code });
}

// Nur native Apps bekommen das Token im Klartext; die PWA nutzt ausschließlich das httpOnly-Cookie
function tokenFor(req: FastifyRequest, token: string): { token?: string } {
  return req.headers["x-kopfkino-client"] === "native" ? { token } : {};
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: FastifyRequest, reply: FastifyReply): T | null {
  const r = schema.safeParse(req.body);
  if (r.success) return r.data;
  void fail(reply, 400, r.error.issues[0]?.message ?? "invalid");
  return null;
}

export function authRoutes(app: FastifyInstance, db: Db, config: Config) {
  const secure = config.NODE_ENV === "production";
  // Strenges Limit für alles, was Passwörter oder Einladungscodes prüft
  const strict = { rateLimit: { max: 10, timeWindow: "15 minutes" } };

  // Einladung prüfen, bevor das Formular gezeigt wird
  app.get("/api/auth/invite/:code", { config: strict }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const { rows } = await db.query(
      "select role, expires_at from invites where code_hash = $1 and used_at is null and expires_at > now()",
      [sha256(code)],
    );
    if (!rows[0]) return fail(reply, 404, "invite_invalid");
    return { valid: true, role: rows[0].role, expiresAt: rows[0].expires_at };
  });

  app.post("/api/auth/register", { config: strict }, async (req, reply) => {
    const body = parse(registerBody, req, reply);
    if (!body) return;
    const client = await db.connect();
    try {
      await client.query("begin");
      // Einladung sperren, damit ein Code nicht doppelt eingelöst werden kann
      const inv = await client.query(
        `select id, role from invites
          where code_hash = $1 and used_at is null and expires_at > now()
          for update`,
        [sha256(body.invite)],
      );
      if (!inv.rows[0]) {
        await client.query("rollback");
        return fail(reply, 400, "invite_invalid");
      }
      const exists = await client.query("select 1 from users where username = $1", [body.username]);
      if (exists.rows[0]) {
        await client.query("rollback");
        return fail(reply, 409, "username_taken");
      }
      const hash = await hashPassword(body.password);
      const user = await client.query(
        `insert into users (username, display_name, password_hash, role, locale, adult_confirmed_at)
         values ($1, $2, $3, $4, $5, now()) returning id`,
        [body.username, body.displayName, hash, inv.rows[0].role, body.locale],
      );
      const userId = user.rows[0].id as string;
      await client.query("update invites set used_by = $1, used_at = now() where id = $2", [userId, inv.rows[0].id]);
      await client.query("commit");
      const token = await createSession(db, userId, req.headers["user-agent"]);
      setSessionCookie(reply, token, secure);
      req.log.info({ userId }, "Neues Konto über Einladung angelegt");
      return reply.code(201).send({ ok: true, ...tokenFor(req, token) });
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/api/auth/login", { config: strict }, async (req, reply) => {
    const body = parse(loginBody, req, reply);
    if (!body) return;
    const { rows } = await db.query(
      "select id, password_hash from users where username = $1 and disabled_at is null",
      [body.username],
    );
    const user = rows[0];
    if (!user) {
      await burnPasswordCheck(body.password);
      return fail(reply, 401, "login_failed");
    }
    if (!(await verifyPassword(body.password, user.password_hash))) return fail(reply, 401, "login_failed");
    const token = await createSession(db, user.id, req.headers["user-agent"]);
    setSessionCookie(reply, token, secure);
    return { ok: true, ...tokenFor(req, token) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) await deleteSession(db, req.user.sessionId);
    clearSessionCookie(reply, secure);
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    if (!req.user) return fail(reply, 401, "unauthenticated");
    const { id, username: u, displayName, role, locale } = req.user;
    return { id, username: u, displayName, role, locale };
  });

  app.patch("/api/me", async (req, reply) => {
    if (!req.user) return fail(reply, 401, "unauthenticated");
    const body = parse(z.object({ locale: z.enum(["de", "en"]) }), req, reply);
    if (!body) return;
    await db.query("update users set locale = $1 where id = $2", [body.locale, req.user.id]);
    return { ok: true };
  });

  // ---- Admin ----
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return fail(reply, 401, "unauthenticated");
    if (req.user.role !== "admin") return fail(reply, 403, "forbidden");
    return null;
  };

  app.post("/api/admin/invites", async (req, reply) => {
    if (requireAdmin(req, reply)) return;
    const body = parse(
      z.object({ role: z.enum(["user", "admin"]).default("user"), note: z.string().trim().max(80).optional() }),
      req,
      reply,
    );
    if (!body) return;
    const { code, expiresAt } = await createInvite(db, { role: body.role, createdBy: req.user!.id, note: body.note });
    return reply.code(201).send({ link: inviteLink(config.APP_URL, code), expiresAt, days: INVITE_DAYS });
  });

  app.get("/api/admin/invites", async (req, reply) => {
    if (requireAdmin(req, reply)) return;
    const { rows } = await db.query(
      `select i.id, i.role, i.note, i.created_at, i.expires_at, i.used_at, u.display_name as used_by
         from invites i left join users u on u.id = i.used_by
        order by i.created_at desc limit 50`,
    );
    return { invites: rows };
  });
}
