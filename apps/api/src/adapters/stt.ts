// SpeechToText-Adapter: wandelt eine Sprachaufnahme in Text um.
// Austauschbar – die Route kennt nur dieses Interface, nicht den Anbieter.
import type { Config } from "../config.js";

export type SttResult = {
  text: string;
  language: string | null;
  // Vom Anbieter abgerechnete Audiodauer (falls gemeldet), sonst die eigene Messung
  billedSeconds: number;
  provider: string;
  model: string;
};

export interface SpeechToText {
  readonly name: string;
  transcribe(audio: Buffer, opts: { mimeType: string; language?: "de" | "en"; seconds: number }): Promise<SttResult>;
}

export class SttError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

// Mistral Voxtral – Doku: https://docs.mistral.ai/api/endpoint/audio/transcriptions
export class MistralStt implements SpeechToText {
  readonly name = "mistral";
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async transcribe(audio: Buffer, opts: { mimeType: string; language?: "de" | "en"; seconds: number }): Promise<SttResult> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("file", new Blob([new Uint8Array(audio)], { type: opts.mimeType }), "aufnahme.wav");
    // Sprache vorgeben erhöht laut Doku die Genauigkeit
    if (opts.language) form.append("language", opts.language);

    let res: Response;
    try {
      res = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new SttError(`Mistral nicht erreichbar: ${(err as Error).message}`);
    }
    if (!res.ok) {
      // Fehlertext kürzen; der Schlüssel steht nie darin
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new SttError(`Mistral antwortet ${res.status}: ${body}`, res.status);
    }
    const data = (await res.json()) as {
      text?: string;
      language?: string | null;
      model?: string;
      usage?: { prompt_audio_seconds?: number };
    };
    return {
      text: (data.text ?? "").trim(),
      language: data.language ?? null,
      billedSeconds: data.usage?.prompt_audio_seconds ?? opts.seconds,
      provider: this.name,
      model: data.model ?? this.model,
    };
  }
}

// Nur für lokale Entwicklung und Tests: kostet nichts, ruft niemanden auf.
export class FakeStt implements SpeechToText {
  readonly name = "fake";
  async transcribe(_audio: Buffer, opts: { language?: "de" | "en"; seconds: number }): Promise<SttResult> {
    const text =
      opts.language === "en"
        ? "A dog rides a skateboard through the office and high-fives the boss."
        : "Ein Hund fährt mit dem Skateboard durchs Büro und klatscht den Chef ab.";
    return { text, language: opts.language ?? "de", billedSeconds: opts.seconds, provider: this.name, model: "fake" };
  }
}

export function createStt(config: Config): SpeechToText | null {
  if (config.MISTRAL_API_KEY) return new MistralStt(config.MISTRAL_API_KEY, config.STT_MODEL);
  return config.NODE_ENV === "production" ? null : new FakeStt();
}

// ---- WAV prüfen ----
// Die App schickt 16-bit-PCM-WAV. Wir lesen nur den Kopf, um Format und Dauer zu prüfen.
export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; seconds: number };

export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let fmt: Omit<WavInfo, "seconds"> | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= buf.length) {
      const format = buf.readUInt16LE(body);
      if (format !== 1) return null; // nur unkomprimiertes PCM
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === "data" && fmt) {
      const bytes = Math.min(size, buf.length - body);
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      if (!bytesPerSecond) return null;
      return { ...fmt, seconds: bytes / bytesPerSecond };
    }
    offset = body + size + (size % 2);
  }
  return null;
}
