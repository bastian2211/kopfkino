# Kopfkino

*Gedacht. Eingesprochen. Gelacht.* – Sprachidee rein, kurzes KI-Video raus.

Stand: Schritt 1 des Fahrplans – installierbare PWA, API mit Health-Check, PostgreSQL, hinter dem gemeinsamen Caddy des Servers, Auto-Deploy bei Push auf `main`.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `apps/web` | PWA: React + Vite + TypeScript, `vite-plugin-pwa`, DE/EN |
| `apps/api` | API: Node.js + TypeScript + Fastify |
| `deploy/Caddyfile` | interner Webserver: PWA ausliefern, `/api/*` → API (kein HTTPS, das macht der Eingang) |
| `docker-compose.yml` | Container `web` (Caddy + PWA), `api`, `db` (PostgreSQL); keine Ports nach außen |
| `.github/workflows/deploy.yml` | Prüfen → Images bauen (GHCR) → per SSH deployen |

## Lokal entwickeln

```bash
npm install
docker run -d --name kopfkino-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres npm run dev:api
npm run dev:web   # http://localhost:5173, /api wird auf :3000 weitergeleitet
```

## Server einmalig einrichten (Hetzner)

Auf dem Server läuft bereits der Caddy des Freundebuchs auf Port 80/443. Er ist der gemeinsame Eingang und macht HTTPS für alle Apps. Kopfkino hängt sich über das Docker-Netzwerk `edge` dahinter.

1. DNS-A-Record `kopfkino.steinhose.de` auf die Server-IP.
2. Gemeinsames Netzwerk anlegen (einmalig): `docker network create edge`
3. Freundebuch-Caddy ins Netzwerk `edge` hängen und dort diesen Eintrag ergänzen:
   ```
   kopfkino.steinhose.de {
   	reverse_proxy kopfkino-web:80
   }
   ```
4. Deploy-Benutzer anlegen, der Docker nutzen darf, und Verzeichnis anlegen:
   ```bash
   sudo mkdir -p /opt/kopfkino && sudo chown deploy:deploy /opt/kopfkino
   ```
5. `.env.example` als `/opt/kopfkino/.env` ablegen und ausfüllen (`chmod 600`).
6. Ein eigenes SSH-Schlüsselpaar nur für das Deployment erzeugen; öffentlichen Schlüssel beim Deploy-Benutzer in `authorized_keys` eintragen.

## GitHub einrichten

Repository → Settings → Environments → `production` anlegen, dort diese Secrets:

| Secret | Inhalt |
| --- | --- |
| `DEPLOY_HOST` | IP oder Hostname des Servers |
| `DEPLOY_USER` | Deploy-Benutzer, z. B. `deploy` |
| `DEPLOY_SSH_KEY` | privater Schlüssel des Deploy-Schlüsselpaars |
| `DEPLOY_KNOWN_HOSTS` | Ausgabe von `ssh-keyscan -t ed25519 <host>` |

Danach unter Settings → Secrets and variables → Actions → **Variables** die Variable `DEPLOY_ENABLED` mit Wert `true` anlegen. Vorher baut der Workflow nur die Images und deployt nicht.

API-Schlüssel (Gemini, Claude …) kommen **nie** ins Repo und nicht in GitHub, sondern nur in die `.env` auf dem Server.

## Prinzipien

Siehe Projektbrief: Einwilligung pro Video und Person, KI-Kennzeichnung, hartes Kostenlimit 20 €/Monat, Ledger nur mit Buchungen, Schlüssel nur serverseitig.
