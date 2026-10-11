# Baut die PWA und liefert sie über Caddy aus (Caddy ist zugleich Reverse-Proxy für /api).
# Build-Kontext: Repo-Wurzel
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root=false
COPY apps/web apps/web
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN npm run build -w apps/web

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
