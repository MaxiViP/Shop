# KorzinaMarket — полная интеграционная проверка, ЭТАП 1.6Б

Дата: 04.11.2026. **READY для контролируемого объединения с main** на основании
локальных проверок объединённого кода. Это не допуск к немедленному production
deploy: обязательные условия релизного этапа перечислены ниже. Новых блокирующих
регрессий в проверенном окружении PostgreSQL UTC / ICU ru-RU не обнаружено.

Production, реальные заказы, товары, покупатели и работающий бот не использовались.
Push, merge в main, deploy и ЭТАП 2 не выполнялись.

## Git и окружение

- Worktree: `F:\Shop\.worktrees\agency-fee-unified`.
- Ветка: `integration/agency-fee-unified`.
- Исходный HEAD: `039d42f53b629eec080a7cf2994481449077734f`, совпал с заданным.
- Итоговый проверенный HEAD кода: `fff35d6fa11c44a259e57c315045d478a37bbf1c`.
  Это отдельный локальный коммит исправлений и регрессий 1.6Б.
- Документ сохранён последующим docs-коммитом. Его HEAD определяется командой
  `git log -1 --format=%H -- docs/agency-fee-integration-16b.md`; он не меняет код.
- Локальный `origin/main`: `508463cfade2112f375dca89d46f2c9e0c9cabdc`.
  Новый fetch в 1.6Б не выполнялся; перед объединением нужно обновить ссылку
  и проверить возможное продвижение main.
- История сохранена: `6bb6bc3` → `04ba6ca`; fee `6ea1c0c` → `bc871ba` →
  `fd87e8a` → `a388c69`; обычный merge `039d42f`; исправления `fff35d6`.
- Прочитаны AGENTS.md, отчёт 1.6А, документация fee и сохранённые результаты.
  Другие worktrees не изменялись. Прерванная работа продолжена по её артефактам.
- Node 24.20.0, Nuxt 4.5.2, Prisma Client 7.10.0, PostgreSQL 18,
  отдельный headless Edge. Свободно после проверок: C: 51,4 ГиБ, F: 136,5 ГиБ.
- PostgreSQL только на loopback:8935, отдельный тестовый кластер и синтетические
  базы/схемы. URL рабочей БД не использовался как fallback.

## Исправления

1. `serviceFeeError` сохраняет конкретное серверное сообщение для 409 с кодом
   `SERVICE_FEE_*`. Ранее общий текст о занятых настройках скрывал инструкцию
   обновить stale preview. Общий конфликт блокировки и обработка 403 сохранены.
   Добавлена проверка stale/in-progress; backend-формулы и workflow не менялись.
2. Telegram shopping E2E теперь создаёт подтверждённый primary phone пользователя,
   согласованный с identity. Проверки сохранности primary phone заменили устаревшие
   ожидания NULL. Явно проверяется наличие callback_data перед использованием:
   дополнительный строгий tsc обнаружил здесь `string | undefined`.
3. Checkout расширен на 320/768 px наряду с 390/1280; Event Center и delegated-admin
   smoke — на 320/390/768/1280. Исправлен список ширин в диагностическом выводе.
4. Fee browser fixture использует реальный ActivityPrismaPg/interceptor, Event Center,
   cart/order services и синтетического покупателя с unified phone. Внешние
   уведомления подменены. Добавлен повторяемый `service-fee-flow.smoke.mjs`;
   его артефакты сохраняются в отдельном временном каталоге.

Изменены восемь файлов: `apps/api/test/customer-shopping.e2e-spec.ts`,
`apps/web/app/utils/service-fee.ts`, `apps/web/playwright.checkout.config.ts`,
`apps/web/test/delegated-admin.smoke.mjs`, `apps/web/test/events.smoke.mjs`,
`apps/web/test/fixtures/service-fee-api.mjs`,
`apps/web/test/service-fee-events.test.mjs`,
`apps/web/test/service-fee-flow.smoke.mjs`.
Prisma schema и исторические миграции в 1.6Б не изменялись.

## Точные результаты тестов

Повторы не прибавляются к общему числу уникальных тестов. Диагностические прогоны
с заведомо проблемной TimeZone приведены отдельно от основной зелёной серии.

| Набор | Passed | Skipped | Failed |
|---|---:|---:|---:|
| Полный API unit, 2084 теста | 2061 | 23 | 0 |
| Дополнительный hits SQL profile, весь файл | 12 | 0 | 0 |
| Полный PostgreSQL E2E, 31 файл | 626 | 0 | 0 |
| Финальный повтор Telegram shopping после tsc-исправления | 82 | 0 | 0 |
| Полный frontend после исправления 409 | 489 | 0 | 0 |
| Финальный профиль fee events/error formatter | 3 | 0 | 0 |
| Полный Gateway | 90 | 0 | 0 |
| Checkout browser E2E, четыре viewport | 88 | 0 | 0 |
| Browser smoke, число сценарных скриптов | 15 | 0 | 3 baseline |

Из 23 skipped в полном API unit **20 требуют Linux/POSIX**, а **3 SQL-теста hits**
требовали отдельного BADGES_TEST_DATABASE_URL. После возобновления весь hits.spec.ts
прошёл 12/12 на том же изолированном PostgreSQL, включая эти три теста.
Итого покрыто 2064 уникальных API unit-теста из 2084; 20 Linux-тестов остаются
непроверенными на Windows. Неверно считать все исходные 23 пропуска Linux-тестами.

Полный E2E включает: service-fee backend 33, bulk 30, bulk migration 4,
foundation 6, fee/events 6, delegated-admin 13, cart/quote 24, staff flow 39,
Telegram auth 35, customer shopping 82, customer bot 66, OTP 22, phase1 56,
promo codes 19, catalog import 11 и остальные HTTP/DB-профили.
Это поднаборы 626, а не дополнительные тесты.

API/Web/Gateway typecheck и lint прошли. Production builds всех трёх приложений
прошли; Web повторно собран после исправления 409. Дополнительный строгий tsc
пяти затронутых E2E прошёл после явной проверки callback_data, API lint повторён.
Prisma validate/generate прошли; format был выполнен для интеграционной схемы
в 1.6А. Generated Client используется реальными E2E и browser fixtures.
`git diff --check`, syntax check нового smoke и проверка конфликтных маркеров прошли.

Предупреждения зависимостей: deprecated pg concurrent query, Node exports mapping,
vite-tsconfig-paths и близость Nuxt Icon bundle к лимиту. Они не считаются падениями.
Сохранённые PowerShell NativeCommandError-записи от stderr сами по себе не являются
результатом команды: учитывались exit codes и JSON/итоговые отчёты тестов.

## PostgreSQL, upgrade и сохранность данных

Применены все **54 миграции** как на чистую БД, так и поверх схемы main с данными.
Экспорт main проверен по содержимому 1258 файлов. Сравнены старые колонки и строки
**44 таблиц**, а не только количество объектов после миграции.

Проверены обе delegated-admin/Event Center миграции, global fee,
bulk operation и дополнительная `20261104120000_service_fee_events`.
Unified phone не добавляет отдельную миграцию: поведение проверено совместно
с существующей схемой User/TelegramIdentity и её ограничениями.

Подтверждены сохранность пользователей и телефонов, владельцев исторических
заказов, order/items/payments, промокодов, цен, старого аудита и индивидуальных
процентов. Сохранены 173 исключения и индивидуальный 0%; автоматического перевода
старых товаров в global нет. Выражение generated column normalizedPrice сохранено.
Повторный migrate deploy не меняет данные.

Синтетический dump размером 195592 байта восстановлен в третью отдельную БД;
сравнение восстановленных данных прошло. Это проверка методики, **не проверенный
production backup** и не оценка длительности миграции реального каталога.
Migrate reset не выполнялся, существующие тестовые базы/файлы не удалялись.

Основные БД: TimeZone UTC, ICU ru-RU, русский FTS сопоставляет регистр корректно.
Отдельная C-locale БД воспроизвела несовпадение русского FTS. Фактическая локаль
и TimeZone production в этом этапе не исследовались.

## Checkout, деньги и Telegram

Checkout 88/88 работает через реальный NestJS, собранный Nuxt и изолированный
PostgreSQL на 320/768/390/1280. Проверены guest и OTP customer, сохранение корзины
при ошибке, повтор requestId, потеря ответа после commit, быстрый двойной клик,
изменение цены/слота и повторное подтверждение. Ошибка/timeout не считались успехом.

DB-профили проверяют промокоды, бесплатную/платную доставку, актуальную цену,
изменение веса и фактического количества, отсутствие/замены, подтверждение оплаты,
отмену и исторические snapshots. Backend остаётся источником денежных расчётов;
новая дублирующая frontend-формула не добавлялась.

Отдельный сквозной fee-flow проверил global15, новый global-товар, individual0,
сохранённый legacy10, preview/apply/replay и корзину unified buyer с subtotal 33000.
Checkout сохранил цены 11500/10000/11500 копеек и snapshots 15/0/15.
Последующее изменение глобального процента и bulk не изменили заказ и историю.

Telegram shopping 82/82, Telegram auth 35/35, customer bot 66/66 и Gateway 90/90:
каталог, цены, qty/min/step, корзина, checkout, primary phone, identity/session,
дедупликация update, статусы, staff notifications и отсутствие повторного заказа.
Сетевые провайдеры и отправители подменены; реальные сообщения не отправлялись.

## Event Center и полномочия

Реальный PostgreSQL-backed flow подтверждает смену individual10 → global10 при
нулевой разнице цены: событие содержит прежний override 10, новый NULL, актора
и ownerOnly. Global 15, individual 0 и bulk корректно отображаются.
Committed replay не меняет Product, updatedAt, AdminAudit и AdminChange.
DB-проверки подтверждают stale preview, конкурентность, rollback при ошибке аудита
и durable result. Ожидаемые 4xx не создают повторных финансовых событий.

Primary ADMIN может менять global/bulk. Делегированный ADMIN получает 403
на эти мутации; контролы скрыты через permissions.primaryAdmin, в том числе
при чтении через реальный API. Сохраняются его разрешённые операции с товарами
и чтение settings. USER/SELLER/owner не получают административные мутации.
Телефон primary не захардкожен во frontend. Backend самостоятельно проверяет права.

## Браузерные проверки и ограничения

Все 18 существующих/добавленного smoke-скриптов запущены, итог: **15 PASS,
3 подтверждённых baseline FAIL**, без отключения тестов или изменения ожиданий.

PASS: service-fee, service-fee-bulk, service-fee-flow, events, delegated-admin,
home, catalog, product-card, quick-shop, staff-weigh, map, seo, telegram-ssr,
first-screen, product-image.

Global settings, список/создание/редактирование товара, bulk preview/confirm/apply,
stale/replay, Event Center, permissions и checkout проверены на 320/768/1280.
Основные home/catalog smoke дополнительно проверили 360/390/1024/1440.
Проверены overflow, гидратация, серверные цены, доступность подтверждений и права.
Просмотрены также снимки grant-admin-320, bulk all-preview-320 и реального fee-event
center: модальные элементы и суммы помещаются на мобильной ширине.

Fee/bulk/flow и checkout используют реальные services/API/PostgreSQL с
синтетическими сессиями; общий events/delegated smoke использует API-фикстуры.
Home/catalog/product/profile-поведение проверено соответствующими smoke/E2E
фикстурами. Это не полная ручная проверка каждого маршрута на реальном телефоне
и не проверка внешних SMS/Telegram/delivery/payment-провайдеров.

Изначальные home/catalog/map остановились из-за отсутствия каталогов артефактов;
после подготовки каталогов прошли. Bulk выявил исправленный formatter 409.
Итоговые повторные результаты сохранены отдельно, первые сбои не скрыты.

## Подтверждённые baseline-проблемы

1. **Point-grid FAIL** на main и интеграции: одинаковые измерения всех 24 карточек,
   высоты 280,96875 и 289,078125 px при 320 px. Ожидания не ослаблены.
2. **Sale FAIL** на обоих вариантах: sale.smoke.mjs:118, отсутствует ожидаемая
   подпись «Иллюстрация товара». Продолжение сценария за этой точкой не проверено.
3. **Icons FAIL** на обоих вариантах: icons.smoke.mjs:206, `/: missing plus`.
   Оставшиеся этапы этого скрипта не объявляются прошедшими.
4. **OIDC replay при Europe/Moscow**: интеграция 32 passed / 3 failed / 0 skipped;
   main 24 passed / 2 failed / 0 skipped. Два общих replay/callback теста падают
   одинаково; дополнительный объединённый phone HTTP-тест также выявляет повторное
   использование callback. На UTC все 35 auth E2E проходят. Это существенный
   существующий security-риск среды, а не допустимое игнорирование replay.
5. **C locale**: русский FTS не находит ожидаемое совпадение регистра; ICU ru-RU
   проходит. Выбор локали обязателен в preflight.

Эти диагностические FAIL не входят в зелёные 626/626 UTC и не переименованы в PASS.
READY ограничен контролируемой интеграцией; выпуск на Moscow TimeZone/C locale
без устранения причин или проверенной конфигурации остаётся **NOT READY**.
20 Linux/POSIX тестов также требуют запуска на целевой платформе до выпуска.

## Условия и порядок следующего релизного этапа

1. Отдельно согласовать объединение/релиз. Обновить origin/main, проверить ancestry,
   повторить затронутые проверки при изменении базы. Использовать точный SHA
   исправлений и документации; не включать чужие незакоммиченные worktrees.
2. На Linux выполнить 20 непроверенных POSIX-тестов. Отдельными задачами решить
   baseline UI smoke; для выпуска явно принять или устранить оставшиеся дефекты.
   На копии целевого окружения повторить OIDC replay и русский поиск.
3. Провести read-only production preflight: migrations/checksums, TimeZone/locale,
   schema/search_path, normalizedPrice, распределение override/0%, история и аудит,
   active/prepared transactions, WAL и диск. Не менять вслепую локаль существующей БД.
   При несовпадении проверенной конфигурации или replay FAIL выпуск остановить.
4. Проверить наличие и требования ENV без вывода значений: DATABASE_URL, AUTH_SECRET,
   ADMIN_PHONE и действующие admin/auth/event secrets; SERVICE_FEE_PREVIEW_SECRET
   не менее 32 байт, одинаковый у всех API workers. Сохранить существующие OTP,
   Telegram/OIDC, cookie/proxy/CORS и NUXT_PUBLIC_API_BASE настройки.
   Тестовые режимы и синтетические credentials не переносить в production.
5. При диске около 50 ГБ заранее оценить свободное место, WAL, две сборки и объём
   backup. Большой dump не создавать на том же ограниченном диске: использовать
   защищённое внешнее хранилище и проверить реальное восстановление в отдельную БД.
   Сохранить прежние API/Web artifacts, migration manifest и конфигурацию.
6. Обязательно окно обслуживания с write gate. Остановить **все** старые writers:
   API workers, Telegram, import, seed и cron; дождаться завершения транзакций.
   Выполнить согласованный финальный backup. Обновление старого и нового writer
   вперемешку недопустимо: legacy payload и новая fee-схема несовместимы.
7. Применить migrate deploy утверждённого SHA: delegated admin → Event Center →
   global fee → bulk operation → fee/events. Не переписывать migration checksums.
   Учесть ACCESS EXCLUSIVE locks Product/ShopSettings; 5 секунд ограничивают ожидание
   блокировки, а не весь DDL. Оценить длительность на восстановленной копии.
8. До открытия записей проверить migration status, сохранность данных и invariant
   `effective = coalesce(override, global)`. 173 исключения не переводить автоматически.
   Запустить совпадающие API/Web одного SHA; исключить старые процессы/вкладки.
9. Read-only smoke: каталог/поиск/сортировка, quote, settings, preview без apply,
   primary/delegated и приватность Event Center. Checkout/payment/notifications
   проверять в sandbox или по отдельно утверждённому сценарию. Затем открыть writes
   и наблюдать 400/403/409/5xx, replay, locks/deadlocks, WAL/disk и snapshots.
10. При отказе снова закрыть writes, сохранить данные/логи; предпочтителен forward
    fix или совместимая rollback-пара. Git rollback не возвращает схему. Старый main
    не должен писать в новую fee-схему. Restore/PITR выполнять в новую БД с отдельным
    решением о сверке заказов и платежей после backup, не перезаписывать живую БД.

## Артефакты и итог

Логи/JSON находятся в игнорируемом `work/audit16b/`: backend-unit, gateway-unit,
postgres-e2e-clean-final, migration-report, browser-results/browser-retry-results,
baseline-comparison, main/integration-oidc-moscow, c-locale и resume-*.
Checkout: `work/checkout/artifacts/runner.log` и `work/checkout/report/index.html`.
Снимки и DB dumps не добавлены в Git. Новые tracked изменения проверены на
конфликтные маркеры, явный any, private keys, токены и credentials в URL;
секреты/.env и временные файлы в коммиты не включены.

Рекомендация: **READY для контролируемого объединения с main**, с последующим
отдельным релизным этапом и обязательными условиями выше. Production readiness
до preflight/восстановления backup/целевых проверок не заявляется.

ЭТАП 1.6Б завершён. Рекомендация: READY. Ожидаю решения по релизу.
