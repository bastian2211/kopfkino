import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_SECONDS = 20;

// Reihenfolge = Vorliebe. iOS Safari nimmt zuverlässig audio/mp4 (AAC) auf.
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
};

export type RecorderError = "unsupported" | "denied" | "nodevice" | "empty" | "unknown";
export type RecorderState = "idle" | "starting" | "recording" | "stopping";

export function useRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<RecorderError | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const counterRef = useRef(0);

  // Mikrofon komplett freigeben. Wichtig auf iOS: hängende Tracks blockieren die nächste Aufnahme.
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      setState("stopping");
      rec.stop();
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("unsupported");
      return;
    }
    setState("starting");
    try {
      // Jedes Mal ein frischer Stream – nie einen alten wiederverwenden.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const seconds = Math.round((performance.now() - startedAtRef.current) / 100) / 10;
        const type = rec.mimeType || mimeType || "audio/mp4";
        const blob = new Blob(chunksRef.current, { type });
        releaseStream();
        recorderRef.current = null;
        setState("idle");
        if (blob.size === 0) {
          setError("empty");
          return;
        }
        counterRef.current += 1;
        setRecording((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return {
            url: URL.createObjectURL(blob),
            blob,
            mimeType: type,
            bytes: blob.size,
            seconds,
            number: counterRef.current,
          };
        });
      };

      startedAtRef.current = performance.now();
      setElapsed(0);
      // Zeitscheiben, damit bei einem Abbruch nicht alles verloren ist
      rec.start(500);
      setState("recording");
      tickRef.current = window.setInterval(() => {
        const s = (performance.now() - startedAtRef.current) / 1000;
        setElapsed(s);
        if (s >= MAX_SECONDS) stop();
      }, 200);
    } catch (err) {
      releaseStream();
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
  }, [releaseStream, stop]);

  // Beim Verlassen der Seite oder Wechsel in den Hintergrund sauber beenden
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
      releaseStream();
    };
  }, [releaseStream, stop]);

  return { state, elapsed, recording, error, start, stop };
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
