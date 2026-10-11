import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { adminBooking, balanceOf, budgetStatus, creditsForEur, reserve, settle, release, statement, usdToEur, LedgerError } from "../src/ledger.ts";
import { createSession } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";

// Integrationstest gegen eine LOKALE Wegwerf-Datenbank. Löscht dort alles!
// Aufruf: DATABASE_URL=postgres://…@127.0.0.1:…/… npm run test:ledger -w @kopfkino/api
const config = loadConfig();
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(config.DATABASE_URL)) throw new Error("Nur gegen eine lokale Test-Datenbank ausführen!");
const db = createPool(config.DATABASE_URL);
await db.query("drop schema public cascade; create schema public;");
await migrate(db, () => {});
const mk = async (u: string, role = "user") =>
  (await db.query("insert into users (username, display_name, password_hash, role, adult_confirmed_at) values ($1,$1,'x',$2,now()) returning id", [u, role])).rows[0].id as string;
const admin = await mk("admin", "admin");
const user = await mk("user");
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof LedgerError ? e.code : String((e as Error).message); } };
let n = 0; const ok = (m: string) => console.log(`✓ ${++n} ${m}`);

const k1 = crypto.randomUUID();
assert.equal((await adminBooking(db, { userId: user, kind: "topup", credits: 100, adminId: admin, key: k1, note: "Start" })).balance, 100);
const again = await adminBooking(db, { userId: user, kind: "topup", credits: 100, adminId: admin, key: k1 });
assert.equal(again.balance, 100); assert.equal(again.duplicate, true); ok("Aufladung + Wiederholung bucht nur einmal");
assert.equal(await code(adminBooking(db, { userId: user, kind: "topup", credits: 50, adminId: admin, key: k1 })), "idempotency_conflict"); ok("gleicher Schlüssel, anderer Betrag → Konflikt");
assert.equal(await code(adminBooking(db, { userId: user, kind: "adjust", credits: -200, adminId: admin, key: crypto.randomUUID() })), "insufficient_credits");
assert.equal((await adminBooking(db, { userId: user, kind: "adjust", credits: -10, adminId: admin, key: crypto.randomUUID() })).balance, 90); ok("Korrektur, nie ins Minus");

const est = usdToEur(0.30, config);
assert.equal(creditsForEur(est, config), 34); ok("Veo-Beispiel 0,30 $ → 34 Credits (wie im Plan)");
const r1 = await reserve(db, config, { userId: user, estEur: est, purpose: "Test-Video" });
assert.equal(await balanceOf(db, user), 56);
assert.equal((await budgetStatus(db, config)).reservedEur.toFixed(4), est.toFixed(4)); ok("Reservierung zieht Credits ab und belegt Budget");
const s1 = await settle(db, r1.reservationId, est * 0.9);
assert.equal(s1.charged, creditsForEur(est * 0.9, config));
assert.equal(await balanceOf(db, user), 90 - s1.charged);
assert.equal((await settle(db, r1.reservationId, est)).alreadyClosed, true);
assert.equal(await balanceOf(db, user), 90 - s1.charged); ok(`Abrechnung tatsächlicher Kosten (${s1.charged} Credits), doppelt abrechnen wirkt nicht`);
const r2 = await reserve(db, config, { userId: user, estEur: est, purpose: "Fehlversuch" });
await release(db, r2.reservationId, 0.01);
assert.equal(await balanceOf(db, user), 90 - s1.charged);
const b = await budgetStatus(db, config);
assert.equal(b.reservedEur, 0); assert.equal(b.spentEur.toFixed(4), (est * 0.9 + 0.01).toFixed(4)); ok("Fehlschlag erstattet alles, echte Kosten zählen zum Limit");
const r3 = await reserve(db, config, { userId: user, estEur: est * 1.5, purpose: "mehr als geschätzt" });
assert.equal((await settle(db, r3.reservationId, est * 5)).charged, r3.credits); ok("Nie mehr abbuchen als reserviert");
assert.equal(await code(reserve(db, config, { userId: user, estEur: 5, purpose: "zu teuer" })), "insufficient_credits"); ok("Zu wenig Guthaben → abgelehnt");

const rich = await mk("rich");
await adminBooking(db, { userId: rich, kind: "topup", credits: 100000, adminId: admin, key: crypto.randomUUID() });
const avail = (await budgetStatus(db, config)).availableEur;
const results = await Promise.all(Array.from({ length: 30 }, () => code(reserve(db, config, { userId: rich, estEur: 1, purpose: "parallel" }))));
const accepted = results.filter((r) => r === "ok").length;
assert.equal(accepted, Math.floor(avail + 1e-9));
assert.ok(results.every((r) => r === "ok" || r === "budget_exhausted"));
const after = await budgetStatus(db, config);
assert.ok(after.spentEur + after.reservedEur <= config.MONTHLY_CAP_EUR + 1e-9); ok(`30 parallele Reservierungen à 1 €: genau ${accepted} angenommen, Limit 20 € nie überschritten`);
assert.equal(await code(reserve(db, config, { userId: rich, estEur: 1, purpose: "zu viel" })), "budget_exhausted"); ok("Budget erreicht → abgelehnt trotz Guthaben");

for (const sql of ["update ledger_entries set credits = 999", "delete from ledger_entries", "truncate ledger_entries"]) {
  await assert.rejects(db.query(sql), /unveränderlich/);
}
ok("UPDATE/DELETE/TRUNCATE auf Buchungen verboten");

const st = await statement(db, user);
assert.deepEqual(st.entries.map((e) => `${e.type}:${e.status ?? "-"}:${e.credits}`), [
  `usage:settled:${-r3.credits}`, "usage:released:0", `usage:settled:${-s1.charged}`, "admin_adjust:-:-10", "topup:-:100",
]);
ok("Kontoauszug fasst Reservierungen zusammen");

// HTTP
await db.end();
const { app, db: db2 } = await buildServer();
const userTok = await createSession(db2, user, "t"); const adminTok = await createSession(db2, admin, "t");
const h = (t: string) => ({ authorization: `Bearer ${t}` });
let res = await app.inject({ method: "GET", url: "/api/credits", headers: h(userTok) });
assert.equal(res.json().balance, await balanceOf(db2, user)); ok("GET /api/credits");
res = await app.inject({ method: "POST", url: "/api/admin/credits", headers: h(userTok), payload: { userId: user, kind: "topup", credits: 5, key: crypto.randomUUID() } });
assert.equal(res.statusCode, 403); ok("Nicht-Admin darf nicht aufladen");
res = await app.inject({ method: "POST", url: "/api/admin/credits", headers: h(adminTok), payload: { userId: user, kind: "topup", credits: -5, key: crypto.randomUUID() } });
assert.equal(res.statusCode, 400); ok("Aufladung mit Minusbetrag abgelehnt");
res = await app.inject({ method: "POST", url: "/api/admin/credits", headers: h(adminTok), payload: { userId: user, kind: "topup", credits: 500, key: crypto.randomUUID(), note: "Bar bezahlt" } });
assert.equal(res.statusCode, 200); ok("Admin lädt auf → " + res.json().balance);
res = await app.inject({ method: "GET", url: "/api/admin/users", headers: h(adminTok) });
assert.equal(res.json().users.find((u: { id: string }) => u.id === user).balance, (await balanceOf(db2, user)));
res = await app.inject({ method: "GET", url: "/api/admin/budget", headers: h(adminTok) });
assert.equal(res.json().capEur, 20); ok("Admin: Nutzerliste mit Stand, Budget " + JSON.stringify(res.json()));
await app.close();
console.log("ALLE TESTS OK");
