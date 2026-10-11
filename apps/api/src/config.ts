import { z } from "zod";

// Leere Werte aus docker-compose (${X:-}) wie "nicht gesetzt" behandeln
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

// Alle Einstellungen kommen aus Umgebungsvariablen (.env auf dem Server).
// Fehlt etwas Pflichtiges, startet die API nicht – lieber laut scheitern als still falsch laufen.
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  APP_VERSION: z.string().default("dev"),
  // Öffentliche Adresse der App – für Einladungslinks und die Herkunftsprüfung
  APP_URL: z.string().url().default("https://kopfkino.steinhose.de"),
  // Web Push (optional; ohne Schlüssel ist Push einfach deaktiviert)
  VAPID_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPID_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPID_SUBJECT: z.string().default("mailto:admin@steinhose.de"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Konfiguration: ${issues}`);
  }
  return parsed.data;
}
