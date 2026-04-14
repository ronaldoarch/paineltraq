#!/bin/sh
set -e

if [ "${SKIP_MIGRATIONS:-}" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true — pulando migrações"
else
  echo "[entrypoint] Executando migrações..."
  node migrations/run.js
fi

if [ "${RUN_SEED:-}" = "true" ]; then
  echo "[entrypoint] RUN_SEED=true — executando seed (admin + settings a partir do .env)"
  node migrations/seed.js
fi

exec node src/server.js
