# Ручной rollout адаптивных фото

Этот runbook заменяет прежнее безусловное `SANDBOX_UNVERIFIED` из исторических
отчётов. Прямой Node `--apply` остаётся закрыт. Запись разрешает только штатный
root launcher после kernel/mount/cgroup/manager/digest/fence проверок и передачи
root-owned 0600 request FD. VPS этим изменением не обновлялся.

Обычный `deploy/deploy.sh` здесь **не использовать**: он обновляет main и запускает
миграции. Ниже отдельный фиксированный checkout, без изменения схемы БД.

## 1. Фиксированный checkout и сборка

Один root Bash-сеанс. В `SHA` подставить полный проверенный SHA из итогового ответа.
Commit сначала должен быть доступен на origin; Codex его не пушит.

```bash
sudo -i
set -euo pipefail
umask 077
export SHA='FULL_VERIFIED_COMMIT_SHA'
[[ $SHA =~ ^[0-9a-f]{40}$ ]]
REPO=/opt/korzinamarket
RELEASE=/opt/korzinamarket-releases/$SHA
as_shop() { runuser -u shop -- env -i HOME=/home/shop PATH=/usr/local/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NUXT_TELEMETRY_DISABLED=1 "$@"; }
[[ $(id -u shop) == 997 ]]
[[ $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 24 ]]
test "$(systemd --version | head -n1 | awk '{print $2}')" -ge 258
test -e /sys/fs/cgroup/cgroup.controllers
! findmnt -no OPTIONS -T /var/lib/korzinamarket/uploads | grep -Eq '(^|,)(nobarrier|barrier=0)(,|$)'
[[ $(findmnt -no FSTYPE -T /var/lib/korzinamarket/uploads) == ext4 ]]
as_shop git -C "$REPO" fetch origin
as_shop git -C "$REPO" cat-file -e "$SHA^{commit}"
install -d -o shop -g shop -m 0755 /opt/korzinamarket-releases
as_shop git -C "$REPO" worktree add --detach "$RELEASE" "$SHA"
[[ $(as_shop git -C "$RELEASE" rev-parse HEAD) == "$SHA" ]]
test -z "$(as_shop git -C "$RELEASE" status --porcelain)"
cmp "$REPO/apps/api/prisma/schema.prisma" "$RELEASE/apps/api/prisma/schema.prisma"
cd "$RELEASE"
as_shop pnpm install --frozen-lockfile
as_shop env DATABASE_URL=postgresql://build:build@127.0.0.1:1/unused \
  pnpm --filter api exec prisma generate --config prisma7.config.ts
as_shop pnpm typecheck
as_shop pnpm lint
as_shop pnpm build

# Rootless build inputs are whitelisted tracked files; .env/node_modules are not copied.
# Docker is local, no VPS image processing during this build.
python3 -B deploy/image-runner/artifact_host.py --build | tee /tmp/image-artifact-build.log
ARTIFACT=$(sed -n 's/^ARTIFACT_OUTPUT=//p' /tmp/image-artifact-build.log)/artifact
test -s "$ARTIFACT/rootfs.tar"
export ARTIFACT
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
p = Path(os.environ['ARTIFACT'])
s = json.loads((p / 'summary.json').read_text())
for name, key in [('rootfs.tar', 'rootfsSha256'), ('manifest.json', 'manifestSha256')]:
    with (p / name).open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == s[key]
m = json.loads((p / 'manifest.json').read_text())
assert m['source']['head'] == os.environ['SHA']
print(json.dumps(s, indent=2))
PY
```

Runtime требует Linux с `PrivatePIDs`, `PrivateUsers=full`, cgroup v2,
`SO_PEERPIDFD` и pidfs. Версия systemd сама по себе недостаточна: canary обязан
пройти реальные проверки. Не заменять sandbox-настройки при отказе. Docker build
требует сеть только для pinned dependencies; обработчик работает без сети/БД.
При другом filesystem сначала нужен отдельный прогон native acceptance.

## 2. Backup и установка с выключенными флагами

На время согласованной резервной копии остановить запись. Сохранить backup вне VPS
перед включением обработки; каталог с `*.env` и БД должен оставаться приватным.

```bash
exec 9>/run/lock/korzinamarket-deploy.lock
flock -n 9
BK=/var/backups/korzinamarket/images-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BK"
printf '%s\n' "$SHA" > "$BK/new-sha"
printf '%s\n' "$BK" > /root/korzinamarket-image-backup-path
cp -a /etc/korzinamarket "$BK/env"
cp -a /etc/systemd/system "$BK/systemd"
systemctl stop shop-web shop-api
docker compose --env-file /etc/korzinamarket/db.env \
  -f "$REPO/deploy/compose.db.yml" exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BK/database.dump"
test -s "$BK/database.dump"
tar --acls --xattrs --numeric-owner -C /var/lib/korzinamarket -cpf "$BK/uploads.tar" uploads
tar -tf "$BK/uploads.tar" > "$BK/uploads-list"
sha256sum "$BK/database.dump" "$BK/uploads.tar" > "$BK/SHA256SUMS"
sha256sum -c "$BK/SHA256SUMS"

# Recreate only the ephemeral deployment flock at boot, before normal services.
# The f entry does not truncate an existing file. Persistent image/run locks stay intact.
printf '%s\n' 'f /run/lock/korzinamarket-deploy.lock 0600 root root -' \
  > /etc/tmpfiles.d/korzinamarket-images.conf

install -d -o shop -g shop -m 0700 \
  /var/lib/korzinamarket/uploads/product-variants \
  /var/lib/korzinamarket/uploads/.product-image-state
install -d -o root -g root -m 0755 /var/lib/korzinamarket-image-runner /opt/image-runner
# Never replace a live runtime. flock above refuses a retained runner fence.
if test -e /var/lib/korzinamarket-image-runner/rootfs; then
  mv /var/lib/korzinamarket-image-runner/rootfs "$BK/previous-rootfs"
  cp -a /var/lib/korzinamarket-image-runner/manifest.json "$BK/previous-manifest.json"
fi
tar -C /var/lib/korzinamarket-image-runner -xpf "$ARTIFACT/rootfs.tar"
install -o root -g root -m 0444 "$ARTIFACT/manifest.json" \
  /var/lib/korzinamarket-image-runner/manifest.json
for file in manage.py launcher.py broker.py artifact.py; do
  install -o root -g root -m 0555 "deploy/image-runner/$file" "/opt/image-runner/$file"
done
install -m 0644 deploy/shop-image-runner@.service deploy/shop-image-runner-pin@.target \
  deploy/shop-api.service deploy/shop-web.service /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/shop-api.service.d /etc/systemd/system/shop-web.service.d
cat > /etc/systemd/system/shop-api.service.d/50-image-release.conf <<EOF
[Service]
WorkingDirectory=$RELEASE
ExecStart=
ExecStart=/usr/bin/node $RELEASE/apps/api/dist/main.js
EOF
cat > /etc/systemd/system/shop-web.service.d/50-image-release.conf <<EOF
[Service]
WorkingDirectory=$RELEASE
ExecStart=
ExecStart=/usr/bin/node $RELEASE/apps/web/.output/server/index.mjs
EOF

# Only these four image settings are changed; other env values stay byte-for-byte.
image_flag() {
  local file=$1 key=$2 value=$3
  case "$key" in
    PRODUCT_IMAGE_VARIANTS_ENABLED|PRODUCT_IMAGE_VARIANTS_DIR|PRODUCT_IMAGE_STATE_DIR|NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS) ;;
    *) return 2 ;;
  esac
  sed -i "/^${key}=/d" "$file"
  printf '%s=%s\n' "$key" "$value" >> "$file"
}
image_flag /etc/korzinamarket/api.env PRODUCT_IMAGE_VARIANTS_ENABLED false
image_flag /etc/korzinamarket/api.env PRODUCT_IMAGE_VARIANTS_DIR /var/lib/korzinamarket/uploads/product-variants
image_flag /etc/korzinamarket/api.env PRODUCT_IMAGE_STATE_DIR /var/lib/korzinamarket/uploads/.product-image-state
image_flag /etc/korzinamarket/web.env NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS false
systemd-analyze verify /etc/systemd/system/shop-image-runner@.service
systemctl daemon-reload
systemctl start shop-api shop-web
curl -fsS http://127.0.0.1:4001/api/health
curl -fsSI http://127.0.0.1:3000 >/dev/null
curl -fsS https://korzinamarket.ru/api/health
exec 9>&-
```

Новые flags не требуют повторной Nuxt build: это runtimeConfig. Проверить, что
effective Nginx проксирует `/uploads/` в API с тем же URI и не содержит alias на
uploads/state. Не менять права state ради Nginx. `rootfs` полностью проверяется
по manifest перед каждой партией; в него не копируются host env или credentials.

## 3. Один товар, затем партии

Взять URL существующего фото из карточки товара в API и установить точный basename.
Один товар с несколькими фото сначала проверяется на одном выбранном оригинале.

```bash
IMAGE='PUT_EXISTING_UUID.webp'
[[ $IMAGE =~ ^[0-9a-f-]{36}\.webp$ ]]
sha256sum "/var/lib/korzinamarket/uploads/products/$IMAGE" > "$BK/canary-original.sha256"
stat -c '%d:%i:%s:%Y:%a:%u:%g' "/var/lib/korzinamarket/uploads/products/$IMAGE" > "$BK/canary-original.stat"
python3 -I -B /opt/image-runner/manage.py batch --size 1 --image "$IMAGE" | tee "$BK/canary.log"
sha256sum -c "$BK/canary-original.sha256"
stat -c '%d:%i:%s:%Y:%a:%u:%g' "/var/lib/korzinamarket/uploads/products/$IMAGE" | cmp - "$BK/canary-original.stat"
test -s "/var/lib/korzinamarket/uploads/.product-image-state/ready/${IMAGE%.webp}.json"
# Small native sources intentionally deduplicate dimensions and never upscale.
python3 -I -B /opt/image-runner/manage.py batch --size 1 --image "$IMAGE"

# Each command is finite: <=200 inspected originals, <=size selected, concurrency 1.
# Persisted cursor wraps to discover uploads/imports, including older UUID filenames.
python3 -I -B /opt/image-runner/manage.py batch --size 5
python3 -I -B /opt/image-runner/manage.py batch --size 20
```

`manage.py` делает read-only discovery/proposal в отдельной bounded unit, затем
замораживает root-owned inventory/approval/request. Каждый apply повторно проверяет
SHA/runtime/profile/source fingerprints. Оригиналы монтируются RO, worker получает
UID 997, фактический primary GID shop и пустые supplementary groups. Сохранены
768 MiB memory.max, 0 swap, CPU 50%, 64 tasks, 600 s и fdstore fence. Unknown locks
не снимаются. Полные WebP публикует существующий ImageStorage с READY в конце.
Сохранены disk reserve не менее 1 GiB/10%, retained limit 512 MiB/20 000 entries
и максимум 1000 сохранённых control scopes. При достижении лимита проход
останавливается; автоматического удаления изображений или журналов нет.

После canary оператор может подключить **тот же конечный CLI** к cron; новых
queue/daemon/DB сущностей нет. Например, один проход каждые две минуты:

```bash
printf '%s\n' '*/2 * * * * root /usr/bin/python3 -I -B /opt/image-runner/manage.py batch --size 5 2>&1 | /usr/bin/logger -t korzina-images' \
  > /etc/cron.d/korzinamarket-images
chmod 0644 /etc/cron.d/korzinamarket-images
```

При остановке/ошибке/OOM CLI возвращает nonzero и сохраняет fence. Cursor не
продвигается. Для stop использовать точный `runId` из лога:

```bash
RUN_ID='EXACT_RUN_UUID'
systemctl stop "shop-image-runner@$RUN_ID.service"
systemctl show "shop-image-runner@$RUN_ID.service" -p ActiveState -p MainPID -p Result -p ControlGroup -p NFileDescriptorStore
# This proves the cgroup is empty before cleaning fdstore. It never removes image/run locks.
python3 -I -B /opt/image-runner/manage.py release "$RUN_ID"
```

Новый запуск после crash может остаться BUSY из-за сохранённого image/run lock.
Сохранить evidence и разобрать его отдельно; ни PID, ни возраст не дают права
снимать lock. `--image` позволяет повторно проверить/починить конкретный READY,
но не обходит lock, digest, disk reserve или admission.

## 4. Флаги, наблюдение, откат

Сначала только API, frontend пока false:

```bash
image_flag /etc/korzinamarket/api.env PRODUCT_IMAGE_VARIANTS_ENABLED true
systemctl restart shop-api
curl -fsS https://korzinamarket.ru/api/health
curl -fsS 'https://korzinamarket.ru/api/products?limit=24' > "$BK/api-canary.json"
# Pick a WebP candidate advertised in this response and test its actual URL:
VARIANT=$(python3 - "$BK/api-canary.json" <<'PY'
import json, sys
data=json.load(open(sys.argv[1]))
print(next(i['variants']['webp'][0]['url'] for p in data['items'] for i in p['images'] if i.get('variants')))
PY
)
curl -fsSI "https://korzinamarket.ru$VARIANT"
curl -fsS -o /dev/null -w 'status=%{http_code} bytes=%{size_download}\n' "https://korzinamarket.ru$VARIANT"
# Expect WebP, 200/HEAD, immutable cache + ETag; conditional ETag -> 304.
# Unknown hash/missing variant -> 307 no-store to original; flags off -> 404 no-store.
```

Сравнить cold/warm catalog/detail/favorites p50/p95/p99 и 5xx с flags-off baseline.
Не начинать следующую партию в первичном окне оценки. Остановить rollout при breach
SLO либо p95 > baseline на 20% **и** >50 ms в двух 5-minute окнах. Локальный fixture
замер из отчёта не заменяет VPS измерения БД/диска/сети. После принятия API:

```bash
image_flag /etc/korzinamarket/web.env NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS true
systemctl restart shop-web
curl -fsS https://korzinamarket.ru/catalog > "$BK/catalog-enabled.html"
grep -q 'srcset=' "$BK/catalog-enabled.html"
grep -q 'sizes=' "$BK/catalog-enabled.html"
```

Проверить 390px и 1440px: каталог/прокрутку, избранное, карточку и миниатюры.
Основное фото галереи остаётся оригиналом. Сетевой сбой варианта должен дать одну
попытку original, затем placeholder при сбое самого original, без цикла запросов.

Быстрый откат — выключить frontend первым; API оставить обслуживать уже выданные
URL. При API latency/security проблеме выключить и API: открытые страницы
восстановятся через frontend fallback. WebP/READY и оригиналы не удалять.

```bash
if test -f /etc/cron.d/korzinamarket-images; then
  mv /etc/cron.d/korzinamarket-images "$BK/paused-images.cron"
fi
image_flag /etc/korzinamarket/web.env NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS false
systemctl restart shop-web
image_flag /etc/korzinamarket/api.env PRODUCT_IMAGE_VARIANTS_ENABLED false
systemctl restart shop-api
curl -fsS https://korzinamarket.ru/api/health
```

Если нужен откат приложения, остановить/release активный runner как выше,
снова взять deploy flock, затем восстановить env/unit/drop-ins из backup.
Рабочий checkout старой версии всё это время оставался в `$REPO`:

```bash
exec 9>/run/lock/korzinamarket-deploy.lock
flock -n 9
systemctl stop shop-web shop-api
cp -a "$BK/env/api.env" /etc/korzinamarket/api.env
cp -a "$BK/env/web.env" /etc/korzinamarket/web.env
for name in shop-api shop-web; do
  mv "/etc/systemd/system/$name.service.d/50-image-release.conf" "$BK/$name-new-release.conf"
  cp -a "$BK/systemd/$name.service" "/etc/systemd/system/$name.service"
  if test -d "$BK/systemd/$name.service.d"; then
    cp -a "$BK/systemd/$name.service.d/." "/etc/systemd/system/$name.service.d/"
  fi
done
systemctl daemon-reload
systemctl start shop-api shop-web
curl -fsS https://korzinamarket.ru/api/health
curl -fsSI https://korzinamarket.ru >/dev/null
exec 9>&-
```

БД/заказы не откатывать: этот rollout не меняет schema и не выполняет migrations.
Backup БД нужен для disaster recovery. Старые releases/rootfs, новый output и
диагностические записи сохраняются; garbage collection в эту процедуру не входит.
