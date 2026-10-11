import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_SECONDS = 20;
// So lange bleibt das Mikrofon nach einer Aufnahme offen (iOS mag schnelles Schließen/Öffnen nicht)
const IDLE_RELEASE_MS = 30_000;

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
  // Diagnose
  chunks: number;
  streamReused: boolean;
  trackMuted: boolean;
  trackEnded: boolean;
};

export type RecorderError = "unsupported" | "denied" | "nodevice" | "empty" | "unknown";
export type RecorderState = "idle" | "starting" | "recording" | "stopping";

function streamIsUsable(s: MediaStream | null): s is MediaStream {
  return !!s && s.getAudioTracks().length > 0 && s.getAudioTracks().every((t) => t.readyState === "live" && !t.muted);
}

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
  const idleTimerRef = useRef<number | null>(null);
  const counterRef = useRef(0);
  const diagRef = useRef({ reused: false, muted: false, ended: false });

  const clearTick = () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const clearIdleTimer = () => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  // Mikrofon komplett freigeben (orangener Punkt in der Statusleiste verschwindet)
  const releaseStream = useCallback(() => {
    clearIdleTimer();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      setState("stopping");
      rec.stop();
    }
  }, []);

  const getStream = async (): Promise<{ stream: MediaStream; reused: boolean }> => {
    if (streamIsUsable(streamRef.current)) return { stream: streamRef.current, reused: true };
    releaseStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    streamRef.current = stream;
    return { stream, reused: false };
  };

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("unsupported");
      return;
    }
    clearIdleTimer();
    setState("starting");
    try {
      const { stream, reused } = await getStream();
      diagRef.current = { reused, muted: false, ended: false };
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onmute = () => (diagRef.current.muted = true);
        track.onended = () => (diagRef.current.ended = true);
      }

      const mimeType = pickMimeType();
      // Für jede Aufnahme ein neuer MediaRecorder, aber derselbe Mikrofon-Stream
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        clearTick();
        const seconds = Math.round((performance.now() - startedAtRef.current) / 100) / 10;
        const type = rec.mimeType || mimeType || "audio/mp4";
        const blob = new Blob(chunksRef.current, { type });
        recorderRef.current = null;
        setState("idle");
        // Mikrofon nach einer Pause freigeben statt sofort
        clearIdleTimer();
        idleTimerRef.current = window.setTimeout(releaseStream, IDLE_RELEASE_MS);
        if (blob.size === 0) {
          setError("empty");
          return;
        }
        counterRef.current += 1;
        const d = diagRef.current;
        setRecording((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return {
            url: URL.createObjectURL(blob),
            blob,
            mimeType: type,
            bytes: blob.size,
            seconds,
            number: counterRef.current,
            chunks: chunksRef.current.length,
            streamReused: d.reused,
            trackMuted: d.muted,
            trackEnded: d.ended,
          };
        });
      };

      startedAtRef.current = performance.now();
      setElapsed(0);
      // Am Stück aufnehmen (keine Zeitscheiben): iOS-MP4-Stücke lassen sich nicht immer sauber zusammensetzen
      rec.start();
      setState("recording");
      tickRef.current = window.setInterval(() => {
        const s = (performance.now() - startedAtRef.current) / 1000;
        setElapsed(s);
        if (s >= MAX_SECONDS) stop();
      }, 200);
    } catch (err) {
      releaseStream();
      clearTick();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releaseStream, stop]);

  // App im Hintergrund: Aufnahme beenden und Mikrofon sofort freigeben
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        releaseStream();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      clearTick();
      releaseStream();
    };
  }, [releaseStream, stop]);

  return { state, elapsed, recording, error, start, stop };
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
