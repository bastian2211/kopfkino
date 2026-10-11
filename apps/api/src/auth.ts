import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

// ---------------------------------------------------------------------------
// Passwörter: scrypt aus Node (keine native Zusatzbibliothek nötig)
// Format: scrypt$N$r$p$salt$hash (base64url)
// ---------------------------------------------------------------------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, saltB64, hashB64] = stored.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const N = Number(n);
  const key = await scrypt(password, Buffer.from(saltB64, "base64url"), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Ein festes Dummy-Hash, damit "Benutzer unbekannt" gleich lange dauert wie "falsches Passwort"
let dummyHash: string | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= await hashPassword("kopfkino-dummy-password");
  await verifyPassword(password, dummyHash);
}

// ---------------------------------------------------------------------------
// Zufalls-Tokens: im Klartext nur beim Nutzer, in der Datenbank nur als SHA-256
// ---------------------------------------------------------------------------
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Sitzungen
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = "kk_session";
export const SESSION_DAYS = 30;

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin";
  locale: "de" | "en";
  sessionId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function createSession(db: Db, userId: string, userAgent?: string): Promise<string> {
  const token = newToken();
  await db.query(
    `insert into sessions (user_id, token_hash, expires_at, user_agent)
     values ($1, $2, now() + make_interval(days => $3), $4)`,
    [userId, sha256(token), SESSION_DAYS, userAgent?.slice(0, 300) ?? null],
  );
  return token;
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.query("delete from sessions where id = $1", [sessionId]);
}

// Token aus Cookie (PWA) oder Authorization-Header (spätere native Apps) lesen
export function readToken(req: FastifyRequest): { token: string; via: "cookie" | "bearer" } | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7).trim(), via: "bearer" };
  const cookie = req.cookies?.[SESSION_COOKIE];
  return cookie ? { token: cookie, via: "cookie" } : null;
}

export async function loadUserFromToken(db: Db, token: string): Promise<SessionUser | null> {
  // Gleitende Laufzeit: jede Nutzung verlängert die Sitzung
  const { rows } = await db.query(
    `update sessions s
        set last_seen_at = now(), expires_at = now() + make_interval(days => $2)
       from users u
      where s.token_hash = $1 and s.user_id = u.id and s.expires_at > now() and u.disabled_at is null
      returning s.id as session_id, u.id, u.username, u.display_name, u.role, u.locale`,
    [sha256(token), SESSION_DAYS],
  );
  const r = rows[0];
  return r
    ? { id: r.id, username: r.username, displayName: r.display_name, role: r.role, locale: r.locale, sessionId: r.session_id }
    : null;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, secure, sameSite: "lax" });
}

// ---------------------------------------------------------------------------
// Einladungen
// ---------------------------------------------------------------------------
export const INVITE_DAYS = 7;

export async function createInvite(
  db: Db,
  opts: { role: "user" | "admin"; createdBy: string | null; note?: string },
): Promise<{ code: string; expiresAt: Date }> {
  const code = newToken(18);
  const { rows } = await db.query<{ expires_at: Date }>(
    `insert into invites (code_hash, role, note, created_by, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(days => $5))
     returning expires_at`,
    [sha256(code), opts.role, opts.note ?? null, opts.createdBy, INVITE_DAYS],
  );
  return { code, expiresAt: rows[0]!.expires_at };
}

export function inviteLink(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/$/, "")}/?invite=${encodeURIComponent(code)}`;
}
