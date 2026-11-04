# KorzinaMarket — интеграция сервисного процента, ЭТАП 1.6А

Дата: 04.11.2026. Подэтап исправлений завершён; полный допуск к main и deployment
остаётся **NOT READY до ЭТАПА 1.6Б**. Production не использовался.

## Происхождение

Интеграционный worktree: `F:\Shop\.worktrees\agency-fee-unified`.
Ветка: `integration/agency-fee-unified`.

- `origin/main`: `508463cfade2112f375dca89d46f2c9e0c9cabdc`, повторный fetch выполнен.
- Начальная версия unified-user-phone: `04ba6caf51f5fa2ccc7a352a0fc3bf6314bef19e`.
- Её предок delegated-admin/event-center: `6bb6bc33cf354b11e34a8a8cce16d3ba11aadb03`.
- Вторая сторона обычного merge: `a388c69691bdfcd47d6a1821c0dba9957d482c35`.
- Fee-история сохранена: `6ea1c0c` → `bc871ba` → `fd87e8a` → `a388c69`.

Повторного объединения delegated-admin нет. Squash/rebase не выполнялись.
Исходные ветки и рабочие деревья не изменялись. Незакоммиченные файлы
`C:\Users\batti\Shop` не включены.

Основа решения — сохранённые `audit-report.md` и `release-runbook.md` из
`F:\Shop\.worktrees\agency-service-fee-audit-20261103\work\audit-15`.
Этапы 1.1–1.5 не выполнялись заново.

## Четыре исправления

1. В `admin.spec.ts` сохранены проверки обеих сторон: async pricing, fee fixtures,
   raw lock mocks, вызовы управления ролями с actorId и запрет делегированного
   понижения ADMIN. Удалены конфликтные маркеры и дубли автоматически объединённых
   объявлений. Добавлена совместная проверка primary permissions и individual 0%.
2. Upgrade-тест выбирает `20261103120000_event_center` по точному имени, проверяет
   прежние ожидания redaction/PII, затем применяет оставшиеся миграции и повторно
   проверяет сохранность ID и delivery status. Исторические SQL-файлы не менялись.
3. Новая миграция `20261104120000_service_fee_events` обновляет существующие
   `event_values` и `record_admin_change` одной транзакцией. Добавлены global,
   override и review; прежний effective процент сохранён. NULL и 0 различаются,
   поэтому individual10 → global10 и обратный переход дают событие при неизменной
   цене. Используется прежний AdminChange/outbox как проекция; доменный источник
   финансового аудита — существующий AdminAudit. Нового журнала или таблицы нет.
4. Global/bulk controls и столбец выбора процентов зависят от серверного
   `/admin/users/permissions.primaryAdmin`. При false или недоступном permissions
   они скрыты. Телефон во frontend не добавлен. Отзыв прав обрабатывается понятным
   сообщением 403; backend по-прежнему независимо проверяет актора в транзакции.

Fee-события изменения Product и глобального процента помечены ownerOnly и не
попадают в ленту delegated ADMIN. Сохраняются актор и прежние/новые значения.
Успешный bulk создаёт прежний AdminAudit и обычную проекцию строковых изменений.
Идентичный committed requestId возвращает durable result без повторных Product,
updatedAt, AdminAudit и AdminChange. Ошибка сохранения результата откатывает все
доменные изменения и проекции; interceptor сохраняет только закрытое системное
событие INTERNAL_ERROR без preview token или тела запроса. Ожидаемые 4xx не
превращаются в финансовые события.

Делегированный ADMIN сохраняет существующие возможности Product API и чтения
settings; эта интеграция не меняет политику индивидуального редактирования товаров.
Глобальная настройка и bulk остаются primary-only. Поэтому прежний fee-тест
«OTHER_ADMIN не может даже читать settings» разделён: чтение — 200, глобальная
запись — 403 с проверкой неизменности данных. Основание — реально объединённый
AdminGuard и отдельные HTTP-проверки настоящих ADMIN-строк в новой фикстуре.
Соответствующий browser smoke адаптирован к тому же контракту; его запуск — в 1.6Б.

## Фактические профильные проверки

| Проверка | Результат |
|---|---:|
| API typecheck, включая catalog config | успешно |
| Web typecheck | успешно |
| Отдельный строгий tsc затронутых E2E | успешно |
| API lint / Web lint | успешно |
| Prisma format / validate / generate | успешно |
| Backend unit, 8 файлов | 126 passed |
| Из них admin/admin.spec.ts | 42 passed |
| PostgreSQL, 6 файлов | 92 passed |
| Delegated-admin / event-center | 13 passed |
| Service fee backend | 33 passed |
| Bulk preview/apply | 30 passed |
| Bulk additive migration | 4 passed |
| Foundation migration | 6 passed |
| Новая fee/event/permissions интеграция | 6 passed |
| Frontend: fee, bulk, formatter/403, реальные Vue templates | 25 passed |
| Git diff --check и отсутствие конфликтных маркеров | успешно |

Восемь backend unit-файлов: admin/admin, admin/errors, admin/events-query,
admin/owner, admin/service-fee, auth/admin, auth/admin.guard, product/pricing.
Frontend templates проверяют primary, delegated и отсутствие permissions;
это SSR unit-проверки реальных шаблонов, а не браузерный smoke.

Использован новый PostgreSQL 18 на loopback:8933, ICU ru-RU, TimeZone UTC,
с двумя новыми синтетическими БД и уникальными схемами. Тесты последовательно
применяют совместные миграции. Проверены 173 сохранённых исключения, 0%, история,
normalizedPrice, stale preview, конкурентные операции и rollback. URL рабочей БД
не используется как fallback. Секреты и токены в этот документ не включены.
Логи и JSON receipts находятся только в игнорируемом `work/`.

Первый прогон имел два тестовых сбоя: старое ожидание 403 на delegated GET settings
и сериализация BigInt в новой проверке. После адресного исправления весь набор
92/92 прошёл. Строгий дополнительный tsc выявил недостающие description/active/sort
в новой фикстуре: поля добавлены, tsc и все шесть новых E2E повторены успешно.
Ошибка кодировки нового frontend-теста исправлена; итоговый прогон 25/25.
Ожидания финансовых формул, rollback, авторизации и исторической redaction не ослаблялись.

## Изменения поверх автоматически объединённого кода

- `apps/api/src/admin/admin.spec.ts`
- `apps/api/test/delegated-admin.e2e-spec.ts`
- `apps/api/test/service-fee-backend.e2e-spec.ts`
- `apps/api/test/service-fee-events.e2e-spec.ts`
- `apps/api/prisma/migrations/20261104120000_service_fee_events/migration.sql`
- `apps/api/src/admin/activity-format.ts`
- `apps/api/src/admin/activity.interceptor.ts`
- `apps/web/app/pages/admin/settings.vue`
- `apps/web/app/pages/admin/products/index.vue`
- `apps/web/app/components/admin/ServiceFeeBulk.vue`
- `apps/web/app/utils/events.ts`
- `apps/web/app/utils/service-fee.ts`
- `apps/web/test/fixtures/service-fee-api.mjs`
- `apps/web/test/service-fee.smoke.mjs`
- `apps/web/test/service-fee-events.test.mjs`
- `apps/web/test/service-fee-permissions.test.mjs`
- `docs/agency-service-fee.md`
- `docs/agency-fee-integration-16a.md`

Полный перенос fee-изменений относительно начального unified commit виден через
`git diff --stat 04ba6ca HEAD`; происхождение сохраняет merge-коммит с двумя родителями.

## Уточнение release runbook совместной версии

Это план будущего отдельно разрешённого выпуска, не выполненные операции.

1. После 1.6Б зафиксировать точный объединённый SHA. Read-only проверить фактические
   production migrations, locale/TZ, распределение процентов/0%, normalizedPrice,
   агрегаты истории, активные транзакции и место для WAL, backup и обоих релизов.
2. Подготовить совпадающую пару API/web, прежние артефакты и совместимый rollback.
   Обязателен защищённый `SERVICE_FEE_PREVIEW_SECRET` длиной не менее 32 байт,
   единый у всех API workers. Не менять существующие auth/event secrets.
3. Проверить PostgreSQL backup фактическим восстановлением в отдельный instance.
   Перед финальным dump согласованно закрыть записи, остановить ВСЕ старые writers
   API/Telegram/import/seed и дождаться отсутствия транзакций.
4. Применять из утверждённого release через Prisma migrate deploy, в порядке:
   `20261103100000_delegated_admin_activity`, `20261103120000_event_center`,
   `20261103150000_global_service_fee`, `20261104090000_service_fee_bulk_operation`,
   `20261104120000_service_fee_events`. Существующие checksums не переписывать.
   Последняя миграция меняет функции, без массового UPDATE и нового журнала.
   Foundation требует ACCESS EXCLUSIVE на Product/ShopSettings; 5s — только lock wait.
   Оценка длительности и контролируемые session timeouts нужны на восстановленной копии.
5. Проверить отсутствие unfinished migrations, сохранность старых процентов/цен/
   истории, пустой bulk result при первом выпуске и invariant
   effective = coalesce(override, global). Не переводить 173 товара автоматически.
6. Запустить API и matching frontend одного SHA, сохраняя write gate. Старый и новый
   admin payload несовместимы: rolling update без дополнительного compatibility
   release запрещён; исключить старые процессы и потребовать обновления вкладок.
7. Read-only smoke: каталог/поиск/сортировка, корзина/quote, settings, preview без apply,
   primary/delegated permissions и приватность событий. Checkout/payment/Telegram
   только в sandbox либо по отдельно разрешённому сценарию. После согласования
   включать writers и наблюдать 400/403/409/5xx, locks/deadlocks, WAL/disk и invariant.
8. При отказе закрыть записи, сохранить БД/логи и вернуть совместимую rollback-пару.
   Git rollback не откатывает схему. Старый main не возобновляет запись на новой
   fee-схеме; предпочтителен forward fix. Restore/PITR — только в новую БД с отдельным
   решением о сверке всех заказов/платежей после backup, без перезаписи живой БД.

## Осталось для ЭТАПА 1.6Б

Полные API/frontend/gateway unit, production builds, весь PostgreSQL E2E и checkout
E2E; Telegram/unified-phone/guest регрессии; браузерные smoke на 320/768/1280;
проверка конкретного финального SHA и итоговое решение об интеграции.
Полный browser smoke, build и deployment в 1.6А не заявляются.

Прежние baseline point-grid, OIDC replay при Moscow TimeZone и Russian FTS при
C locale не исправлялись и не скрывались. В 1.6Б при воспроизведении сравнивать с
чистым main. Сохранить отдельное решение о timezone/локали целевой среды.
Production preflight/backup restore и новое агентское оформление заказа остаются
за пределами этого подэтапа. Push, merge в main и deploy не выполнялись.
