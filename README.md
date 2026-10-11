# Kopfkino

*Gedacht. Eingesprochen. Gelacht.* – Sprachidee rein, kurzes KI-Video raus.

Stand: Schritt 1 des Fahrplans – installierbare PWA, API mit Health-Check, PostgreSQL, HTTPS über Caddy, Auto-Deploy bei Push auf `main`.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `apps/web` | PWA: React + Vite + TypeScript, `vite-plugin-pwa`, DE/EN |
| `apps/api` | API: Node.js + TypeScript + Fastify |
| `deploy/Caddyfile` | HTTPS, Auslieferung der PWA, Proxy `/api/*` → API |
| `docker-compose.yml` | Container `web` (Caddy + PWA), `api`, `db` (PostgreSQL) |
| `.github/workflows/deploy.yml` | Prüfen → Images bauen (GHCR) → per SSH deployen |

## Lokal entwickeln

```bash
npm install
docker run -d --name kopfkino-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres npm run dev:api
npm run dev:web   # http://localhost:5173, /api wird auf :3000 weitergeleitet
```

## Server einmalig einrichten (Hetzner)

1. Docker + Compose-Plugin installieren, Ports 80 und 443 (TCP + UDP) freigeben.
2. DNS-A-Record (und ggf. AAAA) der Domain auf den Server zeigen lassen.
3. Deploy-Benutzer anlegen, der Docker nutzen darf, und Verzeichnis anlegen:
   ```bash
   sudo mkdir -p /opt/kopfkino && sudo chown deploy:deploy /opt/kopfkino
   ```
4. `.env.example` als `/opt/kopfkino/.env` ablegen und ausfüllen (`chmod 600`).
5. Ein eigenes SSH-Schlüsselpaar nur für das Deployment erzeugen; öffentlichen Schlüssel beim Deploy-Benutzer in `authorized_keys` eintragen.

## GitHub einrichten

Repository → Settings → Environments → `production` anlegen, dort diese Secrets:

| Secret | Inhalt |
| --- | --- |
| `DEPLOY_HOST` | IP oder Hostname des Servers |
| `DEPLOY_USER` | Deploy-Benutzer, z. B. `deploy` |
| `DEPLOY_SSH_KEY` | privater Schlüssel des Deploy-Schlüsselpaars |
| `DEPLOY_KNOWN_HOSTS` | Ausgabe von `ssh-keyscan -t ed25519 <host>` |

API-Schlüssel (Gemini, Claude …) kommen **nie** ins Repo und nicht in GitHub, sondern nur in die `.env` auf dem Server.

## Prinzipien

Siehe Projektbrief: Einwilligung pro Video und Person, KI-Kennzeichnung, hartes Kostenlimit 20 €/Monat, Ledger nur mit Buchungen, Schlüssel nur serverseitig.
