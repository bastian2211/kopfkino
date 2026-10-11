import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { adminBooking, balanceOf, budgetStatus, LedgerError, statement } from "../ledger.js";

function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: code });
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    void fail(reply, 401, "unauthenticated");
    return false;
  }
  if (req.user.role !== "admin") {
    void fail(reply, 403, "forbidden");
    return false;
  }
  return true;
}

const LEDGER_STATUS: Record<LedgerError["code"], number> = {
  insufficient_credits: 409,
  budget_exhausted: 409,
  not_found: 404,
  idempotency_conflict: 409,
};

export function creditRoutes(app: FastifyInstance, db: Db, config: Config) {
  // Eigener Kontostand und Kontoauszug
  app.get("/api/credits", async (req, reply) => {
    if (!req.user) return fail(reply, 401, "unauthenticated");
    const q = z.object({ before: z.string().regex(/^\d+$/).optional() }).safeParse(req.query);
    if (!q.success) return fail(reply, 400, "invalid");
    const [balance, page] = await Promise.all([
      balanceOf(db, req.user.id),
      statement(db, req.user.id, { before: q.data.before }),
    ]);
    return { balance, eurPerCredit: config.EUR_PER_CREDIT, ...page };
  });

  // ---- Admin ----

  // Guthaben gutschreiben (Aufladung) oder korrigieren. Der Schlüssel kommt von der App:
  // Doppeltes Absenden (z. B. schlechtes Netz) bucht so nur einmal.
  app.post("/api/admin/credits", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const r = z
      .object({
        userId: z.string().uuid(),
        kind: z.enum(["topup", "adjust"]),
        credits: z.number().int().min(-100000).max(100000).refine((n) => n !== 0, "credits"),
        note: z.string().trim().max(120).optional(),
        key: z.string().uuid(),
      })
      .refine((b) => b.kind !== "topup" || b.credits > 0, { message: "credits" })
      .safeParse(req.body);
    if (!r.success) return fail(reply, 400, r.error.issues[0]?.message ?? "invalid");
    try {
      const result = await adminBooking(db, { ...r.data, adminId: req.user!.id });
      req.log.info(
        { userId: r.data.userId, credits: r.data.credits, kind: r.data.kind, duplicate: result.duplicate },
        "Admin-Buchung",
      );
      return result;
    } catch (err) {
      if (err instanceof LedgerError) return fail(reply, LEDGER_STATUS[err.code], err.code);
      throw err;
    }
  });

  // Nutzer mit Kontostand
  app.get("/api/admin/users", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { rows } = await db.query<{
      id: string;
      username: string;
      display_name: string;
      role: string;
      created_at: Date;
      disabled_at: Date | null;
      balance: string;
    }>(
      `select u.id, u.username, u.display_name, u.role, u.created_at, u.disabled_at,
              coalesce((select sum(credits) from ledger_entries l where l.user_id = u.id), 0) as balance
         from users u order by u.created_at`,
    );
    return {
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role,
        createdAt: u.created_at,
        disabled: !!u.disabled_at,
        balance: Number(u.balance),
      })),
    };
  });

  // Kostenbremse: Stand des laufenden Monats
  app.get("/api/admin/budget", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      ...(await budgetStatus(db, config)),
      markupPct: config.MARKUP_PCT,
      eurPerCredit: config.EUR_PER_CREDIT,
      usdPerEur: config.USD_PER_EUR,
    };
  });
}
