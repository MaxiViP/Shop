#!/usr/bin/env bash
set -euo pipefail
umask 027

services_stopped=0

recover() {
  local status=$?
  trap - EXIT
  if (( status != 0 && services_stopped )); then
    printf 'Deployment failed (exit %s) after stopping services; attempting recovery.\n' "$status" >&2
    local service
    for service in shop-api.service shop-web.service; do
      if systemctl restart "$service"; then
        printf 'Recovery: restarted %s.\n' "$service" >&2
      else
        printf 'Recovery: failed to restart %s; manual intervention required.\n' "$service" >&2
      fi
    done
  fi
  exit "$status"
}

fail() { printf '%s\n' "$*" >&2; exit 1; }

as_shop() {
  runuser -u shop -- env -i HOME=/home/shop PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
}

clean_tree() {
  local state
  state=$(as_shop git status --porcelain --untracked-files=all) || fail 'Cannot read Git status.'
  [[ -z $state ]] || fail 'Dirty working tree; deployment stopped. Inspect files without discarding them.'
}

prisma() {
  # Load secrets as data, without sourcing shell code or putting a URL in argv.
  as_shop /usr/bin/node --env-file=/etc/korzinamarket/api.env \
    apps/api/node_modules/prisma/build/index.js "$@" \
    --config apps/api/prisma7.config.ts
}

health() {
  curl --fail --silent --show-error --retry 10 --retry-connrefused \
    --retry-delay 2 --max-time 10 "$@" >/dev/null
}

# Keep the body parsed in memory before git pull can update this script.
main() {
  [[ $EUID -eq 0 ]] || fail 'Run: sudo bash /opt/korzinamarket/deploy/deploy.sh'
  cd /opt/korzinamarket
  exec 9>/run/lock/korzinamarket-deploy.lock
  flock -n 9 || fail 'Another deployment is running.'

  [[ $(as_shop git rev-parse --show-toplevel) == /opt/korzinamarket ]] || fail 'Wrong repository.'
  [[ $(as_shop git branch --show-current) == main ]] || fail 'The server must already be on main.'
  clean_tree
  [[ $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 24 ]] || fail 'Node.js 24 is required at /usr/bin/node.'

  as_shop /usr/bin/node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const api = parseEnv(readFileSync('/etc/korzinamarket/api.env', 'utf8'));
const web = parseEnv(readFileSync('/etc/korzinamarket/web.env', 'utf8'));
for (const key of ['DATABASE_URL', 'AUTH_SECRET', 'ADMIN_PHONE', 'ADMIN_PASSWORD']) {
  if (!api[key]?.trim()) throw new Error(`api.env: ${key} is required`);
}
for (const [key, value] of Object.entries({
  NODE_ENV: 'production', PORT: '4001',
  CORS_ORIGINS: 'https://korzinamarket.ru',
  TRUST_PROXY: '127.0.0.1/32,::1/128',
  UPLOAD_DIR: '/var/lib/korzinamarket/uploads/products',
})) {
  if (api[key] !== value) throw new Error(`api.env: check ${key}`);
}
for (const [key, value] of Object.entries({
  NODE_ENV: 'production',
  NUXT_PUBLIC_API_BASE: 'https://korzinamarket.ru/api',
  NUXT_PUBLIC_SITE_URL: 'https://korzinamarket.ru',
})) {
  if (web[key] !== value) throw new Error(`web.env: check ${key}`);
}
// Reject an invalid URL without including its contents in an exception.
let database;
try { database = new URL(api.DATABASE_URL); } catch { throw new Error('api.env: invalid DATABASE_URL'); }
if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
    database.hostname !== '127.0.0.1' || database.port !== '5432') {
  throw new Error('api.env: DATABASE_URL must use PostgreSQL at 127.0.0.1:5432');
}
NODE

  as_shop git fetch origin main
  as_shop git merge-base --is-ancestor HEAD origin/main || fail 'Local main has commits outside origin/main.'
  as_shop git pull --ff-only origin main

  install -d -o shop -g shop -m 0750 /var/lib/korzinamarket/uploads/products
  install -m 0644 deploy/shop-api.service deploy/shop-web.service /etc/systemd/system/
  systemctl daemon-reload
  # In-place builds replace live output: use a maintenance window.
  systemctl stop shop-web.service
  services_stopped=1
  systemctl stop shop-api.service

  corepack enable
  as_shop pnpm install --frozen-lockfile --prod=false
  prisma generate --no-hints
  as_shop pnpm build
  # Build first: a build failure must not advance the database schema.
  prisma migrate deploy

  clean_tree
  systemctl enable shop-api.service shop-web.service
  systemctl restart shop-api.service
  health http://127.0.0.1:4001/api/health
  systemctl restart shop-web.service
  health --head http://127.0.0.1:3000
  health https://korzinamarket.ru/api/health
  health --head https://korzinamarket.ru
  printf 'Deployment healthy: '
  as_shop git log -1 --oneline
}

trap recover EXIT
main "$@"
