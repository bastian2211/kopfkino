import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_SECONDS = 20;
const WAV_SAMPLE_RATE = 16_000; // reicht für Spracherkennung, hält die Datei klein

// ---------------------------------------------------------------------------
// Aufnahmemethode (im Technik-Test umschaltbar, wird im Browser gemerkt)
// ---------------------------------------------------------------------------
export type Engine = "mediarecorder" | "wav";
const ENGINE_KEY = "kopfkino.recEngine";

export function loadEngine(): Engine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "wav" ? "wav" : "mediarecorder";
  } catch {
    return "mediarecorder";
  }
}

export function saveEngine(e: Engine): void {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {
    /* egal */
  }
}

// Reihenfolge = Vorliebe. iOS Safari nimmt audio/mp4 (AAC) auf.
const CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

export type Recording = {
  url: string;
  blob: Blob;
  mimeType: string;
  bytes: number;
  seconds: number;
  number: number;
  engine: Engine;
  // Diagnose
  chunks: number;
  trackMuted: boolean;
  trackEnded: boolean;
};

export type RecorderError = "unsupported" | "denied" | "nodevice" | "empty" | "unknown";
export type RecorderState = "idle" | "starting" | "recording" | "stopping";

// Ein laufender Aufnahmevorgang, egal mit welcher Methode
type Session = {
  stop: () => void;
  abort: () => void;
};

type Finished = { blob: Blob; mimeType: string; chunks: number };

// ---------------------------------------------------------------------------
// Methode 1: MediaRecorder – Mikrofon pro Aufnahme frisch, Aufnahme am Stück
// ---------------------------------------------------------------------------
function startMediaRecorder(stream: MediaStream, onDone: (f: Finished) => void): Session {
  const mimeType = pickMimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = () => {
    const type = rec.mimeType || mimeType || "audio/mp4";
    onDone({ blob: new Blob(chunks, { type }), mimeType: type, chunks: chunks.length });
  };
  rec.start();
  return {
    stop: () => rec.state !== "inactive" && rec.stop(),
    abort: () => {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Methode 2: WAV über Web Audio – rohe Samples einsammeln und selbst kodieren
// ---------------------------------------------------------------------------
type AudioCtxCtor = typeof AudioContext;

function startWav(stream: MediaStream, ctx: AudioContext, onDone: (f: Finished) => void): Session {
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor ist alt, läuft aber auf allen iOS-Versionen verlässlich
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const buffers: Float32Array[] = [];
  processor.onaudioprocess = (e) => {
    buffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  // Muss mit dem Ausgang verbunden sein, damit onaudioprocess feuert; der Ausgang bleibt stumm
  processor.connect(ctx.destination);

  const teardown = () => {
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
    } catch {
      /* schon getrennt */
    }
  };

  return {
    stop: () => {
      teardown();
      const samples = downsample(concat(buffers), ctx.sampleRate, WAV_SAMPLE_RATE);
      const blob = encodeWav(samples, WAV_SAMPLE_RATE);
      onDone({ blob, mimeType: "audio/wav", chunks: buffers.length });
    },
    abort: teardown,
  };
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Einfaches Heruntertakten durch Mittelwertbildung (genug für Sprache)
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

// 16-Bit-PCM-WAV, mono
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // Größe des fmt-Blocks
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Bytes pro Sekunde
  view.setUint16(32, 2, true); // Block-Ausrichtung
  view.setUint16(34, 16, true); // Bits pro Sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// React-Hook: gemeinsame Steuerung für beide Methoden
// ---------------------------------------------------------------------------
export function useRecorder(engine: Engine) {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<RecorderError | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const counterRef = useRef(0);
  const diagRef = useRef({ muted: false, ended: false });

  const clearTick = () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  // Mikrofon und Audio-Kontext vollständig freigeben
  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    if (sessionRef.current) {
      setState("stopping");
      sessionRef.current.stop();
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("unsupported");
      return;
    }
    const W = window as Window & { webkitAudioContext?: AudioCtxCtor };
    const Ctx: AudioCtxCtor | undefined = window.AudioContext ?? W.webkitAudioContext;
    if (engine === "mediarecorder" ? typeof MediaRecorder === "undefined" : !Ctx) {
      setError("unsupported");
      return;
    }
    setState("starting");

    // Audio-Kontext SOFORT im Tipp anlegen – iOS erlaubt das nur direkt nach einer Nutzergeste
    if (engine === "wav" && Ctx) {
      ctxRef.current = new Ctx();
      void ctxRef.current.resume();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      diagRef.current = { muted: false, ended: false };
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onmute = () => (diagRef.current.muted = true);
        track.onended = () => (diagRef.current.ended = true);
      }

      const onDone = (f: Finished) => {
        clearTick();
        sessionRef.current = null;
        const seconds = Math.round((performance.now() - startedAtRef.current) / 100) / 10;
        release();
        setState("idle");
        // WAV ohne Samples = 44 Byte Kopf
        if (f.blob.size <= 44) {
          setError("empty");
          return;
        }
        counterRef.current += 1;
        const d = diagRef.current;
        setRecording((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return {
            url: URL.createObjectURL(f.blob),
            blob: f.blob,
            mimeType: f.mimeType,
            bytes: f.blob.size,
            seconds,
            number: counterRef.current,
            engine,
            chunks: f.chunks,
            trackMuted: d.muted,
            trackEnded: d.ended,
          };
        });
      };

      sessionRef.current =
        engine === "wav" && ctxRef.current
          ? startWav(stream, ctxRef.current, onDone)
          : startMediaRecorder(stream, onDone);

      startedAtRef.current = performance.now();
      setElapsed(0);
      setState("recording");
      tickRef.current = window.setInterval(() => {
        const s = (performance.now() - startedAtRef.current) / 1000;
        setElapsed(s);
        if (s >= MAX_SECONDS) stop();
      }, 200);
    } catch (err) {
      sessionRef.current = null;
      clearTick();
      release();
      setState("idle");
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "denied"
          : name === "NotFoundError"
            ? "nodevice"
            : "unknown",
      );
    }
  }, [engine, release, stop]);

  // App im Hintergrund: Aufnahme regulär beenden (Datei bleibt erhalten)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      sessionRef.current?.abort();
      sessionRef.current = null;
      clearTick();
      release();
    };
  }, [release, stop]);

  return { state, elapsed, recording, error, start, stop };
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
