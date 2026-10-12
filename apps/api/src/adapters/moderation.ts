// Moderation-Adapter: unabhängige zweite Prüfung von Texten vor jeder Generierung.
// Fällt der Dienst aus, wird NICHT durchgewunken (fail closed).
import type { Config } from "../config.js";

export type ModerationResult = {
  flagged: boolean;
  // Auffällige Kategorien, z. B. ["sexual/minors"]
  categories: string[];
  provider: string;
};

export interface Moderation {
  readonly name: string;
  check(texts: string[]): Promise<ModerationResult>;
}

// OpenAI omni-moderation – Doku: https://developers.openai.com/api/docs/guides/moderation
export class OpenAIModeration implements Moderation {
  readonly name = "openai";
  constructor(private apiKey: string) {}

  async check(texts: string[]): Promise<ModerationResult> {
    const input = texts.map((t) => t.trim()).filter(Boolean);
    if (input.length === 0) return { flagged: false, categories: [], provider: this.name };
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`OpenAI-Moderation antwortet ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { results?: { flagged: boolean; categories: Record<string, boolean> }[] };
    if (!data.results?.length) throw new Error("OpenAI-Moderation: leere Antwort");
    const categories = new Set<string>();
    for (const r of data.results) {
      for (const [cat, hit] of Object.entries(r.categories ?? {})) if (hit) categories.add(cat);
    }
    return { flagged: data.results.some((r) => r.flagged), categories: [...categories], provider: this.name };
  }
}

// Lokaler Ersatz: schlägt nur bei einem Testwort an
export class FakeModeration implements Moderation {
  readonly name = "fake";
  async check(texts: string[]): Promise<ModerationResult> {
    const flagged = texts.some((t) => /\bVERBOTEN\b/i.test(t));
    return { flagged, categories: flagged ? ["test"] : [], provider: this.name };
  }
}

export function createModeration(config: Config): Moderation | null {
  if (config.OPENAI_API_KEY) return new OpenAIModeration(config.OPENAI_API_KEY);
  return config.NODE_ENV === "production" ? null : new FakeModeration();
}
