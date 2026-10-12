// Integrationstest Video-Aufträge gegen eine LOKALE Wegwerf-Datenbank. Löscht dort alles!
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createPool, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { FakeVideoProvider, VeoProvider } from "../src/adapters/video.ts";
import { createVideoWorker } from "../src/video-worker.ts";
import { jobRoutes } from "../src/routes/jobs.ts";
import { adminBooking, balanceOf, budgetStatus } from "../src/ledger.ts";

const dir = await mkdtemp(path.join(os.tmpdir(), "kk-videos-"));
const config = { ...loadConfig(), VIDEO_DIR: dir };
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(config.DATABASE_URL)) throw new Error("Nur gegen eine lokale Test-Datenbank ausführen!");
const db = createPool(config.DATABASE_URL);
await db.query("drop schema public cascade; create schema public;");
await migrate(db, () => {});
const mkUser = async (n: string) => (await db.query("insert into users (username, display_name, password_hash, adult_confirmed_at) values ($1,$1,'x',now()) returning id", [n])).rows[0].id as string;
const uid = await mkUser("tester"); const other = await mkUser("other");
await adminBooking(db, { userId: uid, kind: "topup", credits: 100, adminId: uid, key: crypto.randomUUID() });
const mkScene = async (user = uid, prompt = "Vertical video of a dog", status = "ok") =>
  (await db.query("insert into scenes (user_id, idea, lang, status, scene) values ($1,'idee','de',$2,$3) returning id",
    [user, status, JSON.stringify({ title: "Skater-Hund", video_prompt: prompt })])).rows[0].id as string;
let k = 0; const ok = (m: string) => console.log(`✓ ${++k} ${m}`);
const log = { info() {}, warn() {}, error() {} };
const sample = path.resolve("../web/public/test/kopfkino-test.mp4");

class PaidFake extends FakeVideoProvider { override readonly name = "test"; }
const pushes: string[] = [];
async function setup(provider = new PaidFake(sample)) {
  const worker = createVideoWorker({ db, config, provider, log, notify: async (_u, p) => { pushes.push(p.body); } });
  const app = Fastify();
  await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
  let as = uid;
  app.addHook("onRequest", async (req) => { req.user = { id: as, username: "t", displayName: "T", role: "user", locale: "de", sessionId: "s" } as never; });
  jobRoutes(app, db, config, provider, worker);
  return { app, worker, actAs: (u: string) => { as = u; } };
}

let { app, worker, actAs } = await setup();
const sceneId = await mkScene();
const key = crypto.randomUUID();
let r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId, key } });
assert.equal(r.statusCode, 201, r.body); const job = r.json();
assert.ok(["queued", "running"].includes(job.status)); assert.equal(job.credits, 34); assert.equal(await balanceOf(db, uid), 66); ok("Auftrag angelegt, 34 Credits reserviert");
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId, key } });
assert.equal(r.json().id, job.id); assert.equal(await balanceOf(db, uid), 66); ok("Doppelt tippen → derselbe Auftrag, nur einmal reserviert");
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId, key: crypto.randomUUID() } });
assert.equal(r.json().error, "job_running"); ok("Nur ein Video gleichzeitig pro Nutzer");

await worker.tick();
assert.equal((await db.query("select status, operation from video_jobs where id=$1", [job.id])).rows[0].status, "running");
await worker.tick(); await worker.tick();
r = await app.inject({ method: "GET", url: `/api/jobs/${job.id}` });
assert.equal(r.json().status, "done"); assert.equal(r.json().videoUrl, `/api/videos/${job.id}.mp4`);
assert.equal(await balanceOf(db, uid), 66); assert.ok(pushes.includes("Dein Video ist fertig!"));
const b = await budgetStatus(db, config); assert.equal(b.reservedEur, 0); assert.ok(Math.abs(b.spentEur - 0.3 / 1.15) < 1e-4);
ok("Worker: queued → running → done, 34 Credits abgebucht, 0,26 € zum Budget, Push verschickt");

const full = await readFile(sample);
r = await app.inject({ method: "GET", url: `/api/videos/${job.id}.mp4` });
assert.equal(r.statusCode, 200); assert.equal(r.rawPayload.length, full.length); assert.equal(r.headers["content-type"], "video/mp4");
r = await app.inject({ method: "GET", url: `/api/videos/${job.id}.mp4`, headers: { range: "bytes=0-99" } });
assert.equal(r.statusCode, 206); assert.equal(r.rawPayload.length, 100); assert.equal(r.headers["content-range"], `bytes 0-99/${full.length}`);
r = await app.inject({ method: "GET", url: `/api/videos/${job.id}.mp4`, headers: { range: "bytes=-10" } });
assert.equal(r.statusCode, 206); assert.equal(r.rawPayload.length, 10); ok("Video-Ausgabe mit Range (für iOS)");
actAs(other);
r = await app.inject({ method: "GET", url: `/api/videos/${job.id}.mp4` }); assert.equal(r.statusCode, 404);
r = await app.inject({ method: "GET", url: `/api/jobs/${job.id}` }); assert.equal(r.statusCode, 404);
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId, key: crypto.randomUUID() } }); assert.equal(r.statusCode, 404);
actAs(uid); ok("Fremde sehen weder Auftrag noch Video und können keine fremde Szene nutzen");
r = await app.inject({ method: "GET", url: "/api/jobs" }); assert.equal(r.json().jobs.length, 1); assert.equal(r.json().videoCredits, 34); ok("Liste meiner Videos");

r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId: await mkScene(uid, "x", "rejected"), key: crypto.randomUUID() } });
assert.equal(r.json().error, "scene_not_ok"); ok("Abgelehnte Szene kann kein Video werden");

// Sicherheitsfilter des Anbieters → Erstattung
({ app, worker } = await setup(new PaidFake(sample, "filtered")));
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId: await mkScene(), key: crypto.randomUUID() } });
const fj = r.json().id; assert.equal(await balanceOf(db, uid), 32);
for (let i = 0; i < 3; i++) await worker.tick();
r = await app.inject({ method: "GET", url: `/api/jobs/${fj}` });
assert.equal(r.json().status, "failed"); assert.equal(r.json().errorCode, "filtered"); assert.equal(r.json().credits, 0);
assert.equal(await balanceOf(db, uid), 66); assert.ok(pushes.some((p) => /nicht geklappt/.test(p))); ok("Vom Anbieter blockiert → alle Credits zurück, Push");

// Startfehler
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId: await mkScene(uid, "STARTFEHLER"), key: crypto.randomUUID() } });
const sj = r.json().id; await worker.tick();
assert.equal((await db.query("select status, error_code from video_jobs where id=$1", [sj])).rows[0].error_code, "start_failed");
assert.equal(await balanceOf(db, uid), 66); ok("Startfehler → erstattet");

// Zeitüberschreitung
({ app, worker } = await setup(new PaidFake(sample)));
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId: await mkScene(), key: crypto.randomUUID() } });
const tj = r.json().id; await worker.tick();
await db.query("update video_jobs set started_at = now() - interval '20 minutes', operation = 'operations/haengt' where id = $1", [tj]);
await worker.tick();
assert.equal((await db.query("select error_code from video_jobs where id=$1", [tj])).rows[0].error_code, "timeout");
assert.equal(await balanceOf(db, uid), 66); ok("Hängt zu lange → abgebrochen und erstattet");

// Zu wenig Guthaben / Budget
await adminBooking(db, { userId: uid, kind: "adjust", credits: -50, adminId: uid, key: crypto.randomUUID() });
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId: await mkScene(), key: crypto.randomUUID() } });
assert.equal(r.json().error, "insufficient_credits"); ok("Zu wenig Guthaben → kein Auftrag");
await adminBooking(db, { userId: uid, kind: "topup", credits: 100, adminId: uid, key: crypto.randomUUID() });
await db.query("update budget_months set spent_eur = 19.9");
r = await app.inject({ method: "POST", url: "/api/jobs", payload: { sceneId: await mkScene(), key: crypto.randomUUID() } });
assert.equal(r.json().error, "budget_exhausted"); ok("Monatslimit erreicht → kein Video, egal wie viel Guthaben");
const st = (await db.query("select count(*) from ledger_entries where type='reserve'")).rows[0].count;
assert.equal(Number(st), 4); ok("Konsistenz: genau 4 Reservierungen gebucht");

// Veo-Adapter: Anfrageaufbau
const realFetch = globalThis.fetch; const calls: { url: string; init: RequestInit }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  if (url.endsWith(":predictLongRunning")) return new Response(JSON.stringify({ name: "models/veo-3.1-lite-generate-preview/operations/abc" }));
  if (url.endsWith("/operations/abc")) return new Response(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://example.test/file:download?alt=media" } }] } } }));
  if (url.endsWith("/operations/blocked")) return new Response(JSON.stringify({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["celebrity"] } } }));
  if (url.endsWith("/operations/err")) return new Response(JSON.stringify({ done: true, error: { code: 3, message: "bad" } }));
  if (url.endsWith("/operations/wait")) return new Response(JSON.stringify({ name: "x" }));
  return new Response(new Uint8Array([1, 2, 3, 4]));
}) as typeof fetch;
const veo = new VeoProvider("AIza-test", "veo-3.1-lite-generate-preview");
const { operation } = await veo.start("A dog", { seconds: 6 });
assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning");
assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "AIza-test");
assert.deepEqual(JSON.parse(calls[0].init.body as string), { instances: [{ prompt: "A dog" }], parameters: { aspectRatio: "9:16", resolution: "720p", durationSeconds: 6 } });
ok("Veo-Start korrekt (9:16, 720p, 6 s)");
const p = await veo.poll(operation);
assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-lite-generate-preview/operations/abc");
assert.deepEqual(p, { state: "done", videoUri: "https://example.test/file:download?alt=media" });
assert.deepEqual(await veo.poll("operations/wait"), { state: "running" });
assert.deepEqual(await veo.poll("operations/blocked"), { state: "failed", code: "filtered", detail: "celebrity" });
assert.equal((await veo.poll("operations/err")).state, "failed"); ok("Veo-Status: läuft / fertig / blockiert / Fehler");
const target = path.join(dir, "dl.mp4");
assert.equal(await veo.download("https://example.test/file:download?alt=media", target), 4);
assert.deepEqual([...(await readFile(target))], [1, 2, 3, 4]); ok("Veo-Download schreibt Datei");
globalThis.fetch = realFetch;
await worker.stop(); await db.end();
console.log("ALLE TESTS OK");
