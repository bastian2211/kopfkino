import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

// Migrationen: nur anhängen, nie bestehende ändern. Jede läuft genau einmal, in einer Transaktion.
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_users_invites_sessions",
    sql: `
      create table users (
        id uuid primary key default gen_random_uuid(),
        username text not null unique check (username ~ '^[a-z0-9._-]{3,24}$'),
        display_name text not null check (char_length(display_name) between 1 and 40),
        password_hash text not null,
        role text not null default 'user' check (role in ('user', 'admin')),
        locale text not null default 'de' check (locale in ('de', 'en')),
        -- Nur die Bestätigung "mindestens 18", kein Geburtsdatum (Datensparsamkeit)
        adult_confirmed_at timestamptz not null,
        created_at timestamptz not null default now(),
        disabled_at timestamptz
      );

      create table invites (
        id uuid primary key default gen_random_uuid(),
        code_hash text not null unique,
        role text not null default 'user' check (role in ('user', 'admin')),
        note text,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        used_by uuid references users(id) on delete set null,
        used_at timestamptz
      );

      create table sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        token_hash text not null unique,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        user_agent text
      );
      create index sessions_user_idx on sessions(user_id);
    `,
  },
  {
    id: "002_push_subscriptions",
    sql: `
      create table push_subscriptions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        endpoint text not null unique,
        p256dh text not null,
        auth text not null,
        created_at timestamptz not null default now()
      );
      create index push_user_idx on push_subscriptions(user_id);
    `,
  },
  {
    id: "003_ledger_budget",
    sql: `
      -- Guthaben-Buchungen: nur Einfügen erlaubt. Kontostand = Summe aller Buchungen.
      create table ledger_entries (
        id bigserial primary key,
        user_id uuid not null references users(id),
        type text not null check (type in ('topup', 'reserve', 'release', 'charge', 'refund', 'admin_adjust')),
        credits integer not null,
        reservation_id uuid,
        payment_id uuid,
        idempotency_key text not null unique,
        note text check (char_length(note) <= 120),
        created_by uuid references users(id),
        created_at timestamptz not null default now(),
        -- Vorzeichen passend zum Typ erzwingen
        check (
          (type in ('topup', 'release', 'refund') and credits > 0) or
          (type in ('reserve', 'charge') and credits < 0) or
          (type = 'admin_adjust' and credits <> 0)
        )
      );
      create index ledger_user_idx on ledger_entries(user_id, id desc);

      create function ledger_immutable() returns trigger language plpgsql as $f$
      begin
        raise exception 'ledger_entries ist unveränderlich (nur INSERT erlaubt)';
      end
      $f$;
      create trigger ledger_no_update_delete before update or delete on ledger_entries
        for each row execute function ledger_immutable();
      create trigger ledger_no_truncate before truncate on ledger_entries
        for each statement execute function ledger_immutable();

      -- Monatliches API-Kostenlimit (globale Sicherung über alle Nutzer)
      create table budget_months (
        month date primary key,
        spent_eur numeric(12, 4) not null default 0 check (spent_eur >= 0),
        reserved_eur numeric(12, 4) not null default 0 check (reserved_eur >= 0)
      );

      -- Reservierung vor einer kostenpflichtigen Aktion (später: ein Video-Job)
      create table reservations (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id),
        credits integer not null check (credits > 0),
        est_eur numeric(12, 4) not null check (est_eur >= 0),
        budget_month date not null references budget_months(month),
        markup_pct numeric(6, 2) not null,
        eur_per_credit numeric(10, 6) not null,
        purpose text not null,
        status text not null default 'open' check (status in ('open', 'settled', 'released')),
        actual_eur numeric(12, 4),
        charged_credits integer,
        created_at timestamptz not null default now(),
        closed_at timestamptz
      );
      create index reservations_open_idx on reservations(status) where status = 'open';
    `,
  },
  {
    id: "004_stt_requests",
    sql: `
      -- Protokoll der Spracherkennung: nur Kosten und Dauer, weder Audio noch Text (Datensparsamkeit)
      create table stt_requests (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        provider text not null,
        model text not null,
        audio_seconds numeric(8, 2) not null,
        billed_seconds numeric(8, 2),
        cost_eur numeric(12, 6) not null default 0,
        language text,
        ok boolean not null,
        error text,
        created_at timestamptz not null default now()
      );
      create index stt_requests_user_idx on stt_requests(user_id, created_at desc);
    `,
  },
];

export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  const client = await db.connect();
  try {
    // Sperre, damit zwei gleichzeitig startende Container nicht doppelt migrieren
    await client.query("select pg_advisory_lock(424242)");
    await client.query(
      "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ id: string }>("select id from schema_migrations");
    const done = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations(id) values ($1)", [m.id]);
        await client.query("commit");
        log(`Migration angewendet: ${m.id}`);
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(424242)").catch(() => undefined);
    client.release();
  }
}
