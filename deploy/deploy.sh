#!/usr/bin/env bash
set -euo pipefail
umask 027

services_stopped=0
source_root=/opt/korzinamarket
release_root=/opt/korzinamarket-releases
previous_release=""
release_dir=""
previous_release_valid=0
units_changed=0
unit_backup_dir=""
unit_dir=/etc/systemd/system
cleanup_timer_active=0

recover() {
  local status=$?
  trap - EXIT
  local restored=1 unit
  if (( status != 0 && units_changed )); then
    for unit in shop-api.service shop-web.service shop-chat-cleanup.service shop-chat-cleanup.timer; do
      if [[ -f $unit_backup_dir/$unit ]]; then
        install -m 0644 "$unit_backup_dir/$unit" "$unit_dir/$unit" || restored=0
      else
        rm -f -- "$unit_dir/$unit" || restored=0
      fi
    done
    systemctl daemon-reload || restored=0
  fi
  if (( status != 0 && services_stopped )); then
    if [[ -n $previous_release ]] && (( previous_release_valid )); then
      switch_release "$previous_release" || restored=0
    else
      restored=0
    fi
    if (( restored )); then
      printf 'Deployment failed (exit %s); restored previous application release and attempting recovery.\n' "$status" >&2
      local service
      for service in shop-api.service shop-web.service; do
        if systemctl restart "$service"; then
          printf 'Recovery: restarted %s.\n' "$service" >&2
        else
          printf 'Recovery: failed to restart %s; manual intervention required.\n' "$service" >&2
        fi
      done
      if (( cleanup_timer_active )); then systemctl start shop-chat-cleanup.timer || true; fi
    else
      printf 'Deployment failed (exit %s); no confirmed restored release/units. Services remain stopped; manual recovery required.\n' "$status" >&2
    fi
  elif (( status != 0 && ! restored )); then
    printf 'Failed to restore systemd units; manual recovery required.\n' >&2
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
  state=$(as_shop git -C "$source_root" status --porcelain --untracked-files=all) || fail 'Cannot read Git status.'
  [[ -z $state ]] || fail 'Dirty working tree; deployment stopped. Inspect files without discarding them.'
}

prisma() {
  # Load secrets as data, without sourcing shell code or putting a URL in argv.
  as_shop /usr/bin/node --env-file=/etc/korzinamarket/api.env \
    "$release_dir/apps/api/node_modules/prisma/build/index.js" "$@" \
    --config "$release_dir/apps/api/prisma7.config.ts"
}

health() {
  curl --fail --silent --show-error --retry 10 --retry-connrefused \
    --retry-delay 2 --max-time 10 "$@" >/dev/null
}

switch_release() {
  [[ ! -e $source_root/.current-next || -L $source_root/.current-next ]] || { printf 'Unexpected .current-next path.\n' >&2; return 1; }
  ln -sfn "$1" "$source_root/.current-next" || return 1
  mv -Tf "$source_root/.current-next" "$source_root/current"
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

  # db.env is root-only; parse configuration here without weakening its permissions.
  /usr/bin/node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const api = parseEnv(readFileSync('/etc/korzinamarket/api.env', 'utf8'));
const web = parseEnv(readFileSync('/etc/korzinamarket/web.env', 'utf8'));
const db = parseEnv(readFileSync('/etc/korzinamarket/db.env', 'utf8'));
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
if (api.CHAT_UPLOAD_DIR && api.CHAT_UPLOAD_DIR !== '/var/lib/korzinamarket/uploads/chat') {
  throw new Error('api.env: CHAT_UPLOAD_DIR must use the private chat directory');
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
if (decodeURIComponent(database.pathname.slice(1)) !== db.POSTGRES_DB || decodeURIComponent(database.username) !== db.POSTGRES_USER) {
  throw new Error('Database backup configuration must match api.env');
}
NODE

  install -d -o shop -g shop -m 0750 "$release_root"
  if [[ -L $source_root/current ]]; then
    previous_release=$(readlink -f "$source_root/current")
    [[ $previous_release == "$release_root/"* && -d $previous_release ]] || fail 'Invalid current release.'
  elif [[ -e $source_root/current ]]; then
    fail 'current must be a release symlink; preserve the existing path before migrating.'
  else
    # Preserve the currently running artifacts before updating the source checkout.
    previous_release=$(mktemp -d "$release_root/legacy-XXXXXXXX")
    as_shop git -C "$source_root" archive HEAD | tar -C "$previous_release" -xf -
    local artifacts=() path
    for path in node_modules apps/api/node_modules apps/api/dist apps/web/node_modules apps/web/.output; do
      if [[ -e $source_root/$path ]]; then artifacts+=("$path"); fi
    done
    if (( ${#artifacts[@]} )); then
      tar -C "$source_root" -cf - "${artifacts[@]}" | tar -C "$previous_release" -xf -
    fi
    chown -R shop:shop "$previous_release"
  fi

  if [[ -f $previous_release/apps/api/dist/main.js && -f $previous_release/apps/web/.output/server/index.mjs ]]; then
    previous_release_valid=1
  fi

  as_shop git fetch origin main
  as_shop git merge-base --is-ancestor HEAD origin/main || fail 'Local main has commits outside origin/main.'
  as_shop git pull --ff-only origin main

  local commit
  commit=$(as_shop git rev-parse HEAD)
  release_dir=$(mktemp -d "$release_root/$commit-XXXXXXXX")
  as_shop git archive HEAD | tar -C "$release_dir" -xf -
  chown -R shop:shop "$release_dir"
  cd "$release_dir"
  corepack enable
  as_shop pnpm install --frozen-lockfile --prod=false
  prisma generate --no-hints
  as_shop pnpm typecheck
  as_shop pnpm lint
  as_shop pnpm --filter api test
  as_shop pnpm --filter telegram-gateway test
  as_shop node --test apps/web/test/*.test.mjs
  as_shop pnpm build
  clean_tree

  if [[ ! -L $source_root/current ]]; then switch_release "$previous_release"; fi
  install -d -o shop -g shop -m 0750 /var/lib/korzinamarket/uploads/products
  install -d -o shop -g shop -m 0750 /var/lib/korzinamarket/uploads/chat/.incoming
  unit_backup_dir=$(mktemp -d /var/backups/korzinamarket-units-XXXXXXXX)
  chmod 0700 "$unit_backup_dir"
  local unit
  for unit in shop-api.service shop-web.service shop-chat-cleanup.service shop-chat-cleanup.timer; do
    if [[ -e $unit_dir/$unit ]]; then cp -L "$unit_dir/$unit" "$unit_backup_dir/$unit"; fi
  done
  if systemctl is-active --quiet shop-chat-cleanup.timer; then cleanup_timer_active=1; fi
  units_changed=1
  install -m 0644 deploy/shop-api.service deploy/shop-web.service \
    deploy/shop-chat-cleanup.service deploy/shop-chat-cleanup.timer "$unit_dir/"
  systemctl daemon-reload
  # Mark before stop so a partial failure also enters recovery.
  services_stopped=1
  systemctl stop shop-chat-cleanup.timer
  systemctl stop shop-chat-cleanup.service
  systemctl stop shop-web.service
  systemctl stop shop-api.service

  # Snapshot DB only after writes stop. Never auto-restore a database in the trap.
  local backup_dir
  backup_dir=$(mktemp -d /var/backups/korzinamarket-XXXXXXXX)
  chmod 0700 "$backup_dir"
  docker compose --env-file /etc/korzinamarket/db.env -f "$source_root/deploy/compose.db.yml" \
    exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/database.dump"
  [[ -s $backup_dir/database.dump ]] || fail 'Database backup is empty.'
  docker compose --env-file /etc/korzinamarket/db.env -f "$source_root/deploy/compose.db.yml" \
    exec -T db pg_restore --list < "$backup_dir/database.dump" >/dev/null
  prisma migrate deploy
  switch_release "$release_dir"

  clean_tree
  systemctl enable shop-api.service shop-web.service
  systemctl restart shop-api.service
  health http://127.0.0.1:4001/api/health/ready
  systemctl restart shop-web.service
  health http://127.0.0.1:3000/catalog
  health https://korzinamarket.ru/api/health/ready
  health --head https://korzinamarket.ru
  systemctl enable --now shop-chat-cleanup.timer
  services_stopped=0
  units_changed=0
  printf 'Deployment healthy: '
  as_shop git -C "$source_root" log -1 --oneline
}

trap recover EXIT
main "$@"
