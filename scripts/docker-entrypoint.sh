#!/bin/sh
set -e

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"

echo "[entrypoint] Aguardando Postgres em ${DB_HOST}:${DB_PORT}..."
i=0
while [ "$i" -lt 60 ]; do
  if node -e "
    const n = require('net');
    const h = process.env.DB_HOST || 'postgres';
    const p = parseInt(process.env.DB_PORT || '5432', 10);
    const c = n.createConnection({ host: h, port: p }, () => { c.end(); process.exit(0); });
    c.on('error', () => process.exit(1));
    c.setTimeout(3000, () => { c.destroy(); process.exit(1); });
  " 2>/dev/null; then
    echo "[entrypoint] Postgres aceita conexões."
    break
  fi
  i=$((i + 1))
  echo "[entrypoint] tentativa $i/60..."
  sleep 2
done
if [ "$i" -eq 60 ]; then
  echo "[entrypoint] ERRO: Postgres não respondeu a tempo em ${DB_HOST}:${DB_PORT}"
  exit 1
fi

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
