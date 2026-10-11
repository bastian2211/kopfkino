// Guthaben und Kostenbremse.
//
// Regeln:
// - Buchungen werden nur eingefügt, nie geändert (Datenbank-Trigger erzwingt das).
// - Kontostand = Summe aller Buchungen eines Nutzers.
// - Vor jeder kostenpflichtigen Aktion: reserve() → danach settle() (Erfolg) oder release() (Fehlschlag).
// - Das Monatslimit (MONTHLY_CAP_EUR) gilt für alle Nutzer zusammen und wird in derselben
//   Transaktion wie die Reservierung geprüft. Ist es erreicht, wird abgelehnt – egal wie viel Guthaben da ist.
// - Jede Buchung hat einen eindeutigen idempotency_key: Wiederholungen buchen nie doppelt.
import type pg from "pg";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

export type LedgerErrorCode = "insufficient_credits" | "budget_exhausted" | "not_found" | "idempotency_conflict";

export class LedgerError extends Error {
  constructor(public code: LedgerErrorCode) {
    super(code);
  }
}

type Client = pg.PoolClient;
type Queryable = Pick<pg.Pool, "query">;

export type Pricing = Pick<Config, "EUR_PER_CREDIT" | "MARKUP_PCT" | "USD_PER_EUR" | "MONTHLY_CAP_EUR">;

// ---- Umrechnung ----

export function usdToEur(usd: number, p: Pricing): number {
  return usd / p.USD_PER_EUR;
}

// Credits für echte API-Kosten in €: mit Aufschlag, immer aufgerundet
export function creditsForEur(eur: number, p: Pricing): number {
  if (eur <= 0) return 0;
  return Math.ceil((eur * (1 + p.MARKUP_PCT / 100)) / p.EUR_PER_CREDIT - 1e-9);
}

// ---- Hilfen ----

export async function inTx<T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function balanceOf(q: Queryable, userId: string): Promise<number> {
  const { rows } = await q.query<{ balance: string }>(
    "select coalesce(sum(credits), 0) as balance from ledger_entries where user_id = $1",
    [userId],
  );
  return Number(rows[0]?.balance ?? 0);
}

// Sperrt den Nutzer, damit parallele Buchungen den Kontostand nicht gleichzeitig prüfen
async function lockUser(c: Client, userId: string): Promise<void> {
  const { rowCount } = await c.query("select 1 from users where id = $1 for update", [userId]);
  if (!rowCount) throw new LedgerError("not_found");
}

type EntryInput = {
  userId: string;
  type: "topup" | "reserve" | "release" | "charge" | "refund" | "admin_adjust";
  credits: number;
  key: string;
  reservationId?: string;
  paymentId?: string;
  note?: string;
  createdBy?: string;
};

// Fügt eine Buchung ein. Gibt es den Schlüssel schon, wird nichts gebucht (Wiederholung) –
// passt die alte Buchung nicht zur neuen, ist das ein Fehler.
async function insertEntry(c: Client, e: EntryInput): Promise<{ id: string; duplicate: boolean }> {
  const { rows } = await c.query<{ id: string }>(
    `insert into ledger_entries (user_id, type, credits, reservation_id, payment_id, idempotency_key, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (idempotency_key) do nothing
     returning id`,
    [e.userId, e.type, e.credits, e.reservationId ?? null, e.paymentId ?? null, e.key, e.note ?? null, e.createdBy ?? null],
  );
  if (rows[0]) return { id: rows[0].id, duplicate: false };
  const existing = await c.query<{ id: string; user_id: string; type: string; credits: number }>(
    "select id, user_id, type, credits from ledger_entries where idempotency_key = $1",
    [e.key],
  );
  const old = existing.rows[0];
  if (!old || old.user_id !== e.userId || old.type !== e.type || old.credits !== e.credits) {
    throw new LedgerError("idempotency_conflict");
  }
  return { id: old.id, duplicate: true };
}

// Monatszeile anlegen (falls neu) und sperren. Monat nach deutscher Zeit.
async function lockBudgetMonth(c: Client): Promise<{ month: string; spent: number; reserved: number }> {
  await c.query(
    `insert into budget_months (month) values (date_trunc('month', now() at time zone 'Europe/Berlin')::date)
     on conflict do nothing`,
  );
  const { rows } = await c.query<{ month: string; spent_eur: string; reserved_eur: string }>(
    `select to_char(month, 'YYYY-MM-DD') as month, spent_eur, reserved_eur from budget_months
      where month = date_trunc('month', now() at time zone 'Europe/Berlin')::date
      for update`,
  );
  const r = rows[0]!;
  return { month: r.month, spent: Number(r.spent_eur), reserved: Number(r.reserved_eur) };
}

// ---- Admin / Bezahlung: Guthaben gutschreiben oder korrigieren ----

export async function adminBooking(
  db: Db,
  input: { userId: string; kind: "topup" | "adjust"; credits: number; note?: string; adminId: string; key: string },
): Promise<{ balance: number; duplicate: boolean }> {
  return inTx(db, async (c) => {
    await lockUser(c, input.userId);
    if (input.credits < 0) {
      // Eine Korrektur darf das Konto nicht ins Minus drücken
      const bal = await balanceOf(c, input.userId);
      if (bal + input.credits < 0) throw new LedgerError("insufficient_credits");
    }
    const { duplicate } = await insertEntry(c, {
      userId: input.userId,
      type: input.kind === "topup" ? "topup" : "admin_adjust",
      credits: input.credits,
      key: `admin:${input.key}`,
      note: input.note,
      createdBy: input.adminId,
    });
    return { balance: await balanceOf(c, input.userId), duplicate };
  });
}

// ---- Ablauf einer kostenpflichtigen Aktion ----

export async function reserve(
  db: Db,
  p: Pricing,
  input: { userId: string; estEur: number; purpose: string },
): Promise<{ reservationId: string; credits: number }> {
  const credits = creditsForEur(input.estEur, p);
  if (credits <= 0) throw new Error("Reservierung braucht positive Kosten");
  return inTx(db, async (c) => {
    await lockUser(c, input.userId);
    if ((await balanceOf(c, input.userId)) < credits) throw new LedgerError("insufficient_credits");

    const budget = await lockBudgetMonth(c);
    if (budget.spent + budget.reserved + input.estEur > p.MONTHLY_CAP_EUR + 1e-9) {
      throw new LedgerError("budget_exhausted");
    }

    const { rows } = await c.query<{ id: string }>(
      `insert into reservations (user_id, credits, est_eur, budget_month, markup_pct, eur_per_credit, purpose)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [input.userId, credits, input.estEur, budget.month, p.MARKUP_PCT, p.EUR_PER_CREDIT, input.purpose],
    );
    const reservationId = rows[0]!.id;
    await insertEntry(c, {
      userId: input.userId,
      type: "reserve",
      credits: -credits,
      key: `res:${reservationId}:reserve`,
      reservationId,
      note: input.purpose,
    });
    await c.query("update budget_months set reserved_eur = reserved_eur + $1 where month = $2", [
      input.estEur,
      budget.month,
    ]);
    return { reservationId, credits };
  });
}

type OpenReservation = {
  id: string;
  user_id: string;
  credits: number;
  est_eur: string;
  budget_month: string;
  markup_pct: string;
  eur_per_credit: string;
  purpose: string;
  status: string;
};

async function lockReservation(c: Client, id: string): Promise<OpenReservation> {
  const { rows } = await c.query<OpenReservation>(
    `select id, user_id, credits, est_eur, to_char(budget_month, 'YYYY-MM-DD') as budget_month,
            markup_pct, eur_per_credit, purpose, status
       from reservations where id = $1 for update`,
    [id],
  );
  if (!rows[0]) throw new LedgerError("not_found");
  return rows[0];
}

// Erfolg: Reservierung freigeben und die tatsächlichen Kosten abbuchen.
// Es wird nie mehr abgebucht als reserviert (der Nutzer hat die Schätzung gesehen) – Mehrkosten trägt Kopfkino.
export async function settle(
  db: Db,
  reservationId: string,
  actualEur: number,
): Promise<{ charged: number; alreadyClosed: boolean }> {
  return inTx(db, async (c) => {
    const r = await lockReservation(c, reservationId);
    if (r.status !== "open") return { charged: 0, alreadyClosed: true };
    // Mit den Werten von damals rechnen, nicht mit der aktuellen Einstellung
    const pricing = {
      MARKUP_PCT: Number(r.markup_pct),
      EUR_PER_CREDIT: Number(r.eur_per_credit),
      USD_PER_EUR: 1,
      MONTHLY_CAP_EUR: 0,
    };
    const charged = Math.min(r.credits, creditsForEur(actualEur, pricing));
    await insertEntry(c, {
      userId: r.user_id,
      type: "release",
      credits: r.credits,
      key: `res:${r.id}:release`,
      reservationId: r.id,
      note: r.purpose,
    });
    if (charged > 0) {
      await insertEntry(c, {
        userId: r.user_id,
        type: "charge",
        credits: -charged,
        key: `res:${r.id}:charge`,
        reservationId: r.id,
        note: r.purpose,
      });
    }
    await closeBudget(c, r, actualEur);
    await c.query(
      "update reservations set status = 'settled', actual_eur = $2, charged_credits = $3, closed_at = now() where id = $1",
      [r.id, actualEur, charged],
    );
    return { charged, alreadyClosed: false };
  });
}

// Fehlschlag: alles zurück an den Nutzer. Tatsächlich angefallene API-Kosten zählen trotzdem zum Monatslimit.
export async function release(db: Db, reservationId: string, actualEur = 0): Promise<{ alreadyClosed: boolean }> {
  return inTx(db, async (c) => {
    const r = await lockReservation(c, reservationId);
    if (r.status !== "open") return { alreadyClosed: true };
    await insertEntry(c, {
      userId: r.user_id,
      type: "release",
      credits: r.credits,
      key: `res:${r.id}:release`,
      reservationId: r.id,
      note: r.purpose,
    });
    await closeBudget(c, r, actualEur);
    await c.query(
      "update reservations set status = 'released', actual_eur = $2, charged_credits = 0, closed_at = now() where id = $1",
      [r.id, actualEur],
    );
    return { alreadyClosed: false };
  });
}

async function closeBudget(c: Client, r: OpenReservation, actualEur: number): Promise<void> {
  await c.query("select 1 from budget_months where month = $1 for update", [r.budget_month]);
  await c.query(
    `update budget_months
        set reserved_eur = greatest(reserved_eur - $2, 0),
            spent_eur = spent_eur + $3
      where month = $1`,
    [r.budget_month, Number(r.est_eur), actualEur],
  );
}

// ---- Abfragen ----

export async function budgetStatus(
  q: Queryable,
  p: Pricing,
): Promise<{ month: string; capEur: number; spentEur: number; reservedEur: number; availableEur: number }> {
  const { rows } = await q.query<{ month: string; spent_eur: string | null; reserved_eur: string | null }>(
    `select to_char(m.month, 'YYYY-MM') as month, b.spent_eur, b.reserved_eur
       from (select date_trunc('month', now() at time zone 'Europe/Berlin')::date as month) m
       left join budget_months b on b.month = m.month`,
  );
  const r = rows[0]!;
  const spent = Number(r.spent_eur ?? 0);
  const reserved = Number(r.reserved_eur ?? 0);
  return {
    month: r.month,
    capEur: p.MONTHLY_CAP_EUR,
    spentEur: spent,
    reservedEur: reserved,
    availableEur: Math.round(Math.max(0, p.MONTHLY_CAP_EUR - spent - reserved) * 10000) / 10000,
  };
}

// Kontoauszug: Buchungen einer Reservierung (reservieren → freigeben → abbuchen) werden zu einer Zeile
// zusammengefasst, damit der Nutzer nur sieht, was es ihn am Ende gekostet hat.
export type StatementEntry = {
  id: string;
  type: string; // topup | admin_adjust | refund | usage
  status: "open" | "settled" | "released" | null; // nur bei usage
  credits: number;
  note: string | null;
  createdAt: string;
};

export async function statement(
  q: Queryable,
  userId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<{ entries: StatementEntry[]; hasMore: boolean }> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const { rows } = await q.query<{
    id: string;
    type: string;
    credits: string;
    note: string | null;
    created_at: Date;
    status: StatementEntry["status"];
  }>(
    `with g as (
       select min(id) as id,
              case when reservation_id is null then min(type) else 'usage' end as type,
              sum(credits) as credits,
              (array_agg(note order by id))[1] as note,
              min(created_at) as created_at,
              reservation_id
         from ledger_entries
        where user_id = $1
        group by coalesce('r' || reservation_id::text, 'e' || id::text), reservation_id
     )
     select g.id, g.type, g.credits, g.note, g.created_at, r.status
       from g left join reservations r on r.id = g.reservation_id
      where $2::bigint is null or g.id < $2::bigint
      order by g.id desc
      limit $3`,
    [userId, opts.before ?? null, limit + 1],
  );
  return {
    entries: rows.slice(0, limit).map((r) => ({
      id: String(r.id),
      type: r.type,
      status: r.status ?? null,
      credits: Number(r.credits),
      note: r.note,
      createdAt: r.created_at.toISOString(),
    })),
    hasMore: rows.length > limit,
  };
}
