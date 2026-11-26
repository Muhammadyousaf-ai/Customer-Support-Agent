#!/usr/bin/env bash
# Runs on the host in /opt/support-ai after CI streamed the API image into `docker load` and copied the compose file.
set -euo pipefail
cd /opt/support-ai
docker compose pull --quiet db caddy
docker compose up -d --wait db
docker compose run --rm --no-deps api node dist/database/migrate.js
if [ ! -f .seeded ]; then
  docker compose run --rm --no-deps api node dist/database/seed.js
  docker compose run --rm --no-deps api node dist/rag/cli/ingest.js
  touch .seeded
fi
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
host=$(grep '^API_HOST=' .env | cut -d= -f2)
ok=""
for _ in $(seq 60); do curl -fsS --resolve "$host:443:127.0.0.1" "https://$host/v1/health/ready" >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done
[ -n "$ok" ] || { docker compose ps; docker compose logs --tail 40 api caddy; exit 1; }
echo "api: https://$host/v1 (NEXT_PUBLIC_API_URL on Vercel)"
