# KorzinaMarket — предрелизная проверка, ЭТАП 1.7

Дата: 04.11.2026. Решения: **merge — READY; production deploy — NOT READY**.
Для merge требуется отдельное разрешение владельца и повторная проверка main
перед публикацией. Для deploy пока нет фактического production preflight,
проверенного production backup/restore и подтверждённого переключения сервисов.
Локальная проверка не заменяет эти условия.

Production не посещался. Команды ниже подготовлены, но **НЕ ВЫПОЛНЕНЫ** на сервере.
Push, PR, merge в main, deploy, изменения реальных данных и ЭТАП 2 не выполнялись.
В 1.7 меняется только этот документ; тестовые материалы находятся в игнорируемом work/.

## 1. Git и состав кандидата

- Каталог: `F:\Shop\.worktrees\agency-fee-unified`, ветка `integration/agency-fee-unified`.
- Проверенный SHA: `3601b3476f61382d2693e96ba7b36f1ed82af1f2`; рабочее дерево на входе чистое.
- Fetch `origin main` выполнен. Актуальный main:
  `508463cfade2112f375dca89d46f2c9e0c9cabdc`, без продвижения относительно 1.6Б.
- `origin/main...HEAD`: 0 коммитов только у main, 9 только у интеграции.
  Main является предком HEAD: конфликтов при таком объединении нет,
  отдельный тестовый merge/worktree не нужен.
- Предками HEAD подтверждены `6bb6bc3` (Delegated Admin/Event Center), `04ba6ca`
  (Unified User Phone), `a388c69` (fee/bulk), `fff35d6` (исправления 1.6Б), `3601b34`.
- Итог относительно main до документа 1.7: 125 файлов, 11371 добавление, 352 удаления.
  Исходные ветки и чужие worktrees не изменялись.
- Документ 1.7 добавляется отдельным локальным docs-коммитом. Полный финальный SHA
  получают через `git rev-parse HEAD` после него; SHA исполняемого кода остаётся
  `fff35d6fa11c44a259e57c315045d478a37bbf1c`. Документ не может содержать собственный hash.

Состав проверен по ancestry и diff, а не только по сообщениям коммитов:

| Функциональность | Сохранившиеся компоненты и доказательства |
|---|---|
| Global/individual fee | поля схемы, migration, pricing/markup, settings/products/import writers, server preview, UI |
| Bulk | controller/service/Zod, подписанный preview, UUID durable result, atomic audit/rollback, миграция и UI |
| Unified phone | SMS/Telegram/OIDC/auth/order-phone/customer-checkout; существующие User/identity constraints |
| Delegated Admin | adminPasswordHash, users/permissions/guards, primary-only global/bulk, UI и тесты |
| Event Center | AdminChange, ActivityPrismaPg/interceptor, функции/триггеры, query/SSE, ownerOnly и redaction |
| История и checkout | прежние money/qty/workflow, snapshots, guest cookies, backend quote; agency checkout не добавлен |

Исправления 1.6Б: конкретные сообщения SERVICE_FEE_* при 409; согласованная Telegram
primary-phone фикстура и проверка callback_data; расширение viewport; реальный
fee/activity/cart fixture; новый сквозной flow smoke. Все восемь файлов входят в
`fff35d6`, отчёт — в `3601b34`. Нет изменений финансовой архитектуры в 1.7.

## 2. Подтверждение проверок

Прочитаны отчёты [1.6А](agency-fee-integration-16a.md),
[1.6Б](agency-fee-integration-16b.md), [fee](agency-service-fee.md), AGENTS.md и
сохранённый `agency-service-fee-audit-20261103/work/audit-15/release-runbook.md`.
Их исторические разделы описывают прежние этапы; текущие контракты определяются
кодом интеграции и этим runbook. Полные зелёные серии без причины не повторялись.

| Проверка | Passed / skipped / failed | Источник |
|---|---|---|
| Полный API unit, 104 файла | 2061 / 23 / 0 | audit16b/backend-unit.json |
| Дополнительный hits SQL profile | 12 / 0 / 0, включая 3 прежних skip | audit16b/resume-hits.json |
| PostgreSQL E2E, 31 файл | 626 / 0 / 0 | audit16b/postgres-e2e-clean-final.json |
| Telegram shopping после последней правки | 82 / 0 / 0 | audit16b/resume-customer-shopping.json |
| Frontend полный | 489 / 0 / 0 | audit16b/frontend-unit-final.log |
| Gateway полный | 90 / 0 / 0 | audit16b/gateway-unit.json |
| Checkout, 320/768/390/1280 | 88 / 0 / 0 | work/checkout/artifacts/runner.log |
| Browser smoke, 18 скриптов | 15 / 0 / 3 baseline | browser-results + browser-retry-results |
| Дополнительный API admin smoke, 1.7 | PASS, все 17 PASS-этапов | readiness17/admin-smoke.log |
| Linux/POSIX профиль, 1.7, 6 файлов | 258 / 0 / 1 timeout | readiness17/linux-tests.json |
| Адресный Linux повтор image-runner | 1 / 81 по фильтру / 0 | readiness17/linux-retry.log |

API unit включает admin 155, auth 198, cart 22, order 116, product 373, staff 93,
Telegram 862, delivery 51, finance/payouts, imports, storage и остальные группы.
В первоначальных 23 skipped: 20 native Linux/POSIX и 3 optional SQL hits.
Hits действительно выполнены позже, поэтому до Linux-допроверки подтверждены
2064 уникальных теста из 2084. Повторные профили не суммируются как новые тесты.

Все **20 прежде пропущенных POSIX-тестов прошли**: список сопоставлен по именам
с backend-unit.json. Linux Node 24.22.2 в отдельном Docker volume, image digest
`sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413`,
исходники из Git archive точного 3601b34, frozen lockfile. В шести файлах всего
259 тестов. Один неизменённый относительно main runner-тест
`deduplicates exact URLs without refilling or publishing outside the approved scope`
первоначально превысил свой лимит 15000 ms. Адресный повтор с фильтром deduplicates
прошёл за 9097 ms с тем же объявленным лимитом и ожиданиями. Остальные 81 тест
runner-файла в адресном повторе исключены фильтром, а не отключены в исходнике.
Полный первый Linux-профиль не объявляется зелёным; первоначальный FAIL сохранён.
Суммарно все 259 тестов этих файлов проверены, включая 20 native проверок;
уникальное покрытие исходных API unit теперь 2084, без заявления о новом полном
Linux-прогоне всех 104 файлов. Timing flakiness image-runner остаётся риском CI.
После ignore-scripts install Vite также предупредил об отсутствии generated Nuxt
tsconfig в Linux fixture; это не было причиной timeout/FAIL. Приложение на Linux
в этом профиле не собиралось; builds подтверждены отдельными результатами 1.6Б.

В 626 E2E входят cart/quote 24, staff 39, Telegram auth 35, customer shopping 82,
customer bot 66, OTP 22, phase1 56, promo 19, imports 11; fee backend 33,
bulk 30, bulk migration 4, foundation 6, events/fee 6, delegated admin 13 и остальные.
Реальные PostgreSQL/API/Web использованы в fee/bulk/flow и checkout;
общие Event Center/delegated браузерные тесты дополнительно используют фикстуры.

| Приложение | Typecheck | Lint | Production build |
|---|---|---|---|
| API | PASS: tsconfig.build + tsconfig.catalog | PASS: oxlint | PASS: nest build |
| Web | PASS: nuxt typecheck, повтор после 409 | PASS: eslint, повтор после 409 | PASS, повтор после 409 |
| Gateway | PASS: tsc --noEmit | PASS: oxlint | PASS: tsc |

Подтверждение всех трёх Done — `audit16b/typecheck.log`, `lint.log`, `build.log`.
Строгий tsc затронутых E2E прошёл. В 1.7 дополнительно выполнены checkout API
`tsc --noEmit -p tsconfig.checkout.json` и web `tsc -p test/checkout/tsconfig.json`:
оба PASS; Prisma validate — PASS. Schema/migrations побайтно по Git не менялись
с проверенного `039d42f`. Bash syntax deploy.sh — PASS.

API admin smoke присутствует в Checks CI и не был явно подтверждён в 1.6Б:
в 1.7 выполнен целиком с отдельной случайной схемой в изолированной БД.
Проверены login/session, USER/SELLER boundaries, товары/картинки/пользователи,
SSR admin/storefront/cart/staff, история после удаления товара. Внешние отправители
отключены фикстурой, временная схема очищена самим тестом.

## 3. Baseline и условия допуска

Три browser FAIL воспроизведены и на main, ожидания не ослаблены:

1. point-grid: 24 одинаковых измерения у main/integration; высоты 280,96875 и
   289,078125 px при 320 px расходятся с ожиданием равных карточек.
2. sale: sale.smoke.mjs:118 — нет ожидаемой подписи «Иллюстрация товара».
3. icons: icons.smoke.mjs:206 — `/: missing plus`.

Отдельно OIDC replay при PostgreSQL Europe/Moscow: integration 32/0/3,
main 24/0/2; дополнительный phone HTTP-тест выявляет ту же проблему повторного
callback. На UTC auth 35/35. C locale не обеспечивает ожидаемое русское FTS
сопоставление; ICU ru-RU проходит. Это реальные риски, не зелёные проверки.
Без проверенного решения по timezone/данным/replay и locale deploy запрещён.

Новых блокирующих ошибок объединённой функциональности не выявлено.
Framework/pg deprecation и Nuxt Icon size warnings не считаются тестовыми FAIL.
Docker POSIX-профиль проверяет native filesystem поведение; он не доказывает
работу реальных systemd namespaces/mounts на Ubuntu-сервере.

## 4. Миграции и данные

Все 54 migration.sql находятся в Git. Все 49 файлов, существовавших на main,
неизменны. Полный manifest в порядке применения получают **из утверждённого SHA**:

```bash
# НЕ ВЫПОЛНЕНО НА PRODUCTION; read-only manifest
sudo -u shop -- git -C "$CANDIDATE" ls-tree -r --name-only "$RELEASE_SHA" -- apps/api/prisma/migrations |
  LC_ALL=C sort | sed -n 's@.*/\([^/]*\)/migration.sql$@\1@p'
```

При production на схеме main, заканчивающейся `20261018170000_own_assortment`,
полный pending-порядок следующий. Фактический production status неизвестен:
не разрешается считать, что на сервере точно 49 migrations.

| № | Миграция | Эффект |
|---|---|---|
| 50 | 20261103100000_delegated_admin_activity | nullable User.adminPasswordHash, AdminChange и триггеры |
| 51 | 20261103120000_event_center | расширение AdminChange, индексы/FTS, allowlist/redaction, функции |
| 52 | 20261103150000_global_service_fee | global default 10; сохранение старых процентов как override; review для legacy10 |
| 53 | 20261104090000_service_fee_bulk_operation | новая таблица durable result, UUID PK, FK User, индекс |
| 54 | 20261104120000_service_fee_events | обновление event_values/record_admin_change для fee и режима |

Unified User Phone не требует отдельной новой миграции: используются прежние
User/TelegramIdentity/OrderPhone. AdminAudit, normalizedPrice expression/index,
исторические Order/OrderItem/OrderPayment не удаляются и не пересчитываются.
Event Center намеренно редактирует проекцию/видимость старого AdminChange;
сохранность AdminAudit не означает сохранение запрещённых PII в этой проекции.

1.6Б действительно применил все 54 на чистой БД и main → integration с данными,
сравнил старые колонки/строки 44 таблиц, 173 исключения и 0%, пользователей,
телефоны, историю, промокоды, платежи, аудит и normalizedPrice. Повтор deploy
не менял данные; синтетический dump восстановлен в третью БД и сравнен.
Receipt: `work/audit16b/migration-report.json`. Повтор этого полного эксперимента
не нужен: Prisma-код с тех пор не изменён. Это не проверка production backup.

Foundation имеет BEGIN/COMMIT, lock_timeout 5s и ACCESS EXCLUSIVE на
ShopSettings/Product, проверяет диапазон перед backfill. Bulk и интеграционная
fee-events имеют транзакции; первые две migrations не имеют общего внешнего
BEGIN/COMMIT. Prisma deploy всей цепочки **не атомарен**. При сбое возможны уже
применённые предыдущие migrations/частичный DDL; приложение не переключать.
Не выполнять reset, db push, down-SQL, автоматический resolve/retry.

Глобальные 10% возникают один раз как default нового поля; повторный deploy
не должен сбрасывать уже выбранное значение. Старые товары остаются individual,
review сам не переводит их в global. Новые товары получают global/null override.
Global меняет primary ADMIN, delegated global/bulk получает 403. Checkout хранит
effective snapshot, история не пересчитывается, committed bulk replay не создаёт
новых Product/AdminAudit/AdminChange. Массового перевода в релизе нет.

## 5. Реальный механизм деплоя и пробелы

Проверены deploy/README.md, deploy.sh, units, compose.db.yml, nginx.conf,
gateway README и исходники health/background services. Репозиторий описывает:

| Объект | Подтверждено в Git | Что проверить на сервере |
|---|---|---|
| Корень приложения | /opt/korzinamarket, пользователь shop | фактический путь/owner/SHA/clean tree, overrides |
| API / Web | shop-api.service / shop-web.service; 4001/3000 loopback | активные units, ExecStart, drop-ins, версия артефактов |
| Secrets | /etc/korzinamarket/api.env, web.env, db.env | наличие/права, без печати значений |
| PostgreSQL | compose service db, postgres:18.6-bookworm, volume shop_pgdata | действительно Compose или другой способ, версия, mount, locale/TZ |
| Cleanup | shop-chat-cleanup.service + timer | активный timer и выполняющийся oneshot |
| Telegram | gateway transport, отдельный host/tunnel; API содержит бизнес-логику | реальные имена units/hosts и очередь/webhook/retry policy |
| Health | /api/health; /api/health/ready; web GET/SSR; gateway /health | публичный proxy, cookie/TLS, DB/schema readiness |
| Event Center | /api/admin/events/stream, X-Accel-Buffering:no, heartbeat | SSE через фактический HTTPS proxy и права |

deploy.sh работает in-place: fetch/pull main → install units → stop Web/API →
install/generate/build → migrate deploy → restart/health. Не делает backup,
не проверяет SERVICE_FEE_PREVIEW_SECRET, не останавливает все внешние writers.
EXIT trap только рестартует сервисы, без возврата артефактов/схемы. Для этого
выпуска **не запускать его без отдельной адаптации/репетиции**.

README содержит старое число «19 migrations» и пример DB/products backup,
но нет готовой автоматизации backup/restore/rollback/maintenance gate.
Chat photos имеют отдельную retention policy: общий долгосрочный uploads archive
не допускается. Локальный shop-api unit требует PrivatePIDs и RO storage roots;
его заявленные systemd ≥257, mounts/UID/ACL проверяются отдельно. Ubuntu 24.04
сама по себе не подтверждает поддержку. Слепо устанавливать units из Git нельзя.

Старт API уже запускает jobs: hits немедленно, activity sender каждые 5s,
notification/delivery polling, event retention раз в час. HTTP maintenance gate
не отключает эти jobs. Начало нового API — явная граница разрешения фоновых writes
и отправок, только после DB-проверок; тестовые ключи/Node test mode не являются
production-переключателем остановки jobs.

## 6. Обязательные ENV и серверные prerequisites

Ни одно production-значение не прочитано. Все строки таблицы требуют серверной
проверки; отсутствие нового ключа не компенсируется зелёным liveness.

| ENV / настройка | Требование |
|---|---|
| NODE_ENV | production в API/Web; не test/development |
| DATABASE_URL | правильный production DB/schema, encoding, role/grants, TLS/network; не выводить URL |
| AUTH_SECRET | существующий стабильный secret; подпись сессий и event cursor; не ротировать с релизом |
| ADMIN_PHONE, ADMIN_PASSWORD | действующий primary login; телефон нормализуется; не менять владельца случайно |
| SERVICE_FEE_PREVIEW_SECRET | новый криптографический secret ≥32 UTF-8 bytes, одинаков у API workers, стабилен между restart |
| EVENT_RETENTION_DAYS | optional default180, целое 30–3650; unresolved outbox не удаляется автоматически |
| PORT, NITRO_HOST, NITRO_PORT | API4001, Web127.0.0.1:3000 согласно проверенным units |
| CORS_ORIGINS, TRUST_PROXY, ORDER_SITE_URL | существующий HTTPS origin/proxy policy; cookie/OIDC redirects |
| NUXT_PUBLIC_API_BASE, NUXT_PUBLIC_SITE_URL | корректный API/origin; публичные значения, без secrets |
| UPLOAD_DIR, CHAT_UPLOAD_DIR, image storage roots | действующие абсолютные paths, права, retention; не смешивать с release tree |
| TELEGRAM_CUSTOMER_BOT_TOKEN, TELEGRAM_STAFF_BOT_TOKEN; legacy fallback | прежние разные identities, без перевыпуска/смены webhook этим релизом |
| TELEGRAM_CUSTOMER_GATEWAY_URL, TELEGRAM_STAFF_GATEWAY_URL | прежние loopback endpoints/tunnel, optional; не изобретать имя systemd unit |
| TELEGRAM_CUSTOMER_WEBHOOK_SECRET, TELEGRAM_STAFF_WEBHOOK_SECRET, legacy TELEGRAM_WEBHOOK_SECRET | сохранить действующие webhook secrets |
| TELEGRAM_OIDC_CLIENT_ID, TELEGRAM_OIDC_CLIENT_SECRET, TELEGRAM_OIDC_REDIRECT_URI | сохранить origin/redirect, signatures и one-time replay |
| OTP_DELIVERY_MODE и provider settings | сохранить рабочую production OTP доставку; не включать DEV/TEST_PHONE_AUTH_ENABLED |
| PAYMENT_*, YANDEX_DELIVERY_*, ORDER_SMS_* | сохранить текущую модель оплаты/доставки/уведомлений; никаких тестовых переводов |
| PG session TimeZone / LC / locale provider | проверенная согласованная UTC-конфигурация или отдельно исправленный replay; русский FTS |

AGENCY_CHECKOUT_ENABLED пока только требование будущего этапа: в текущем runtime
этого реализованного flag нет. Не добавлять его с надеждой активировать модель.
Оферта/акцепт, единая предоплата, резервирование/закупка, автоматические возвраты,
отчёт агента, how-it-works и новая окончательная смета этим выпуском не включаются.

Для deploy также обязательны: владелец окна/RTO/RPO, полный inventory writers,
free bytes/inodes/WAL budget, внешний backup storage, production restore rehearsal,
проверенные systemd/storage/proxy, версия rollback-пары совместимая с новой схемой
либо отдельно отрепетированная процедура восстановления до открытия записей.

## 7. План объединения с main

1. Получить отдельное разрешение владельца на публикацию ветки/создание PR.
2. Снова fetch main, убедиться в чистоте, ancestry и совпадении SHA; при продвижении
   main остановить старый план, проверить новый diff/миграции/контракты.
3. При расхождении создать новый отдельный тестовый worktree от origin/main,
   локально объединить точный integration SHA, выполнить только затронутые проверки;
   не менять существующие worktrees и не разрешать конфликт принятием одной стороны.
4. После разрешения опубликовать integration SHA и создать PR с полным provenance.
   Подготовленный заголовок: «Integrate service fee, unified phone and admin events».
   Описание: global/individual pricing и safe bulk сохраняют legacy exceptions и
   snapshots; unified phone, primary/delegated permissions и events объединены.
   Приложить таблицу тестов, три baseline FAIL и отдельное NOT READY для deploy.
5. Проверить Linux Checks и Checkout E2E именно PR SHA. Получить отдельное решение
   владельца на merge. Сохранить историю двух направлений; не squash/rewrite исходные
   коммиты без отдельного решения. Зафиксировать итоговый main SHA и builds/manifest.
6. После merge — отдельное разрешение на production preflight и deploy.
   Разрешение на merge не является разрешением на серверные операции.

## 8. Production runbook — подготовленные команды

Все следующие блоки **НЕ ВЫПОЛНЕНЫ**. Это последовательная root bash-сессия на
Ubuntu после отдельного допуска. Без заполненных/проверенных prerequisites команды
должны останавливаться. Фактические серверные пути/units сверяются прежде исполнения.
Ввод секретов — только secret manager/sudoedit, без cat/env/set -x/source.

Продолжение: preflight → staging → maintenance → backup → restore → migrate →
согласованное переключение → smoke/наблюдение → открытие writes. При любой ошибке
остановиться; здесь нет trap, автоматически запускающего старое приложение.

### 8.1. Read-only preflight и привязка реального окружения

Пути ниже взяты из deploy/, но должны совпасть с действующими units. Дополнительные
writers, Telegram hosts/tunnels и maintenance gate определяются эксплуатацией.
`K17_GATE_ON/OFF` — заранее проверенные варианты **одного существующего nginx
include**, `K17_GATE_TARGET` — его действующий путь. Gate должен закрывать публике
также webhooks, разрешать оператора и SSR-запросы сервера; возвращать 503, а не
ложный успешный ответ Telegram. Такого готового include в Git нет. Его подготовка
и репетиция — обязательный prerequisite, не выдуманная возможность deploy.sh.

```bash
# НЕ ВЫПОЛНЕНО — будущая root bash-сессия, сначала только проверки
set -euo pipefail
umask 077
APP=/opt/korzinamarket
API_ENV=/etc/korzinamarket/api.env
WEB_ENV=/etc/korzinamarket/web.env
DB_ENV=/etc/korzinamarket/db.env
: "${K17_RELEASE_SHA:?утвержденный полный main SHA после merge}"
: "${K17_BACKUP_ROOT:?подключенное защищенное внешнее хранилище}"
: "${K17_GATE_ON:?проверенный maintenance include}"
: "${K17_GATE_OFF:?проверенный normal include}"
: "${K17_GATE_TARGET:?действующий include внутри /etc/nginx}"
RELEASE_SHA=$K17_RELEASE_SHA
[[ $RELEASE_SHA =~ ^[0-9a-f]{40}$ ]]
BACKUP_ROOT=$(realpath -e -- "$K17_BACKUP_ROOT")
GATE_TARGET=$(realpath -e -- "$K17_GATE_TARGET")
[[ $GATE_TARGET == /etc/nginx/* ]]
mountpoint -q "$BACKUP_ROOT"
test -d "$APP"; test -r "$API_ENV"; test -r "$WEB_ENV"; test -r "$DB_ENV"
test -r "$K17_GATE_ON"; test -r "$K17_GATE_OFF"
as_shop() { runuser -u shop -- env -i HOME=/home/shop PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
cd "$APP"
test -z "$(as_shop git status --porcelain --untracked-files=all)"
[[ $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 24 ]]
systemctl --version
for u in shop-api.service shop-web.service; do
  test "$(systemctl show -p LoadState --value "$u")" = loaded
  systemctl show "$u" -p FragmentPath -p DropInPaths -p User -p Group \
    -p WorkingDirectory -p ActiveState -p SubState
done
systemctl list-unit-files --type=service --no-pager | grep -Ei '(shop|korzina|telegram)' || true
systemctl list-timers --all --no-pager
ss -ltn
df -PB1 -- "$APP" "$BACKUP_ROOT" /var/lib/docker /var/lib/korzinamarket
df -Pi -- "$APP" "$BACKUP_ROOT" /var/lib/docker /var/lib/korzinamarket
docker compose --env-file "$DB_ENV" -f "$APP/deploy/compose.db.yml" config --quiet
DB_CONTAINER=$(docker compose --env-file "$DB_ENV" -f "$APP/deploy/compose.db.yml" ps -q db)
test -n "$DB_CONTAINER"
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$DB_CONTAINER"
docker inspect --format '{{range .Mounts}}{{println .Type .Name .Destination}}{{end}}' "$DB_CONTAINER"
PGDATA_HOST=$(docker volume inspect shop_pgdata --format '{{.Mountpoint}}')
df -PB1 -- "$PGDATA_HOST"; df -Pi -- "$PGDATA_HOST"
nginx -t
curl -fsS --max-time 10 http://127.0.0.1:4001/api/health
curl -fsS --max-time 10 http://127.0.0.1:4001/api/health/ready
```

Если production не использует этот Compose/volume/units layout, STOP: сначала
перепривязать команды к фактам. Не поднимать второй PostgreSQL и не менять image
на работающем volume. Не выводить полный docker inspect/config, Environment,
ExecStart или env-файлы: они могут содержать секреты. Активный ExecStart проверять
локально с редактированием чувствительных данных, не публиковать его вывод.

```bash
# НЕ ВЫПОЛНЕНО — чтение ENV как данных; вывод только итогового статуса
as_shop /usr/bin/node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const a = parseEnv(readFileSync('/etc/korzinamarket/api.env', 'utf8'));
const w = parseEnv(readFileSync('/etc/korzinamarket/web.env', 'utf8'));
for (const k of ['DATABASE_URL','AUTH_SECRET','ADMIN_PHONE','ADMIN_PASSWORD'])
  if (!a[k]?.trim()) throw new Error('Missing api setting: '+k);
if (a.NODE_ENV !== 'production' || w.NODE_ENV !== 'production') throw new Error('NODE_ENV');
if (Buffer.byteLength(a.SERVICE_FEE_PREVIEW_SECRET ?? '') < 32) throw new Error('Bulk secret missing/short');
const days = Number(a.EVENT_RETENTION_DAYS ?? 180);
if (!Number.isInteger(days) || days < 30 || days > 3650) throw new Error('Event retention');
if (a.TEST_PHONE_AUTH_ENABLED === 'true' || a.OTP_DELIVERY_MODE === 'DEV') throw new Error('Test auth enabled');
if (!w.NUXT_PUBLIC_API_BASE || !w.NUXT_PUBLIC_SITE_URL) throw new Error('Missing public origin');
let u; try { u = new URL(a.DATABASE_URL); } catch { throw new Error('Invalid database target'); }
if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || u.port !== '5432')
  throw new Error('Database target differs from approved deployment layout');
console.log('Required settings present; values suppressed');
NODE
dbsql() {
  docker exec -i "$DB_CONTAINER" sh -c \
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}
dbsql <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
SELECT version(),current_setting('TimeZone'),current_setting('server_encoding');
SELECT datlocprovider,datcollate,datctype,datlocale FROM pg_database WHERE datname=current_database();
SELECT to_tsvector('russian','Сборщик') @@ plainto_tsquery('russian','сборщик');
SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY started_at;
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT "serviceMarkupPercent",count(*) FROM "Product" GROUP BY 1 ORDER BY 1;
SELECT count(*) FROM "Product" WHERE "serviceMarkupPercent" IS NULL OR "serviceMarkupPercent" NOT BETWEEN 0 AND 100;
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL;
SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database();
COMMIT;
SQL
```

Сопоставить не только server TimeZone, но и сессию **настоящего Prisma adapter**:
роль/DB/URL options могут переопределить настройку. На восстановленной копии выполнить
OIDC replay/phone tests и русский поиск с теми же session settings. Не менять TZ/LC
живой БД вслепую; при проблеме STOP. Подтвердить фактический major PostgreSQL 18.
Проверить applied checksum с release migration files с учётом line endings;
unfinished/drift/неизвестные migrations — STOP. Нельзя применять только последние
пять, пропустив более ранний pending DDL.

### 8.2. Staging артефактов до остановки магазина

Здесь предлагается отдельный versioned release directory и минимальные systemd
drop-ins, сохраняющие действующие EnvironmentFile и hardening. Это подготовленная
ручная процедура, **не существующая функция deploy.sh**; её нужно отрепетировать.
Если storage/systemd policy не разрешает этот layout, согласовать другой cutover
до окна обслуживания. Старый каталог приложения и его artifacts сохраняются.

```bash
# НЕ ВЫПОЛНЕНО — запись только будущих release/backup материалов, до DB migrations
RELEASES=/opt/korzinamarket-releases
CANDIDATE="$RELEASES/$RELEASE_SHA"
RUN_DIR="$BACKUP_ROOT/release17-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$RUN_DIR"; install -d -m 0700 "$RUN_DIR"
install -d -o shop -g shop -m 0755 "$RELEASES"
test ! -e "$CANDIDATE"
exec 9>/run/lock/korzinamarket-deploy.lock
flock -n 9
as_shop git fetch origin main
test "$(as_shop git rev-parse origin/main)" = "$RELEASE_SHA"
as_shop git merge-base --is-ancestor 3601b3476f61382d2693e96ba7b36f1ed82af1f2 "$RELEASE_SHA"
as_shop git worktree add --detach "$CANDIDATE" "$RELEASE_SHA"
cd "$CANDIDATE"
test "$(as_shop pnpm --version)" = 11.24.0
as_shop pnpm install --frozen-lockfile --prod=false
as_shop /usr/bin/node --env-file="$API_ENV" apps/api/node_modules/prisma/build/index.js \
  generate --config apps/api/prisma7.config.ts
as_shop pnpm build
test -s apps/api/dist/main.js; test -s apps/web/.output/server/index.mjs
as_shop /usr/bin/node --env-file="$API_ENV" --input-type=module <<'NODE'
let db;
try {
  const { DbService } = await import('./apps/api/dist/db/db.service.js');
  db = new DbService();
  const rows = await db.$queryRawUnsafe("SELECT current_setting('TimeZone') AS timezone");
  if (rows[0]?.timezone !== 'UTC') throw new Error('Unapproved session timezone');
  console.log('Actual Prisma adapter session uses UTC');
} catch {
  console.error('Adapter session preflight failed; investigate privately before release');
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
NODE
test -z "$(as_shop git status --porcelain --untracked-files=all)"
as_shop git ls-tree -r "$RELEASE_SHA" -- apps/api/prisma/migrations > "$RUN_DIR/migrations.manifest"
printf '%s\n' "$RELEASE_SHA" > "$RUN_DIR/candidate.sha"
systemctl cat shop-api.service shop-web.service > "$RUN_DIR/previous-units.private"
cp --preserve=mode,timestamps "$GATE_TARGET" "$RUN_DIR/previous-gate.private"
```

До install/build сравнить измеренные размеры свободного места с бюджетом: candidate
source + node_modules + builds, старые artifacts, PG/WAL/temp, backup и запас роста.
Задать фактические byte/inode пороги по репетиции, а не универсальные «5 ГБ».
Повторить df после build; при нехватке STOP, без prune/clean/rm/uploads удаления.
На VPS около 50 ГБ dump/restore должны жить на проверенном внешнем storage/staging;
restore-копия не создаётся на production-диске. Сохранить старые исполняемые сборки,
dependencies, units/drop-ins и защищённую конфигурацию; одного git ref мало.

### 8.3. Maintenance и полная остановка старых writers

В `$RUN_DIR/extra-writers.units` эксплуатация заранее записывает **проверенные**
дополнительные unit names по одному в строке, пустой файл — только если inventory
подтвердил отсутствие дополнительных units. Также нужны результаты проверки
cron/import/seed/image-runner/внешних hosts и план каждой очереди. Этот файл
не является shell-скриптом. Transport Gateway без DB не надо обновлять только
из-за нового SHA: его runtime src относительно main не менялся, но ingress/tunnel
должны удерживаться gate; неизвестные DB-writers нельзя игнорировать.

```bash
# НЕ ВЫПОЛНЕНО — закрывает ingress и останавливает процессы; только в утвержденное окно
test -f "$RUN_DIR/writers-inventory.approved"
test -f "$RUN_DIR/extra-writers.units"
mapfile -t EXTRA_UNITS < "$RUN_DIR/extra-writers.units"
STOP_UNITS=(shop-web.service shop-api.service)
for u in shop-chat-cleanup.timer shop-chat-cleanup.service; do
  if [[ $(systemctl show -p LoadState --value "$u") == loaded ]]; then STOP_UNITS+=("$u"); fi
done
for u in "${EXTRA_UNITS[@]}"; do
  [[ $u =~ ^[A-Za-z0-9_.@:-]+\.(service|timer|target)$ ]]
  STOP_UNITS+=("$u")
done
: > "$RUN_DIR/previously-active.units"
for u in "${STOP_UNITS[@]}"; do
  if systemctl is-active --quiet "$u"; then printf '%s\n' "$u" >> "$RUN_DIR/previously-active.units"; fi
done
install -m 0644 "$K17_GATE_ON" "$GATE_TARGET"
nginx -t; systemctl reload nginx
# Проверить 503 извне и доступ оператора/server SSR из разрешенной области ДО продолжения.
systemctl stop "${STOP_UNITS[@]}"
for u in "${STOP_UNITS[@]}"; do ! systemctl is-active --quiet "$u"; done
dbsql <<'SQL'
BEGIN READ ONLY;
SELECT count(*)=0 FROM pg_stat_activity
 WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start IS NOT NULL;
SELECT count(*)=0 FROM pg_prepared_xacts WHERE database=current_database();
COMMIT;
SQL
```

Оба результата должны быть `t`; расследовать остальные подключения и возможность
нового writer, без pg_terminate_backend чужих сессий. Таймер stop не гарантирует
остановки уже запущенного oneshot — поэтому в списке и service. Никакого старого
API/import/seed до завершения cutover. Не полагаться на закрытый frontend как на gate.

### 8.4. Финальный backup и снимок инвариантов

```bash
# НЕ ВЫПОЛНЕНО — создает backup во внешнем storage при остановленных writers
docker exec "$DB_CONTAINER" sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$RUN_DIR/database.dump"
test -s "$RUN_DIR/database.dump"
(cd "$RUN_DIR" && sha256sum database.dump > database.dump.sha256)
(cd "$RUN_DIR" && sha256sum -c database.dump.sha256)
docker exec -i "$DB_CONTAINER" pg_restore --list < "$RUN_DIR/database.dump" > "$RUN_DIR/database.toc"
docker exec "$DB_CONTAINER" sh -c \
  'exec pg_dumpall -U "$POSTGRES_USER" --globals-only --no-role-passwords' > "$RUN_DIR/roles.private.sql"
# Products резервируются отдельно; chat photos не включаются в долгосрочный общий архив.
tar -C /var/lib/korzinamarket/uploads -czf "$RUN_DIR/products.tar.gz" products
test -s "$RUN_DIR/products.tar.gz"
(cd "$RUN_DIR" && sha256sum products.tar.gz > products.tar.gz.sha256)
```

Проверить каждую exit status, внешнюю доступность и сохранность archive/checksum.
Secret manager, roles/grants и uploads retention проверяются отдельно. Globals
без паролей не заменяют защищённый backup credentials; не выводить его содержимое.
Chat recovery согласуется с действующей privacy/retention policy, не выполнять
общий архив chat и не создавать долгоживущую историю версий.

Следующий read-only SQL даёт bounded-memory отпечатки старых полей. Это контроль
изменений, не криптографическая замена dump/restore. Запускается до нового API,
пока нет jobs или заказов; время сканирования предварительно измерить на копии.

```bash
# НЕ ВЫПОЛНЕНО — создает диагностический SQL/результат, не меняет доменные данные
cat > "$RUN_DIR/preservation.sql" <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='120s';
WITH rows AS (
 SELECT 'User' AS tab,to_jsonb(t)-'adminPasswordHash' AS payload FROM "User" t
 UNION ALL SELECT 'Product',to_jsonb(t)-ARRAY['serviceMarkupPercentOverride','serviceMarkupNeedsReview'] FROM "Product" t
 UNION ALL SELECT 'ShopSettings',to_jsonb(t)-'globalServiceMarkupPercent' FROM "ShopSettings" t
 UNION ALL SELECT 'TelegramIdentity',to_jsonb(t) FROM "TelegramIdentity" t
 UNION ALL SELECT 'OrderPhone',to_jsonb(t) FROM "OrderPhone" t
 UNION ALL SELECT 'Order',to_jsonb(t) FROM "Order" t
 UNION ALL SELECT 'OrderItem',to_jsonb(t) FROM "OrderItem" t
 UNION ALL SELECT 'OrderPayment',to_jsonb(t) FROM "OrderPayment" t
 UNION ALL SELECT 'PromoCode',to_jsonb(t) FROM "PromoCode" t
 UNION ALL SELECT 'AdminAudit',to_jsonb(t) FROM "AdminAudit" t
)
SELECT tab,count(*),
 sum((('x'||substr(md5(payload::text),1,16))::bit(64)::bigint)::numeric),
 sum((('x'||substr(md5(payload::text),17,16))::bit(64)::bigint)::numeric)
FROM rows GROUP BY tab ORDER BY tab;
SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a
 JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='"Product"'::regclass AND a.attname='normalizedPrice';
SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='Product'
 AND indexdef LIKE '%normalizedPrice%' ORDER BY indexname;
COMMIT;
SQL
dbsql < "$RUN_DIR/preservation.sql" > "$RUN_DIR/before.txt"
```

### 8.5. Обязательное фактическое восстановление — на отдельном staging host

Проверка TOC/checksum не доказывает восстановление. Команды ниже выполняются
**только в отдельной сессии на staging**, не на VPS с ограниченным диском.
Копия dump должна быть доступна там по защищённому каналу; повторно сверить checksum.

```bash
# НЕ ВЫПОЛНЕНО — ТОЛЬКО STAGING: новый контейнер/volume, loopback, synthetic credentials
set -euo pipefail
umask 077
: "${K17_PRODUCTION_HOST:?фактический hostname production}"
test "$(hostname -f)" != "$K17_PRODUCTION_HOST"
: "${K17_RESTORE_DUMP:?защищенная копия финального dump}"
: "${K17_RESTORE_ENV:?защищенный staging env POSTGRES_USER/DB/PASSWORD}"
RESTORE_CONTAINER="korzina-release17-restore-$(date -u +%Y%m%dT%H%M%SZ)"
docker run -d --name "$RESTORE_CONTAINER" \
  --mount "type=volume,source=$RESTORE_CONTAINER,target=/var/lib/postgresql" \
  --env-file "$K17_RESTORE_ENV" -p 127.0.0.1:15437:5432 postgres:18.6-bookworm
ready=0
for i in $(seq 1 60); do
  if docker exec "$RESTORE_CONTAINER" sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
docker exec -i "$RESTORE_CONTAINER" sh -c \
 'exec pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$K17_RESTORE_DUMP"
```

На staging подключить **ту же** candidate-сборку к этой БД с отдельным sandbox
api.env: новый test AUTH_SECRET, никакого production DATABASE_URL/provider tokens,
внешние SMS/Telegram/payment/delivery выключены. Выполнить preservation.sql до/после,
migrate deploy полного manifest, readiness, fee/phone/permission/replay smoke и
сравнение истории. Профили с dedicated DB-name guards запускать в отдельно созданных
тестовых БД, не обходить guards и не выдавать restored production DB за тестовую.
Отметить фактические время/WAL/disk/lock wait и восстановление product files.

`--no-owner --no-acl` проверяет архив/данные и требует отдельного rehearsal реальных
role/grants для полноценного DR. Не загружать globals вслепую поверх существующих
roles. Только после проверки ролей, RTO/RPO и данных подписать restore receipt;
владельцу выпуска явно решить, держать ли maintenance всё время финального restore.
На production до этого шага миграции НЕ применять. Вернуться в прежнюю production
bash-сессию для следующих блоков, сохранив её RUN_DIR/DB_CONTAINER/CANDIDATE.

### 8.6. Миграции до переключения приложения

```bash
# НЕ ВЫПОЛНЕНО — изменяет production schema, только после допуска/restore receipt
test -f "$RUN_DIR/production-restore.approved"
cd "$CANDIDATE"
test "$(as_shop git rev-parse HEAD)" = "$RELEASE_SHA"
# migrate status до deploy может вернуть nonzero из-за ожидаемых pending migrations:
if as_shop /usr/bin/node --env-file="$API_ENV" apps/api/node_modules/prisma/build/index.js \
  migrate status --config apps/api/prisma7.config.ts > "$RUN_DIR/migrate-before.log" 2>&1; then
  printf 'No pending migrations reported\n'
else
  printf 'STOP: manually inspect status; continue only for the exact approved pending manifest\n'
fi
test -f "$RUN_DIR/migration-preflight.approved"
as_shop /usr/bin/node --env-file="$API_ENV" apps/api/node_modules/prisma/build/index.js \
  migrate deploy --config apps/api/prisma7.config.ts > "$RUN_DIR/migrate-deploy.log" 2>&1
as_shop /usr/bin/node --env-file="$API_ENV" apps/api/node_modules/prisma/build/index.js \
  migrate status --config apps/api/prisma7.config.ts > "$RUN_DIR/migrate-after.log" 2>&1
dbsql < "$RUN_DIR/preservation.sql" > "$RUN_DIR/after.txt"
diff -u "$RUN_DIR/before.txt" "$RUN_DIR/after.txt"
dbsql <<'SQL'
BEGIN READ ONLY;
SELECT count(*)=0 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT "globalServiceMarkupPercent" FROM "ShopSettings" WHERE id=1;
SELECT count(*) FROM "Product" WHERE "serviceMarkupPercentOverride" IS NULL;
SELECT "serviceMarkupPercentOverride","serviceMarkupNeedsReview",count(*) FROM "Product" GROUP BY 1,2 ORDER BY 1,2;
SELECT count(*) FROM "ServiceFeeBulkOperation";
SELECT count(*) FROM "Product" p CROSS JOIN "ShopSettings" s WHERE s.id=1
 AND p."serviceMarkupPercent" IS DISTINCT FROM coalesce(p."serviceMarkupPercentOverride",s."globalServiceMarkupPercent");
COMMIT;
SQL
```

Ожидаются все 54 применённые миграции, нет unfinished; первый global =10,
нет автоматически global-товаров, BulkOperation пуста, invariant=0.
Если эти миграции уже были ранее применены, сравнивать с preflight, а не требовать
сброса процентов/таблиц к пустому состоянию. Не считать 173 константой production:
сверить фактические counts, все прежние overrides/0%, review и историю.
Timeout/DDL error/check mismatch — STOP, сервисы и gate остаются закрытыми.
Не переключать приложение после частичного deploy даже при зелёном liveness старой версии.

### 8.7. Согласованное переключение API/Web/cleanup

Ниже drop-ins для подтверждённых в Git units. Дополнительные DB-writers требуют
собственного проверенного перехода на тот же SHA; нельзя автоматически запустить
старый import/cron по сохранённому списку. В staging проверить приоритет drop-ins,
EnvironmentFile/hardening и `systemd-analyze verify`. Units из Git не копировать
поверх фактических серверных units как часть этого ручного переключения.

```bash
# НЕ ВЫПОЛНЕНО — меняет пути запуска; старые outputs и directories сохраняются
test -f "$RUN_DIR/db-validation.approved"
DROPIN=zzzz-release17.conf
switch_unit() {
  local unit=$1 entry=$2 path="/etc/systemd/system/$1.d/$DROPIN"
  test -f "$CANDIDATE/$entry"
  test ! -e "$path"
  install -d -m 0755 "/etc/systemd/system/$unit.d"
  (set -o noclobber; printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=/usr/bin/node %s/%s\n' \
    "$CANDIDATE" "$CANDIDATE" "$entry" > "$path")
  chmod 0644 "$path"
  sha256sum "$path" >> "$RUN_DIR/release-dropins.sha256"
}
switch_unit shop-api.service apps/api/dist/main.js
switch_unit shop-web.service apps/web/.output/server/index.mjs
if [[ $(systemctl show -p LoadState --value shop-chat-cleanup.service) == loaded ]]; then
  switch_unit shop-chat-cleanup.service apps/api/dist/order/chat-cleanup.cli.js
fi
systemctl daemon-reload
systemd-analyze verify shop-api.service shop-web.service
test "$(systemctl show -p WorkingDirectory --value shop-api.service)" = "$CANDIDATE"
test "$(systemctl show -p WorkingDirectory --value shop-web.service)" = "$CANDIDATE"
systemctl show -p ExecStart --value shop-api.service | grep -Fq "$CANDIDATE/apps/api/dist/main.js"
systemctl show -p ExecStart --value shop-web.service | grep -Fq "$CANDIDATE/apps/web/.output/server/index.mjs"
# Это начало работы новых API jobs/уведомлений, а не полностью read-only режим.
START_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
systemctl start shop-api.service
curl -fsS --retry 10 --retry-connrefused --retry-delay 2 --max-time 10 http://127.0.0.1:4001/api/health/ready
systemctl start shop-web.service
systemctl is-active --quiet shop-api.service shop-web.service
```

Перед стартом подтвердить отсутствие старых API workers, выбранный момент
возобновления фоновых jobs и стабильность gateway/delivery endpoints.
Миграция-ошибка не должна приводить к автоматическому рестарту через deploy.sh trap.

### 8.8. Post-deploy smoke при закрытом публичном gate

```bash
# НЕ ВЫПОЛНЕНО — read-only HTTP probes; ответы с пользовательскими данными не печатать
curl -fsS --max-time 15 http://127.0.0.1:4001/api/health
curl -fsS --max-time 15 http://127.0.0.1:4001/api/health/ready
curl -fsS --max-time 30 -o "$RUN_DIR/home.html" http://127.0.0.1:3000/
curl -fsS --max-time 30 -o "$RUN_DIR/catalog.html" http://127.0.0.1:3000/catalog
curl -fsS --max-time 15 https://korzinamarket.ru/api/health/ready
curl -fsS --max-time 30 -o "$RUN_DIR/public-home.html" https://korzinamarket.ru/
curl -fsS --max-time 15 -o "$RUN_DIR/products.json" 'https://korzinamarket.ru/api/products?limit=1'
: "${K17_PRIMARY_COOKIES:?защищенный cookie jar разрешенной primary сессии}"
: "${K17_DELEGATE_COOKIES:?защищенный cookie jar разрешенной delegated сессии}"
for kind in primary delegate; do
  jar=$K17_PRIMARY_COOKIES; [[ $kind != delegate ]] || jar=$K17_DELEGATE_COOKIES
  curl -fsS --cookie "$jar" -o "$RUN_DIR/$kind-permissions.json" \
    https://korzinamarket.ru/api/admin/users/permissions
  curl -fsS --cookie "$jar" -o "$RUN_DIR/$kind-settings.json" \
    https://korzinamarket.ru/api/admin/settings
done
# Delegated apply получает заведомо невалидную подпись: даже при дефекте прав этот запрос не может применить bulk.
status=$(curl -sS -o "$RUN_DIR/delegate-denial.json" -w '%{http_code}' \
 --cookie "$K17_DELEGATE_COOKIES" -H 'Content-Type: application/json' \
 --data '{"previewToken":"release17-invalid-signature","requestId":"fe7f0117-7b58-4917-ad0d-72146cac9ab8","confirmed":true}' \
 https://korzinamarket.ru/api/admin/products/service-fee/bulk/apply)
test "$status" = 403
# Проверить SSE initial sync/heartbeat через реальный proxy; timeout 28 у открытого потока ожидаем.
sse_exit=0
curl -sS -N --max-time 12 --cookie "$K17_PRIMARY_COOKIES" \
 https://korzinamarket.ru/api/admin/events/stream > "$RUN_DIR/events-stream.private" || sse_exit=$?
[[ $sse_exit == 0 || $sse_exit == 28 ]]
grep -q '^event: sync' "$RUN_DIR/events-stream.private"
```

Проверить фактические JSON primaryAdmin=true/false, отсутствие fee controls и
закрытых событий у delegated, auth/me/профиль для разрешённых сессий, mobile
320/768/1280 и refresh старой вкладки. Cookie jar/PII не копировать в issue/log.
Владелец просматривает **существующие** разрешённые заказы без смены статуса,
проверяет totals/snapshots и интерфейс корзины/quote; гостевой cart GET может
создать техническую guest session, поэтому это отдельно разрешённый smoke.

OTP login создаёт сессию и может отправить SMS; Telegram login/contact и checkout
также изменяют состояние. Полные auth/guest/checkout/payment/Telegram сценарии
выполнять на staging restored copy без настоящих отправителей. На production —
только отдельно согласованный synthetic scenario, без случайных реальных заказов,
оплат, global changes, bulk apply и тестовых сообщений покупателям.
Primary preview допустим лишь как отдельно одобренный read-only расчёт выбранного
набора; compare financial audit/result counts до/после, никакого подтверждения apply.

### 8.9. Открытие и наблюдение

```bash
# НЕ ВЫПОЛНЕНО — возвращает public ingress; только после подписанного smoke
test -f "$RUN_DIR/smoke.approved"
test -f "$RUN_DIR/extra-writers-version.approved"
# Сначала вручную включить только проверенные новые writers из inventory, по одному с health check.
if grep -Fxq shop-chat-cleanup.timer "$RUN_DIR/previously-active.units"; then
  systemctl start shop-chat-cleanup.timer
fi
install -m 0644 "$K17_GATE_OFF" "$GATE_TARGET"
nginx -t; systemctl reload nginx
curl -fsS --max-time 15 https://korzinamarket.ru/api/health/ready
curl -fsS --max-time 30 -o "$RUN_DIR/open-home.html" https://korzinamarket.ru/
journalctl -u shop-api.service -u shop-web.service --since "$START_TIME" --no-pager \
 > "$RUN_DIR/application.private.log"
df -PB1 -- "$PGDATA_HOST" "$RELEASES" "$BACKUP_ROOT"
```

В первый час и следующий рабочий цикл контролировать health/ready, 400 старых
payloads, 403 permissions, 409 stale/locks/replay, 5xx/503 bulk secret; DB locks,
deadlocks, transactions/WAL/free disk/inodes, effective invariant=0, audit/outbox
PENDING/SENDING/UNKNOWN/FAILED, duplicate orders и checkout snapshots. Logs локально
редактировать перед передачей; не публиковать cookies/tokens/preview body.
Для gateway health отдельно подтвердить реальный host/port/unit: `/health` —
только liveness, не доказательство доступности Telegram или верности bot identity.

## 9. Остановка, rollback и восстановление БД

| Точка отказа | Действие |
|---|---|
| Build/preflight до maintenance | прекратить выпуск; production не переключать, candidate оставить для диагностики |
| Backup/restore до migrate | gate и writers держать закрытыми; после проверки, что схема неизменна, отдельно разрешить возврат прежней пары |
| Любая migration error/partial DDL | ничего не запускать; сохранить status/log/schema; исследовать commit каждой миграции, не делать resolve/reset/retry вслепую |
| После успешных migrations, до start | gate закрыт; forward fix или заранее проверенная совместимая rollback-пара; старый main не получает writes |
| API/Web/drop-in частичный сбой | остановить оба; сверить effective ExecStart/WorkingDirectory и SHA, исправить пару согласованно, не смешивать workers |
| После открытия writes | снова gate/stop; сохранить новые операции, forensic backup; никакого restore поверх живой БД |

```bash
# НЕ ВЫПОЛНЕНО — аварийная фиксация закрытого состояния, не откат данных
install -m 0644 "$K17_GATE_ON" "$GATE_TARGET"
nginx -t; systemctl reload nginx
systemctl stop "${STOP_UNITS[@]}"
systemctl show shop-api.service shop-web.service -p ActiveState -p WorkingDirectory \
 > "$RUN_DIR/failure-state.private"
journalctl -u shop-api.service -u shop-web.service --since "$START_TIME" --no-pager \
 > "$RUN_DIR/failure.private.log"
```

**Откат приложения:** после миграций допускается только artifact-пара, проверенная
на новой schema/global/override/idempotency; её SHA и путь фиксируются заранее.
Отсутствие такой пары — причина сохранить maintenance и делать forward fix/DR.
До применения миграций прежняя пара допустима, если schema действительно неизменна.
Git revert/reset не откатывает Prisma, цены или новые заказы.

Для удаления только влияния созданных этим runbook drop-ins можно обратимо убрать
именно эти известные файлы, сохранив их для анализа. Команда не запускает старый код:

```bash
# НЕ ВЫПОЛНЕНО — обратимый перенос только собственных проверенных drop-ins
sha256sum -c "$RUN_DIR/release-dropins.sha256"
for u in shop-api.service shop-web.service shop-chat-cleanup.service; do
  p="/etc/systemd/system/$u.d/zzzz-release17.conf"
  if [[ -f $p ]] && grep -Fq "  $p" "$RUN_DIR/release-dropins.sha256"; then
    grep -Fq "WorkingDirectory=$CANDIDATE" "$p"
    test ! -e "$RUN_DIR/$u.release17.conf"
    mv -- "$p" "$RUN_DIR/$u.release17.conf"
  fi
done
systemctl daemon-reload
# STOP: проверить совместимость схемы, пару артефактов и effective units до какого-либо start.
```

Для совместимого rollback release создать отдельные drop-ins с его подтверждёнными
абсолютными путями тем же switch_unit, предварительно назначив CANDIDATE этому
проверенному release. Нужен новый отдельный RUN_DIR для rollback receipts; заново
API ready → matching Web → smoke → разрешённые writers/gate. Не запускать старый
main на новой схеме даже при global10: он не поддерживает согласованную запись override.

**Восстановление БД:** не автоматическое продолжение deploy и требует отдельного
решения владельца. Повторить verified pg_restore в НОВЫЙ target/instance, сохранить
исходную БД. Восстановить роли/grants из согласованной процедуры и проверить
User/phones, историю, суммы/платежи, guest sessions, AdminAudit и committed requestId.
Сверить ВСЕ заказы/оплаты/аудит после backup с внешними провайдерами до переключения;
не терять их молча. RPO/RTO и перенос подтверждённых новых операций утверждаются
отдельно. Backup schema должна соответствовать выбранному app SHA.

Переключить DATABASE_URL в защищённом api.env через sudoedit/secret manager на
новый подтверждённый target, не печатая значения, при закрытом gate и остановленных
writers. Пройти readiness и всю матрицу smoke. Не выдавать автоматически разрешение
на записи. Не выполнять drop database/table/volume, migrate reset, destructive
cleanup или restore поверх живых данных. Повреждённые данные и logs сохраняются.

## 10. Итог и артефакты

Локальные новые receipts: `work/readiness17/` (admin-smoke, checkout typechecks,
Prisma validate, Linux profile/JSON и read-only Git archive точного SHA).
Ни эти archives, ни Docker volume, dumps, секреты или .env в коммит не включаются.
Контейнеры Linux тестов имеют отдельные имена korzina-readiness17-*;
исходники переданы через read-only archive, production credentials отсутствовали.
Все 14 Bash-блоков проверены через bash -n; оба встроенных Node helper — через
node --check. Preservation SQL реально выполнен в READ ONLY транзакции на отдельной
обновлённой PostgreSQL-БД 1.6Б. Это синтаксическая/локальная проверка подготовленных
команд, не заявление об исполнении runbook на production или о репетиции systemd cutover.

**Merge — READY:** текущий main не продвинулся, история и функциональности сохранены,
совместные миграции/регрессии проверены; publication/PR/merge всё ещё требуют разрешения.
**Deploy — NOT READY:** нужны реальные inventory/env/TZ/locale/systemd/disk checks,
maintenance и writer cutover rehearsal, production backup + проверенное восстановление,
role/grants и rollback/DR решение. Три baseline UI FAIL остаются отдельным явным
решением владельца, OIDC replay — обязательным security gate, а не принимаемым риском.

ЭТАП 1.7 завершён. Ожидаю разрешения на объединение с main.
