// Kleiner Wrapper um fetch: immer mit Session-Cookie, JSON rein/raus, Fehler als Code.
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      cache: "no-store",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("network", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) {
    const code = res.status === 429 ? "rate_limited" : typeof data.error === "string" ? data.error : "unknown";
    throw new ApiError(code, res.status);
  }
  return data as T;
}

export type Me = { id: string; username: string; displayName: string; role: "user" | "admin"; locale: "de" | "en" };

export function errorCode(err: unknown): string {
  return err instanceof ApiError ? err.code : "unknown";
}
