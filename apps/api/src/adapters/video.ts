// VideoProvider-Adapter: startet eine Video-Erzeugung, fragt den Stand ab, lädt das Ergebnis herunter.
// Austauschbar – der Worker kennt nur dieses Interface.
import { createWriteStream } from "node:fs";
import { rename, rm, writeFile, copyFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.js";

export type PollResult =
  | { state: "running" }
  | { state: "done"; videoUri: string }
  | { state: "failed"; code: "filtered" | "provider_error"; detail: string };

export interface VideoProvider {
  readonly name: string;
  readonly model: string;
  start(prompt: string, opts: { seconds: number }): Promise<{ operation: string }>;
  poll(operation: string): Promise<PollResult>;
  // Lädt das Video in eine Datei; gibt die Größe in Bytes zurück
  download(videoUri: string, targetPath: string): Promise<number>;
}

const MAX_BYTES = 100 * 1024 * 1024;

// Google Veo über die Gemini API (Long-Running Operation)
// Doku: https://ai.google.dev/gemini-api/docs/veo
export class VeoProvider implements VideoProvider {
  readonly name = "veo";
  private base = "https://generativelanguage.googleapis.com/v1beta";
  constructor(
    private apiKey: string,
    readonly model: string,
  ) {}

  private headers() {
    return { "x-goog-api-key": this.apiKey, "content-type": "application/json" };
  }

  async start(prompt: string, opts: { seconds: number }): Promise<{ operation: string }> {
    const res = await fetch(`${this.base}/models/${this.model}:predictLongRunning`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        instances: [{ prompt }],
        // Hochkant, 720p. personGeneration lassen wir bewusst weg (Standard des Dienstes),
        // weil die Doku für EU-Standorte andere Werte erlaubt als für Text-zu-Video.
        parameters: { aspectRatio: "9:16", resolution: "720p", durationSeconds: opts.seconds },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Veo-Start ${res.status}: ${text.slice(0, 400)}`);
    const data = JSON.parse(text) as { name?: string };
    if (!data.name) throw new Error("Veo-Start: keine Operation in der Antwort");
    return { operation: data.name };
  }

  async poll(operation: string): Promise<PollResult> {
    const res = await fetch(`${this.base}/${operation}`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Veo-Status ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text) as {
      done?: boolean;
      error?: { code?: number; message?: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: { video?: { uri?: string } }[];
          raiMediaFilteredCount?: number;
          raiMediaFilteredReasons?: string[];
        };
      };
    };
    if (!data.done) return { state: "running" };
    if (data.error) {
      return { state: "failed", code: "provider_error", detail: `${data.error.code ?? ""} ${data.error.message ?? ""}`.trim() };
    }
    const r = data.response?.generateVideoResponse;
    const uri = r?.generatedSamples?.[0]?.video?.uri;
    if (uri) return { state: "done", videoUri: uri };
    // Kein Video: meist vom Sicherheitsfilter des Anbieters blockiert (laut Doku dann nicht berechnet)
    return {
      state: "failed",
      code: "filtered",
      detail: (r?.raiMediaFilteredReasons ?? []).join("; ").slice(0, 500) || "kein Video in der Antwort",
    };
  }

  async download(videoUri: string, targetPath: string): Promise<number> {
    const res = await fetch(videoUri, {
      headers: { "x-goog-api-key": this.apiKey },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) throw new Error(`Veo-Download ${res.status}`);
    return writeLimited(Readable.fromWeb(res.body as never), targetPath);
  }
}

// Schreibt erst in eine .part-Datei und benennt dann um – halbe Dateien gibt es so nie
async function writeLimited(source: Readable, targetPath: string): Promise<number> {
  const tmp = `${targetPath}.part`;
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) cb(new Error("Video zu groß"));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(source, limiter, createWriteStream(tmp));
    await rename(tmp, targetPath);
    return bytes;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// Lokaler Ersatz: „fertig“ nach ein paar Abfragen, kopiert ein Testvideo (falls vorhanden)
export class FakeVideoProvider implements VideoProvider {
  readonly name = "fake";
  readonly model = "fake";
  private polls = new Map<string, number>();
  constructor(
    private sample?: string,
    private outcome: "done" | "filtered" | "error" = "done",
  ) {}
  async start(prompt: string): Promise<{ operation: string }> {
    if (/STARTFEHLER/.test(prompt)) throw new Error("Fake-Startfehler");
    const op = `operations/fake-${Math.random().toString(36).slice(2)}`;
    this.polls.set(op, 0);
    return { operation: op };
  }
  async poll(operation: string): Promise<PollResult> {
    const n = (this.polls.get(operation) ?? 0) + 1;
    this.polls.set(operation, n);
    if (n < 2) return { state: "running" };
    if (this.outcome === "filtered") return { state: "failed", code: "filtered", detail: "test filter" };
    if (this.outcome === "error") return { state: "failed", code: "provider_error", detail: "test error" };
    return { state: "done", videoUri: "fake://video" };
  }
  async download(_uri: string, targetPath: string): Promise<number> {
    if (this.sample) {
      await copyFile(this.sample, targetPath);
    } else {
      await writeFile(targetPath, Buffer.from("FAKEMP4"));
    }
    const { size } = await import("node:fs/promises").then((m) => m.stat(targetPath));
    return size;
  }
}

export function createVideoProvider(config: Config, sample?: string): VideoProvider | null {
  if (config.GEMINI_API_KEY) return new VeoProvider(config.GEMINI_API_KEY, config.VIDEO_MODEL);
  return config.NODE_ENV === "production" ? null : new FakeVideoProvider(sample);
}
