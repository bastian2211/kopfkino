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
