// Integrationstest Spracherkennung gegen eine LOKALE Wegwerf-Datenbank. Löscht dort alles!
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { createSession } from "../src/auth.ts";
import { MistralStt, parseWav } from "../src/adapters/stt.ts";
import { budgetStatus } from "../src/ledger.ts";

const config = loadConfig();
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(config.DATABASE_URL)) throw new Error("Nur gegen eine lokale Test-Datenbank ausführen!");
const db = createPool(config.DATABASE_URL);
await db.query("drop schema public cascade; create schema public;");
await migrate(db, () => {});
await db.end();

function wav(seconds: number, rate = 16000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return b;
}
let k = 0; const ok = (m: string) => console.log(`✓ ${++k} ${m}`);

assert.equal(parseWav(wav(3))!.seconds, 3); assert.equal(parseWav(Buffer.from("nope")), null); ok("WAV-Kopf wird gelesen");

const { buildServer } = await import("../src/server.ts");
const { app, db: db2 } = await buildServer();
const uid = (await db2.query("insert into users (username, display_name, password_hash, adult_confirmed_at) values ('tester','Tester','x',now()) returning id")).rows[0].id;
const tok = await createSession(db2, uid, "t");
const post = (body: Buffer | string, type = "audio/wav", url = "/api/stt?lang=de") =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${tok}`, "content-type": type }, payload: body });

let r = await post(wav(4));
assert.equal(r.statusCode, 200, r.body); assert.match(r.json().text, /Hund/); assert.equal(r.json().seconds, 4); ok("Aufnahme → Transkript (Test-Ersatz)");
r = await post(wav(4), "audio/wav", "/api/stt?lang=en"); assert.match(r.json().text, /dog/); ok("Sprache EN");
r = await post(wav(0.2)); assert.equal(r.json().error, "audio_empty"); ok("zu kurz abgelehnt");
r = await post(wav(30)); assert.equal(r.json().error, "audio_too_long"); ok("zu lang abgelehnt");
r = await post(Buffer.from("RIFFxxxxWAVEjunkjunkjunkjunkjunkjunkjunkjunkjunk")); assert.equal(r.json().error, "audio_invalid"); ok("kaputte Datei abgelehnt");
r = await post(JSON.stringify({ a: 1 }), "application/json"); assert.equal(r.statusCode, 415); ok("JSON statt Audio abgelehnt");
r = await app.inject({ method: "POST", url: "/api/stt", headers: { "content-type": "audio/wav" }, payload: wav(2) }); assert.equal(r.statusCode, 401); ok("ohne Login abgelehnt");
const rows = (await db2.query("select * from stt_requests")).rows;
assert.equal(rows.length, 2); assert.ok(!("text" in rows[0])); ok("Protokoll ohne Text und Audio");
assert.equal((await budgetStatus(db2, config)).reservedEur, 0); ok("Budget-Belegung wieder frei");

await db2.query("insert into budget_months (month, spent_eur) values (date_trunc('month', now() at time zone 'Europe/Berlin')::date, 20) on conflict (month) do update set spent_eur = 20");
r = await post(wav(4)); assert.equal(r.json().error, "budget_exhausted"); ok("Monatslimit erreicht → keine Spracherkennung");
await db2.query("update budget_months set spent_eur = 0");

let hits = 0;
for (let i = 0; i < 20; i++) { const x = await post(wav(1)); if (x.statusCode === 429) hits++; }
assert.ok(hits > 0); ok(`Rate-Limit pro Nutzer greift (${hits}× 429)`);
await app.close();

// Mistral-Adapter: Anfrage-Aufbau prüfen, ohne echten Aufruf
const realFetch = globalThis.fetch;
let seen: { url: string; auth: string; fields: Record<string, string>; fileType: string } | null = null;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const f = init.body as FormData; const fields: Record<string, string> = {}; let fileType = "";
  for (const [key, v] of f.entries()) { if (typeof v === "string") fields[key] = v; else fileType = `${v.type}:${v.size}`; }
  seen = { url, auth: (init.headers as Record<string, string>).authorization, fields, fileType };
  return new Response(JSON.stringify({ model: "voxtral-mini-2602", text: " Hallo Welt ", language: "de", usage: { prompt_audio_seconds: 3 } }), { status: 200 });
}) as typeof fetch;
const res = await new MistralStt("sk-test", "voxtral-mini-latest").transcribe(wav(3), { mimeType: "audio/wav", language: "de", seconds: 3 });
assert.equal(seen!.url, "https://api.mistral.ai/v1/audio/transcriptions"); assert.equal(seen!.auth, "Bearer sk-test");
assert.deepEqual(seen!.fields, { model: "voxtral-mini-latest", language: "de" }); assert.equal(seen!.fileType, `audio/wav:${wav(3).length}`);
assert.equal(res.text, "Hallo Welt"); assert.equal(res.billedSeconds, 3); ok("Mistral-Anfrage korrekt aufgebaut");
globalThis.fetch = (async () => new Response('{"message":"Unauthorized"}', { status: 401 })) as typeof fetch;
await assert.rejects(new MistralStt("bad", "m").transcribe(wav(1), { mimeType: "audio/wav", seconds: 1 }), /401/); ok("Mistral-Fehler wird gemeldet");
globalThis.fetch = realFetch;
console.log("ALLE TESTS OK");
