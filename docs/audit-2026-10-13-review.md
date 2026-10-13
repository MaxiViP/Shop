# Аудит: подготовка изменений приложения к review

База: main, 0486f0a. Проверка 13 октября 2026 года. Production не подключалась; deploy, merge и production-миграции не выполнялись.

## Проверенный объём

Повторное взвешивание WHOLE/BUNCH, Telegram-сборка через веб-взвешивание, доступность активных категорий в quote/cart/checkout/replacements, сортировка цены за кг/ед., ограниченный кэш рангов главной, защита review черновиков, H1/SSR/SEO и автоматические проверки.

DEMO, TEST_PHONE, OTP delivery, Telegram OIDC, guards, cookie/session implementation и клиентская авторизация не изменены. Два auth-related E2E fixture явно устанавливают DEV только внутри тестового процесса. CI использует отдельную PostgreSQL и случайный AUTH_SECRET. Production ENV, секреты и данные покупателей не включены в commit. Старые миграции не изменены.

Card.vue и Grid.vue исключены: их loading/decoding изменения сохранены в ветке audit/catalog-image-loading-20261013 для согласования с параллельной оптимизацией каталога. Ни URLs, ни файлы изображений, ни хранилище не меняются этим PR. Возможны пересечения параллельных задач в product/feed.ts, странице главной и admin research drafts; перед merge нужно сравнить их фактический diff.

## Проверки

- Повторный pnpm check после отделения изображений: typecheck, lint, API 1127 passed / 3 SQL skipped без отдельной БД, gateway 67, frontend 366, production build — успешно.
- Предыдущий полный прогон именно этих исправлений на отдельной локальной БД: API 1130/1130; API E2E 505/505 без пропусков. После него семантика API и миграции не менялась.
- Admin smoke, 18 browser catalog scenarios, SEO/SSR smoke, мобильное повторное взвешивание 1600 г / серверные 176 ₽ — успешно в предыдущем прогоне.
- Prisma validate повторно успешно. Полная цепочка миграций и Prisma schema diff на изолированной БД прошли; diff пустой.
- 34 подтверждённых SKU: подготовка локального плана и dry-run без изменения БД проверены. Автоматического исправления production-каталога нет.
- git diff --check — успешно. GitHub Actions будет отдельной проверкой после открытия PR; локальные результаты не заменяют её.

## Миграция и риски

20261013120000_normalized_product_price добавляет GENERATED ALWAYS STORED DECIMAL и индекс только к Product. Исходные price/priceQty/sale fields и Order/OrderItem snapshots не переписываются. Старый код может работать с расширенной схемой, но новый код требует применения миграции перед запуском. При копировании Product generated-поле надо исключать из записи.

Выражение повторяет integer half-up customerPrice при фиксированной наценке 10%; изменение SERVICE_MARKUP_PERCENT требует новой согласованной миграции. Перед rollout проверить некорректные priceQty <= 0, наличие backup и свободного места. На существующей большой таблице STORED-колонка и обычный CREATE INDEX требуют блокировок/перезаписи: нужно измерить время на staging и назначить окно обслуживания. Не запускать db push/reset.

Старые ценовые cursors отклоняются новым scope: клиент должен начать выдачу заново. Сравнение кг и единицы упаковки не сравнивает их массу. Для каталога >10 000 товаров сохраняется некэшированный путь, нагрузку нужно проверить отдельно; после bulk import важна статистика PostgreSQL.

Развёртывание и восстановление релиза рассматриваются отдельным PR. Откат приложения не откатывает миграции БД. DEMO-доступ по чужому номеру остаётся известным риском по решению владельца до выбора SMS-провайдера.

## Изменённые файлы

- `.github/workflows/checks.yml`
- `README.md`
- `apps/api/data/sale-audit/apply.ts`
- `apps/api/data/sale-audit/prepare.ts`
- `apps/api/data/sale-audit/run.ts`
- `apps/api/package.json`
- `apps/api/prisma/migrations/20261013120000_normalized_product_price/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/admin/research-drafts.ctrl.ts`
- `apps/api/src/admin/research-drafts.schema.ts`
- `apps/api/src/admin/research-drafts.service.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/cart/cart.service.ts`
- `apps/api/src/health/health.ctrl.ts`
- `apps/api/src/health/health.spec.ts`
- `apps/api/src/order/coordination.service.ts`
- `apps/api/src/order/order.service.ts`
- `apps/api/src/product/feed.spec.ts`
- `apps/api/src/product/feed.ts`
- `apps/api/src/product/product.service.spec.ts`
- `apps/api/src/product/product.service.ts`
- `apps/api/src/product/select.ts`
- `apps/api/src/telegram/staff-bot-flow.service.ts`
- `apps/api/src/telegram/staff-bot-view.spec.ts`
- `apps/api/src/telegram/staff-bot-view.ts`
- `apps/api/src/telegram/staff-bot.service.ts`
- `apps/api/test/admin.smoke.mjs`
- `apps/api/test/auth-method.e2e-spec.ts`
- `apps/api/test/cart-quote.e2e-spec.ts`
- `apps/api/test/customer-shopping.e2e-spec.ts`
- `apps/api/test/manual-badges.e2e-spec.ts`
- `apps/api/test/market-products.e2e-spec.ts`
- `apps/api/test/order-phones.e2e-spec.ts`
- `apps/api/test/phase1.e2e-spec.ts`
- `apps/api/test/product-feed.e2e-spec.ts`
- `apps/api/test/sale-models.e2e-spec.ts`
- `apps/web/app/components/home/HeroCarousel.vue`
- `apps/web/app/components/order/WholeWeight.vue`
- `apps/web/app/composables/useProductSort.ts`
- `apps/web/app/pages/admin/research-drafts.vue`
- `apps/web/app/pages/index.vue`
- `apps/web/test/cart-brand.test.mjs`
- `apps/web/test/cart-plugin.test.mjs`
- `apps/web/test/catalog-groups.test.mjs`
- `apps/web/test/catalog.smoke.mjs`
- `apps/web/test/home-content.test.mjs`
- `apps/web/test/seo.smoke.mjs`
- `apps/web/test/seo.test.mjs`
- `docs/catalog-sale-audit/README.md`
- `package.json`
- `docs/audit-2026-10-13-review.md`
