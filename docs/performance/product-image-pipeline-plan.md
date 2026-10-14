# KorzinaMarket: план адаптивных фотографий товаров

Дата: 14 октября 2026. Репозиторий: `MaxiViP/Shop`.
Исследован локальный commit `238710e4a04d05e7920f6e1fa596a3e992c0b19a` (main на момент проверки).

**Решение:** заранее создавать WebP 192/384/640 через существующий Sharp; сохранять текущие файлы и URL; отдавать необязательные metadata только готовых вариантов из приватных файловых manifests. Prisma и БД для первой версии не менять. Frontend использует обычный `<img>` с `srcset`, `sizes` и оригиналом как fallback. Backfill работает отдельным ограниченным процессом, никогда не удаляет оригиналы.

Это проект архитектуры, а не реализация. Все новые функции, поля, пути, команды и настройки ниже явно являются предложением. Текущая задача изменяет только этот документ, независимо от Draft PR #5 и #6. Она не разрешает production backfill, deploy, миграции, подключение к VPS или изменение БД.

## 1. Основания и ограничения исследования

- Использован доступный checkout; зависимости не устанавливались. `git fetch`, Lighthouse, `pnpm check`, E2E и production build не запускались. К БД и VPS не подключались; изображения не изменялись.
- Прочитан корневой `AGENTS.md`. Nuxt/Vue изменения в будущем должны сохранять порядок template → script → style; backend — ESM импорты `.js`, строгие типы, без `any`.
- Проверены исходники API, frontend, Prisma, импорта, тестов и deployment-шаблонов. Номера строк в таблицах относятся к исследованному commit и могут измениться.
- Нет `node_modules`: фактические defaults/max-width компонента Nuxt UI `UContainer` не проверены. Настройки padding в приложении доступны. Поэтому desktop `sizes` нельзя считать окончательно проверенными по браузерной геометрии.
- Реальные production файлы, размеры/распределение оригиналов, доступная RAM/CPU, свободный диск, mount/FS и HTTP cache на сервере недоступны. Репозиторный deploy описывает ожидаемую конфигурацию, не доказывает состояние VPS.
- Локально отсутствуют ветки/refs и файлы PR #5/#6. Штатный GitHub-коннектор доступен: через него прочитаны PR #5 и два документа на фиксированном commit `ba935d9eaec1ed930c8c2d0955e486e7a247378e`; CLI-сеть и ограничения окружения не менялись. Код PR #5 не применялся. Содержимое PR #6 не требуется для этого решения и не исследовалось.

### Что учитывается из PR #5

Источники: [Draft PR #5](https://github.com/MaxiViP/Shop/pull/5), [повторное исследование](https://github.com/MaxiViP/Shop/blob/ba935d9eaec1ed930c8c2d0955e486e7a247378e/docs/catalog-image-review.md), [первоначальный аудит](https://github.com/MaxiViP/Shop/blob/ba935d9eaec1ed930c8c2d0955e486e7a247378e/docs/catalog-image-performance.md).

PR оставлен Draft. Исследование не нашло устойчивого выигрыша от единственного `high` или адаптивного preload. При одинаковом моменте начала скролла сокращение preload ухудшило худшее ожидание на 320/390 px: 1999 → 2647 мс и 2243 → 2559 мс. После просмотра одинаковых 24 фото все политики передали одинаковые 7,79 МБ. Следовательно, lazy loading меняет очередь/момент загрузки, но не уменьшает размер самих файлов и может замедлять появление фото при быстрых переходах.

В виртуальном списке observer не видит отсутствующие DOM-элементы: overscan около 900 px ограничивает эффект preload 3000 px. CLS первого экрана был 0; основные сдвиги длинного сценария связаны с `.product-more` при pagination. Уменьшение фото не считается исправлением этого отдельного риска.

Ограничения прежних измерений: Chromium, localhost fixture, синтетические фото, DPR 1; реальные устройства/Safari/DPR 2–3 и production originals не проверены. Значения не являются production CWV. Новые варианты надо измерять отдельно, сохраняя одинаковый набор фото и момент старта прокрутки. Четыре eager/high из PR #5 не являются поведением исследованного main.

## 2. Текущая архитектура: подтверждённые пути

### 2.1. Загрузка, нормализация, импорт

| Файл / функция | Фактическое поведение |
| --- | --- |
| `apps/api/src/admin/products.ctrl.ts:32,67` — `AdminProductsCtrl.upload()` | `POST /api/admin/products/:id/images`, существующий `AdminGuard`; `FileInterceptor('file')`: 5 MiB, 1 файл, 0 полей, 2 multipart parts. Вызывает `ImagesService.upload()`. |
| `apps/api/src/admin/images.service.ts:25` — `ImagesService.upload()` | Нормализует фото, создаёт UUID `.webp`, пишет `wx`, затем транзакция и lock Product, максимум 8 фото, создание `ProductImage`. При ошибке удаляет созданный файл. Atomic temp → final сейчас нет. |
| `apps/api/src/common/image.ts:5,15` — `productUploadRoot`, `normalizeImage()` | `resolve(UPLOAD_DIR || 'uploads/products')`; Sharp `^0.35.4` уже в `apps/api/package.json`. JPEG/PNG/WebP, ≤5 MiB по size и buffer.length, ≤25 MP, `failOn: 'warning'`, реальный format должен совпасть с MIME, pages >1 отклоняются. |
| `common/image.ts:40,44` | `preserveWebp=true` делает полный raw decode и возвращает исходные WebP байты. Обычная загрузка: `rotate()` → resize без увеличения (maxWidth для товаров не передаётся) → WebP quality 85. Вариантов товара нет. |
| `apps/api/src/product/photo-pack.ts:21` — `readPhotoPack()` | Строгий manifest AI_PLACEHOLDER batch 2026-10-07, до 146 фото; точный путь `<marketPointSlug>/<productSlug>.webp`, SHA-256, аудит структуры, неподдерживаемые entries/symlinks отклоняются; проверка через `normalizeImage(..., true)`. Накапливает buffers фотопака в памяти. |
| `photo-pack.ts:81` — `placeholderUrl()` | Детерминированный UUID из batch, slug, hash; URL `/uploads/products/<uuid>.webp`. |
| `apps/api/src/product/photo-import.ts:10` — `importProductPhotos()` | Только clean pack; dry-run — READ ONLY transaction; apply блокирует товары. CREATE/UNCHANGED/SKIP_EXISTING, проверка назначения и checksum, `wx`, защита совпавшего URL другого товара. Не заменяет существующие фото. |
| `photo-import.ts:81` — `validateProductPhotos()` | Проверяет связь Product/MarketPoint/photo и побайтовый hash файла назначения. |
| `apps/api/data/product-photos/run.ts:8` | Существующие режимы `--audit`, `--dry-run`, `--apply`, `--validate`, `--allow-remote`; по умолчанию dry-run, remote DB требует отдельного флага. `--limit`, `--concurrency`, `--resume` здесь отсутствуют. |
| `apps/api/data/product-photos/README.md`, `2026-10-07/README.md` | Versioned pack из 146 WebP в 17 папках; import сохраняет точные байты, staging `product-photo-source/` не используется importer/Nuxt. |
| `apps/api/data/catalog-import/import.ts:224,256`, `run.ts:94` | Общий catalog import подготавливает photo map/имя, но исключает images из product patch; это не дополнительный загрузчик фотографий. |

**Различие оригиналов:** отдельного архива необработанных product originals в доступном коде нет. Для legacy оригинал — уже сохранённый файл по `ProductImage.url`; его байты нельзя менять. Исходные JPEG/PNG обычных загрузок и EXIF из них восстановить нельзя. Для импорта сохранённый WebP совпадает с WebP фотопака.

### 2.2. Storage, static и существующий lifecycle

| Файл / функция | Фактическое поведение |
| --- | --- |
| `apps/api/src/main.ts:13` — `bootstrap()` | `useStaticAssets(uploadRoot)` с prefix `/uploads/products/`, `dotfiles: 'deny'`, `index: false`, `nosniff`. GET не запускает Sharp. Явного image `maxAge/immutable` нет. |
| `deploy/nginx.conf:54` | `/uploads/` проксируется на Nest `127.0.0.1:4001`; отдельный cache для изображений не настроен. API locations используют no-store. |
| `deploy/deploy.sh:73,100`, `deploy/shop-api.service:8` | Шаблон: `/var/lib/korzinamarket/uploads/products`, shop:shop, directory 0750, UMask 0027, разрешённая запись systemd под `/var/lib/korzinamarket/uploads`. |
| `deploy/README.md:348,370` | Uploads постоянные, вне checkout; пример backup архивирует `products`. Новые приватные originals/state потребуют дополнения backup. |
| `images.service.ts:16` — `managedPath()` | Только exact `/uploads/products/([a-f0-9-]{36}\.webp)`. Запрещает slash, `%`, backslash/query/external пути, но это не строгая проверка UUID. Вложенные variants не принимает. |
| `images.service.ts:109,123` — `remove()`, `cleanup()`; `admin/products.service.ts:143` | Существующее удаление админкой защищает ссылки `OrderItem.image`, `OrderIssue.proposedImageUrl`, другие `ProductImage.url`. Это не инструмент backfill. |
| `apps/api/src/market-map/market-map.service.ts:107` | Фото MarketPoint используют тот же плоский UUID namespace и storage root. |
| `apps/api/src/admin/slides.service.ts:125` | Hero uploads находятся в `uploadRoot/hero`, нормализуются с maxWidth 1920. |

Поэтому обход всего `UPLOAD_DIR` не равен списку product photos. Chat, hero, MarketPoint и изображения только из исторических заказов в область этого backfill не входят. Не менять общий `normalizeImage()` так, чтобы одновременно изменились чужие upload flows.

### 2.3. Prisma и API

- `apps/api/prisma/schema.prisma:214`: `ProductImage { id, url, alt?, sort, visible, productId }`, индекс productId; `url` не unique. Нет width/height/hash/variants.
- `apps/api/src/product/select.ts:48`: `productListSelect.images` — только visible, `{ url, alt }`, порядок sort/id. `customerProduct()` на строке 7 синхронный, общий с другими потребителями.
- `apps/api/src/product/product.ctrl.ts`: существующие `GET /api/products` и `GET /api/products/:slug`.
- `apps/api/src/product/product.service.ts`: `list()`, `get()`, `prioritySearch()`; feed-вызов `productFeed()` из `apps/api/src/product/feed.ts` возвращает товары через общую projection.
- `apps/api/src/favorite/favorite.service.ts:10`: `list()` использует те же select/projection, endpoint в `favorite.ctrl.ts` — `GET /api/favorites`.
- `apps/api/src/order/cart-quote.ts:32` и `telegram/customer-shop.service.ts:94,148` также используют общую projection. Не добавлять туда filesystem I/O или новую ценовую логику ради image metadata.
- `apps/web/app/types/product.ts:37`: `images` содержит только url/alt. Admin schema `apps/api/src/admin/schema.ts:66` принимает alt/sort/visible, а не файловые пути от клиента.

### 2.4. Frontend

| Файл / компонент | Фактическое поведение |
| --- | --- |
| `apps/web/app/components/product/Card.vue:5` — `ProductCard` | Обычный `<img>` только src/alt через `useAsset()`. Нет srcset/sizes/loading/decoding/fetchpriority. На строках 213–238 квадратный box, contain, рамка карточки 1 px. |
| `Card.vue:616` | Compact избранного до 640 px: aspect-ratio 4:3; обычная карточка 1:1. |
| `apps/web/app/components/product/Grid.vue:5,31` — `ProductGrid` | 2/3/4/5/6/7 колонок на 0/640/768/1024/1280/1536 px (rem=16); gap 6/8/8/12/12/12 px. Ключ product.id, абсолютный `data-product-index=start+index`. |
| `apps/web/app/composables/useGridWindow.ts:5` | SSR start=0/end=count; после mount измерение, overscan 900 px, сохранение scroll anchor, обновления ResizeObserver. |
| `apps/web/app/pages/index.vue:3,28,53` | Hero, категории, затем ProductGrid; первая страница 24, windowing после >120 товаров. |
| `apps/web/app/components/catalog/View.vue:29`, `pages/catalog/index.vue`, `pages/catalog/[slug].vue` | Общая/сгруппированные сетки каталога; windowing после общего количества >120. `useCatalog()` использует feed, первая порция 24. |
| `apps/web/app/composables/useProductFeed.ts:20`, `useApi.ts` | Первый feed через SSR useFetch и Nuxt payload; append дедуплицирует продукты. |
| `apps/web/app/pages/favorites.vue:20,60,98`, `stores/favorites.ts` | Compact grids по группам, без windowing; refresh после mount. Гостевые товары через `/products?ids=...` порциями до 60, серверные через `/favorites`. |
| `apps/web/app/pages/product/[slug].vue:7,81` | ProductGallery, SSR `/products/:slug`; mobile 1 колонка, ≥768 две; ≥1280 при description три. |
| `apps/web/app/components/product/Gallery.vue:4,28` | Основное фото: original, async decode; previews: original, lazy/async. Main square contain; thumbs 64 px внешний box, около 53,6 px содержимое, **cover**. При нескольких фото ≥768 резервирует 84 px справа. |
| `apps/web/app/composables/useProductGallery.ts:8` | selected=0, current, select(index); собственный url/alt тип дублирует общий. |
| `apps/web/app/composables/useAsset.ts` | Абсолютные http(s) URL сохраняет, `/uploads/products/` разрешает относительно origin `public.apiBase`; новый вложенный variants namespace совместим. |
| `apps/web/app/app.config.ts:8`, `assets/css/main.css:5` | Container padding `--page-x=max(clamp(12px,6.4px+1.5vw,32px),safe-left,safe-right)`. |

`nuxt.config.ts` не подключает `@nuxt/image`. Новая библиотека или on-demand image server не нужны.

## 3. Предлагаемая архитектура

### 3.1. Варианты A и B

| Критерий | A: frontend вычисляет deterministic URLs, Prisma прежняя | B: optional metadata готовых файлов в API |
| --- | --- | --- |
| Сложность | Меньше типов, но нужен отдельный способ узнать готовность | Небольшой sidecar reader + DTO/front types |
| Legacy / partial failure | Нельзя предполагать наличие 192/384/640; blind srcset приводит к 404 | Отсутствие metadata означает прежний original; допускается проверенный partial набор |
| Безопасные width descriptors | Номинальные размеры неверны для маленьких/портретных фото | API отдаёт реальные width/height |
| Версия / stale cache | Одна схема имён недостаточна при изменении source/settings | version + hash, immutable variants |
| Prisma / миграция | Не обязательны | Тоже не обязательны: metadata выводится из FS manifest |
| Если дополнить A readiness endpoint | Потребуется дополнительный fetch/SSR lookup, практически получится B | Готовность приходит с товаром |

**Выбрать B без изменения Prisma**: детерминированные пути сохраняются как внутреннее правило storage, но клиент не угадывает готовность. Sidecar manifest — факт публикации, не самостоятельная таблица товаров. Это удовлетворяет безопасности legacy/partial sets с минимальным вмешательством в текущую модель.

Вариант B с nullable JSON/новой таблицей Prisma сейчас не нужен. Он имеет смысл позже при object storage, нескольких несвязанных томах, query по состоянию обработки, большом каталоге или управлении версиями из админки. Тогда отдельно согласовать schema, источник истины, FS↔DB reconciliation, миграцию и rollout; не записывать весь manifest в ProductImage без решения этих вопросов.

### 3.2. Структура файлов — новое решение хранения

Для предлагаемого production layout на основе deploy-шаблона:

```text
/var/lib/korzinamarket/uploads/
  products/                         # существующий UPLOAD_DIR, публичная static root
    <uuid>.webp                     # текущие original URL/байты не меняются
    hero/                           # существующий, не входит в pipeline
    variants/v1/<uuid>/<sourceSha256>/
      192.webp                      # имя — bounding size, НЕ обещанная actual width
      384.webp
      640.webp
  product-originals/                # НОВЫЙ приватный архив входных байтов
    <uuid>/<inputSha256>.<verified-ext>
  product-image-state/              # НОВЫЙ приватный, вне static root
    ready/<uuid>.json               # последний подтверждённый manifest
    pending/<uuid>.json             # recoverable job после product commit
    outcomes/<uuid>.json            # terminal failure/defer, source fingerprint + profile
    locks/<uuid>.lock               # exclusive writer, owner/run identity
    runs/<runId>.jsonl              # журнал backfill/worker
    checkpoints/<runId>.json
    work/<runId>/<uuid>/<attempt>/  # staging, тот же filesystem, закрытые права
```

Новые конфиги (предлагаются): `PRODUCT_IMAGE_ORIGINAL_DIR`, `PRODUCT_IMAGE_STATE_DIR`, `PRODUCT_IMAGE_VARIANTS_ENABLED` для API и `public.productImageVariantsEnabled` для frontend. Defaults вычислять от dirname(productUploadRoot), не от случайного cwd. При старте проверить, что приватные roots не вложены в public root, не совпадают с chat root, не являются symlink; не разрешать пересечение roots и неожиданный device для staging.

Состояние и raw originals не размещать в `products/originals`: текущая static root сделает их публичными, включая GPS/EXIF. Пути sibling вписываются в текущий systemd ReadWritePaths, но создание dirs, worker unit, права и backup — будущие изменения, не действия этого сеанса. Persistent dirs не должны находиться внутри checkout/dist. Для non-production использовать отдельный temp/staging root, никогда production path по умолчанию.

### 3.3. Два значения слова «оригинал»

1. **Legacy/public base**: существующий `/uploads/products/<uuid>.webp`. Backfill читает его, не меняет байты, имя, дату модификации или ссылки в БД. Это остаётся src, SEO image, gallery fallback и ссылкой snapshots.
2. **Raw input новых загрузок**: после проверки принимать и сохранять файл побайтно в приватном архиве с verified extension/hash. Для обычного upload это JPEG/PNG/WebP до существующей нормализации. Не переносить старые public files и не обещать восстановление утраченного raw input. Для нового импорта архивировать точные source WebP либо сохранять immutable deployed pack с проверяемой связью manifest; выбрать отдельный архив для одинакового lifecycle и backup.

Публичная base-фотография будущей загрузки остаётся результатом текущего normalizeImage, чтобы сохранить контракт и визуальное поведение. Варианты v1 генерируются из **публичной base-фотографии**, а не повторно из raw JPEG: это сохраняет единый внешний вид и понятный source hash. Архив raw нужен для сохранности; использование его для нового профиля качества — отдельная версия, после сравнения. Повторное WebP кодирование снижает качество: initial quality выбирается на реальных samples, а не считается автоматически оптимальным.

Generator/backfill/worker не вызывают `ImagesService.cleanup()` и не удаляют ни один raw/public original. Существующее явное удаление фото админкой находится вне этой задачи; его прежние guards сохраняются. Не добавлять variant GC в первый релиз. Raw архив не удалять даже после failed upload/DB rollback: оставить recoverable orphan, журнал без публикации. Политика его retention/удаления требует отдельного решения.

### 3.4. Генерация и ресурсы

Предлагаемый профиль `v1`: bounding sizes 192/384/640, WebP quality **82 как старт для визуальной проверки**, alphaQuality 100, effort 4; точные параметры фиксировать в manifest/profile. Изменение параметров после публикации создаёт `v2`, не переписывает immutable v1.

```text
validated public base → Sharp(limitInputPixels=25_000_000, failOn=warning)
  → validate format/pages/dimensions → rotate() → toColourspace('srgb')
  → resize({ width: W, height: W, fit: 'inside', withoutEnlargement: true })
  → webp(profile) → private temporary file → full output validation
```

- No crop/padding/flatten: сохранять пропорции, alpha и прозрачность. Фон задаётся существующим CSS. Ориентация применяется до вычисления output dimensions; EXIF/ICC/GPS не копируются в производные. При этом raw originals остаются побайтно неизменными.
- Отдавать реальные width/height, не `192w`, если файл на выходе 144×192. При маленьком исходнике не увеличивать; одинаковые actual widths дедуплицировать, генерировать одинаковый output только один раз и хранить ссылку профиля в manifest. При равной width выбрать один подтверждённый candidate.
- Для backfill ≤5 MiB проверять **stat до readFile**, затем реальный buffer length/формат. Public base после нормализации теоретически может превысить 5 MiB; такой legacy файл журналировать как oversized и оставить original, не поднимать лимит незаметно. Новый upload контролирует размер input и отдельно нормализованного source до постановки job.
- Input: JPEG/PNG/WebP, pages=1, ненулевые dimensions, ≤25 MP; дополнительный proposed max edge 16384 px защищает от экстремального aspect ratio. Источник с большим edge/анимацией/ложным MIME/повреждением отклоняется, не преобразуется молча. Для файла из FS MIME определяется по декодированному format, не расширению.
- Один worker-процесс, concurrency default 1, разрешённый диапазон первой версии 1–2. Внутри job варианты последовательно, никаких Promise.all на все widths или buffers каталога. Bounded очередь ссылок на файлы, не buffers; каждый файл освобождается до следующего.
- В отдельном worker один раз `sharp.concurrency(1)` и ограниченный cache (стартовый budget 32 MiB); эти настройки глобальны для процесса, не менять их на каждом запросе API. Они не ограничивают всю RSS. Измерить peak RSS; стартовый worker MemoryMax 512 MiB / CPUQuota 100% — staging hypothesis, не гарантия для 25 MP. OOM требует уменьшить input/concurrency или увеличить согласованный budget.
- Per-job deadline 30 с как начальный budget. Promise.race не останавливает libvips: hard timeout/изоляция требует завершения worker/дочернего процесса supervisor. После deadline не запускать одновременно второй decoder, пока первый не остановлен. Автоматические повторы permanent input errors запрещены.
- Ресурсные правила относятся также к backfill, а не только daemon: CLI и spool worker запускают один и тот же supervised child-generator с hard deadline. Sharp threads/cache настраиваются в child; CLI concurrency ограничивает их число. На Linux весь supervisor с descendants должен иметь согласованный суммарный RSS/CPU budget через cgroup/systemd, а не только Node heap limit. При запуске в VS Code без такого supervisor явно описать доступный механизм остановки/контроля RSS; unrestricted большой batch не разрешать. Примеры CLI ниже демонстрируют аргументы, не заменяют этот admission.
- API продолжает существующую обязательную нормализацию base. Тяжёлые дополнительные варианты выполняет отдельный worker/CLI, не HTTP GET и не DB transaction. Не добавлять общий Redis/новую библиотеку очередей ради первой версии.

### 3.5. Atomic publication и автоматическая обработка новых фото

```mermaid
flowchart LR
  U[Upload или photo import] --> O[Неизменённый raw архив и текущий public base]
  O --> D[Существующий ProductImage commit]
  D --> Q[Приватный pending descriptor]
  Q --> W[Один ограниченный worker]
  W --> T[Private temp: encode и full verify]
  T --> V[Immutable variants]
  V --> M[Ready manifest публикуется последним]
  M --> A[API: optional metadata]
  A --> F[SSR img: srcset и original fallback]
```

Последовательность upload/import:

1. Проверка входа/допуска job. До raw/base/pending writes сделать read-only preflight существования товара/лимита8 и disk admission с запасом на raw orphan, base и активные jobs; окончательные business checks остаются под transaction lock. При отказе бюджета не начинать запись архива. Сохранить raw через private temp → no-clobber final. Base писать атомарно вне DB transaction; не расширять общий `normalizeImage()` для hero/chat/MarketPoint.
2. Существующие business checks/locks/лимит 8 и создание ProductImage сохраняются. Для импорта сохранить SHA, CREATE/UNCHANGED/SKIP_EXISTING и не удерживать 60-секундную transaction во время generation.
3. После успешного commit атомарно записать bounded pending descriptor `{sourceUrl, sourceFingerprint, profile}`. Upload может успешно вернуть original без variants; ошибка Sharp не делает корректный original недоступным.
4. Worker использует тот же generator, что backfill. Pending spool не загружает данные в RAM; job identity детерминированна. Если spool full/disk error — логировать generation deferred, не выдумывать metadata.
5. FS и DB не имеют общей transaction: падение между commit и pending возможно. Reconciliation того же read-only ProductImage inventory восстанавливает jobs без ready manifest. Это обязательная часть запуска worker/планового bounded sweep; она не пишет в БД.
   Чтобы sweep не повторял permanent failures бесконечно, сохранять private terminal outcome по source URL + hash/fingerprint + profile. Corrupt/oversized/unsupported source не enqueue повторно до изменения source/profile или явного targeted retry; при transient errors — bounded попытки с backoff и DEFERRED после budget. Одного отсутствия ready недостаточно для новой job. Missing source тоже требует negative outcome с повторной проверкой existence, без encode loop.
6. Worker публикует только проверенные файлы, затем готовность; завершённый pending descriptor можно удалять как служебный job своего scope. Не удалять originals/variants. Никаких sidecar job refs в Prisma.

Atomic правила:

- Temp открывать `wx`, права 0600; закрывать handle, fsync файла перед публикацией. Для crash durability после публикации sync соответствующего directory на поддерживаемой FS; атомарность rename не равна durability при потере питания.
- Per-source exclusive lock с owner/runId; generation выполняется только под lock. Не использовать простой timeout/возраст lock как доказательство отсутствия владельца; recovery проверяет host/process identity и PID start time, а при неизвестном владельце останавливает job.
- Final variant публиковать **без перезаписи**: на согласованной Linux FS `link(temp, final)` создаёт final атомарно, EEXIST → проверить уже существующий файл; только затем unlink собственного temp. Не применять обычный rename для no-clobber: POSIX rename может заменить destination. Поддержку hardlink проверить на staging; другой FS требует отдельно проверенного эквивалента, без copy-to-public.
- Новую destination directory создавать под lock; публикация отдельных файлов допустима: metadata появляется только после проверки всего перечисленного ready-набора. При repair можно публиковать проверенный subset и потом расширять manifest; непроверенные slots не анонсировать.
- Ready JSON: strict schema, bounded size ≤16 KiB, source URL/hash/fingerprint, profileVersion, oriented original dimensions, candidates `{url,width,height,bytes,sha256}`. Никаких пользовательских абсолютных путей. Private temp + fsync + atomic replace ready JSON под lock. Для metadata replace допустим, файлы изображений остаются immutable.
- Если существующий final корректен — сохранить байты/mtime, не encode и не overwrite. Если существующий final повреждён — убрать его из готовности, записать conflict; не заменять содержимое immutable URL. Для полностью автоматического repair можно опубликовать только повреждённый slot под новым детерминированным именем `640-<outputSha256>.webp` (остальные остаются прежними), strict parser должен поддерживать эту форму. Правило repair/отчёт проверить в тестах.
- SourceHash перед final publication сверить со снимком; если original заменён/удалён конкурентно — прекратить job, оставить recoverable temp, не публиковать stale readiness. Публичные originals в нормальном lifecycle считаются immutable.

## 4. Предлагаемый API-контракт и выдача

Существующие endpoints сохраняются. На стороне product/detail/feed/favorite **после** текущей бизнес-projection добавляется только image metadata. `customerProduct()` и `productListSelect` не превращать в filesystem loader; carts, цены и Telegram consumers не менять. В feed enrichment делать после завершения транзакции, сохраняя порядок/cursor/total.

Предлагаемые новые DTO (пример, сейчас такого API нет):

```ts
interface ProductImageVariant {
  url: string;
  width: number;       // реальные encoded dimensions после rotate/resize
  height: number;
}

interface ProductImage {
  url: string;         // прежний original URL
  alt: string | null;
  width?: number;     // oriented dimensions original, только если проверены
  height?: number;
  variants?: {
    version: 'v1';
    webp: ProductImageVariant[]; // только подтверждённые существующие файлы
  };
}
```

Для legacy/external/missing/unverified файла variants и dimensions не добавлять. Пустой набор не нужен. Hash, filesystem path, raw URL, worker errors и journal не отдавать покупателю. Manifest может содержать больше внутренних данных, чем API. URL original/alt/visible/sort semantics прежние.

Registry reader: batch по уникальным source URLs, strict parser, async bounded FS reads и cached entries; никаких Sharp/decode/полного recursive scan на GET. Начальный bounded LRU: максимум 10 000 entries и 16 MiB metadata; positive TTL 30 с, negative 5 с, file I/O concurrency ≤4. На cache refresh проверить manifest и `stat` файлов/источника: regular file, bytes/fingerprint, bounds. Writer проверяет полный decode/checksum; registry не повторяет его в каждом HTTP запросе. Cold/error lookup возвращает original. Несколько API процессов обновляются независимо через TTL; локальная invalidation после upload ускоряет, но не заменяет cross-process refresh. Не менять SSR payload metadata между SSR и hydration.

**404 и аварийный fallback:** primary правило — API не объявляет непубликованные/непроверенные variants. Между response и GET файл всё же может исчезнуть; cache и SSR нельзя сделать абсолютно атомарными с FS. Предусмотреть отдельный read-only обработчик только строгого `/uploads/products/variants/v1/...` namespace: обычная static выдача существующего файла, при ENOENT — исходный `/uploads/products/<uuid>.webp` (serve или redirect), `Cache-Control: no-store`, без Sharp. Unknown/invalid path отклонить, source не найден — 404. Битый original нельзя исправить отсутствующим variant.

Обработчик должен быть зарегистрирован до общей static root либо как fallthrough после её miss, **вне `/api` global prefix**, с тестом route ordering. Никогда не выдавать original body с immutable cache заголовками missing variant. Это новый механизм, в main его сейчас нет. Он не является dynamic optimizer.

У корректных hash-versioned variants: `Content-Type: image/webp`, `nosniff`, `Cache-Control: public, max-age=31536000, immutable` и корректная conditional/HEAD выдача. Long cache применяется только к variants, не ко всей `/uploads/` и не к private files/API. Original cache policy первой версии оставить прежней; не менять существующие URL или приклеивать query cache busters. Проверить headers через используемый nginx, поскольку `/api` и `/uploads` имеют разные правила.

## 5. Frontend: размеры, атрибуты, SSR

### 5.1. Реальная геометрия и размеры вариантов

При rem=16 px, внешней ширине UContainer `C`, padding `P`, колонках `n` и gap `g`:

```text
imageBoxWidth = (C - 2P - (n - 1)g) / n - 2px
P = max(clamp(12px, 6.4px + 0.015 * viewportWidth, 32px), safe-left, safe-right)
```

Пример при C=viewport, без scrollbar/safe-area (расчёт по CSS, **не браузерный замер**):

| Viewport | Колонки | Box, px | Нужная ширина DPR 1 / 2 / 3 | Вывод |
| --- | ---: | ---: | --- | --- |
| 320 | 2 | 143 | 143 / 286 / 429 | 192 / 384 / 640 достаточно для квадратного source |
| 390 | 2 | 177,75 | 178 / 356 / 533 | 192 / 384 / 640 |
| 430 | 2 | 197,15 | 197 / 394 / 591 | 384 / 640 / 640; 192 уже ниже DPR1 |
| 639 | 2 | ≈298,5 | 299 / 597 / 896 | Для DPR3 нужен original >640 или будущий 960 |
| 767 | 3 | ≈236,4 | 236 / 473 / 709 | DPR3 может выбрать original |
| 768 | 4 | ≈175,0 | 175 / 350 / 525 | 192/384/640 |
| 1024 | 5 | ≈184,5 | 185 / 369 / 554 | 192/384/640 |
| 1280 | 6 | ≈192,8 | 193 / 386 / 578 | 384/640/640 |
| 1536 | 7 | ≈198,7 | 199 / 397 / 596 | 384/640/640; реальная cap может уменьшить box |

Первый профиль сохранить 192/384/640: он покрывает основные 320–430 px карточки и не умножает стоимость backfill без данных. Для больших slot/DPR3 включать проверенный original с его **actual width** в srcset. Если original невелик — не обещать недостижимую чёткость. Набор 960 для промежутка 431–767 и 1280 для gallery рассмотреть после inventory/визуального сравнения/byte budget; не добавлять автоматически в текущий план.

У resize fit-inside портретного source ширина меньше bounding size. `w` всегда actual encoded width. Для contain эффективная ширина содержимого square box = `boxWidth * min(1, originalWidth/originalHeight)`; compact 4:3 до 640 = `boxWidth * min(1, 0.75 * ratio)`. Начать с conservative sizes полной ширины box допустимо: портреты могут получить лишние байты, но не потеряют качество. Ratio-aware sizes — отдельная проверенная точность helper, только из SSR metadata. Для thumbs cover эту поправку не применять.

### 5.2. `src`, `srcset`, `sizes`

Новый общий `useProductImage()` и чистый `utils/product-image.ts` строят props для Card/Gallery из единого ProductImage type. Все candidate URL проходят `useAsset()`; original остаётся `src`. В srcset сортировать actual widths, убрать дубли, включить original только при подтверждённых dimensions. Не смешивать `w` и `x` descriptors. Если metadata нет/флаг выключен — только прежний src/alt, без выдуманного srcset. `src` сам по себе не гарантирует original fallback при наличии srcset, поэтому original должен быть явным larger candidate либо использоваться при error.

`sizes` должен соответствовать grid/container, а не постоянному `100vw`. Предлагаемый SSR helper генерирует media clauses от самых широких к узким:

```text
(min-width:96rem) S(7,12px), (min-width:80rem) S(6,12px),
(min-width:64rem) S(5,12px), (min-width:48rem) S(4,8px),
(min-width:40rem) S(3,8px), S(2,6px)

S(n,g) = calc((min(100vw, VERIFIED_CONTAINER_CAP) - 2P - (n-1)g) / n - 2px)
```

Это формула helper, **не готовый HTML**. Перед кодированием выяснить cap UContainer из реально установленной Nuxt UI и снять geometry; если cap зависит от breakpoint, отразить в clauses. В HTML не использовать CSS custom properties `var(--page-x)`: attribute sizes не получает их как stylesheet. Helper должен развернуть clamp/max/env в допустимые CSS lengths (с консервативным zero-safe fallback для неподдерживаемого синтаксиса) и иметь реальные browser currentSrc проверки. Scrollbar gutter может создавать небольшое безопасное завышение. Container-aware точность не должна требовать измерения window до hydration.

Для gallery mobile sizes около `C-2P`; ≥768 реальный gallery column минус 84 px при нескольких фото; ≥1280 отдельная формула при description. Из-за minmax и недоступной cap первая версия может использовать **консервативный upper bound ширины container** для gallery. Original остаётся larger candidate; не переносить grid sizes в gallery. На mobile 430 box≈404 px требует≈1213 physical px при DPR3; 640 недостаточно.

Thumbs: `sizes="54px"` (по текущему CSS/rem16), candidates из того же набора; actual width 192 достаточно DPR3. У portrait bounding-size192 actual width меньше, поэтому браузер может выбрать слот384/640/original; ориентироваться на metadata, не имя файла. Не загружать все большие originals для preview при наличии variants. На первом frontend шаге можно оставить main gallery original и включить srcset только для cards/thumbs; main gallery responsive включать после проверки её sizes/качества. Архитектура DTO поддерживает оба шага.

### 5.3. Loading/decoding/fetchpriority по контексту

Размеры файлов и политика начала загрузки внедряются и измеряются отдельно. Для первой srcset-проверки допустимо сохранить существующие loading attributes, чтобы сравнение измеряло сами variants. Затем включать ограниченную contextual policy:

| Контекст | Предлагаемая политика | Обоснование / проверка |
| --- | --- | --- |
| Главная | Первый небольшой глобальный budget карточек eager, остальные lazy; decoding async. Product fetchpriority auto | Над grid есть hero/categories. Не считать product LCP; не давать high всем карточкам. Проверить реальные initial viewport/hero LCP. Hero вне pipeline. |
| Каталог, первый экран | Стартовый conservative budget 4 eager, остальные lazy/async; high только доказанному LCP candidate, иначе auto | SSR не знает viewport; budget не гарантирует все видимые карточки desktop. Утвердить по staging paints/очереди, не копировать PR #5 автоматически. |
| Новые/возвращённые virtual rows | Native lazy/async как старт; fetchpriority auto | Проверить fast scroll; при задержках можно ограниченно повысить eager у реально видимых после mount, не менять первоначальный SSR. Не создавать preload всех feed items. |
| Избранное | Первые 4 **общего списка**, не каждой группы, eager/async; остальные lazy, auto priority | Данные в основном появляются после mount; измерить первый paint. Compact geometry учитывается отдельно. |
| Основное фото gallery | Первое selected eager/async; high только если оно измеренный LCP; смена выбранного фото eager/auto | Не ленить интерактивный selected image. На первом шаге src=original; позже srcset с larger original. |
| Gallery thumbnails | Lazy/async, fetchpriority auto, sizes≈54px | Не предзагружать 8 полноразмерных фото; переключение selected использует main pipeline. |

В группах Grid index локальный. Ввести явные props глобального offset/image context/budget из page/View, чтобы первые N каждой группы не становились eager/high. Не использовать текущий `visible index` как global index: в windowed grid нужен start+index. Не увеличивать overscan/preload одновременно с srcset; текущие 900 px и scroll-anchor должны остаться понятным baseline.

### 5.4. Fallback и SSR/hydration

- Metadata и img attributes присутствуют в SSR HTML и Nuxt payload. Не определять width/DPR через `window`/`matchMedia` для первого render. CSS media sizes выбирает браузер.
- Сохранить media aspect-ratio, contain, placeholder, product.id keys и высоты grid rows; dimensions оригинала не должны изменить квадратный CSS box. Thumbs cover сохраняет текущий UX.
- При image error один раз убрать **srcset и sizes**, затем установить original src. Смена только src оставляет браузеру сломанный выбранный candidate. Reset error state при смене source URL; если original тоже failed — существующий/новый нейтральный placeholder, без retry loop. Ошибки registry не должны превращать товары в ошибку API.
- Не добавлять HTTP HEAD на каждый candidate и клиентский fetch readiness. Не использовать разные списки variants до/после hydration без осознанного subsequent fetch.
- SEO/JSON-LD в `pages/product/[slug].vue` и `utils/seo.ts` продолжает ссылаться на original; cart/order snapshot URLs не меняются.

## 6. Backfill: отдельный новый CLI

Не дорабатывать массовую обработку в existing photo import CLI: его scope — фиксированный pack и DB assignment. Предлагаемый новый файл `apps/api/data/product-image-variants/run.ts` переиспользует standalone generator; **таких команд и файлов сейчас нет**.

### 6.1. Контракт CLI

- `--dry-run`: все проверки source/готовности без encode, mkdir, locks, ready writes, checkpoint или файлового журнала. JSON summary в stdout; перенаправление вывода делает оператор. Default mode — dry-run.
- `--apply`: явная запись только производных и служебного состояния в выбранном тестовом storage. Не создаёт/меняет ProductImage.
- `--limit N`: число рассмотренных уникальных разрешённых source URLs за запуск, включая ready/failed; positive integer. Записать это определение в help, чтобы repeated ready rows не давали неожиданную обработку каталога целиком.
- `--concurrency N`: positive integer 1–2, default 1; ограничение действует на jobs, widths внутри job последовательны.
- `--resume <runId>`: читать checkpoint/журнал указанного запуска, проверять storage/source inventory hash/profile; не доверять одним success строкам. При создании apply run сохранять frozen selected source keys и effective limit. Resume обрабатывает только этот scope, наследует сохранённый limit и никогда его не расширяет; явно переданный несовпадающий limit отклонять. Увеличение scope — только новый run. После завершённого запуска — сверка готовых файлов в том же scope, без rewrite корректных. Конфликт профиля/root/inventory — остановиться, начать новый run осознанно.
- Предпочтительный input `--manifest <inventory.jsonl>` — заранее подготовленный read-only экспорт `{imageId,productId,url}`; позволяет offline FS обработку без DATABASE_URL. Manifest paths проходят те же checks, не являются разрешением на произвольные файлы.
- Альтернатива `--from-db` — отдельный read-only DSN/роль и keyset scan `ProductImage.id`; local DB по умолчанию, remote без отдельного согласования запрещён. Секретный DSN никогда не логировать. Production run требует отдельного разрешения даже если DB hostname local.
- Явные `--source-root`, `--state-root` для тестового набора. Предложить защиту от production default paths/`NODE_ENV=production`, отдельный future opt-in для разрешённого operational запуска; opt-in сам по себе не заменяет разрешение пользователя.
- Unknown flags/NaN/0/слишком большой concurrency отклонять. Journal runId создаётся сервером, resume/run input разрешён только безопасным basename, никакого произвольного path traversal.

Пример **будущих локальных команд**, не запускавшихся в этом сеансе:

```sh
pnpm --dir apps/api exec tsx data/product-image-variants/run.ts \
  --manifest /tmp/product-images-test/inventory.jsonl \
  --source-root /tmp/product-images-test/products \
  --state-root /tmp/product-images-test/state --dry-run --limit 20 --concurrency 1

# Только после реализации и проверки на копиях в /tmp:
pnpm --dir apps/api exec tsx data/product-image-variants/run.ts \
  --manifest /tmp/product-images-test/inventory.jsonl \
  --source-root /tmp/product-images-test/products \
  --state-root /tmp/product-images-test/state --apply --limit 20 --concurrency 1

# С тем же input/root/profile и сохранённым scope limit20; реальный runId:
pnpm --dir apps/api exec tsx data/product-image-variants/run.ts \
  --manifest /tmp/product-images-test/inventory.jsonl \
  --source-root /tmp/product-images-test/products \
  --state-root /tmp/product-images-test/state --apply --resume RUN_ID --limit 20 --concurrency 1
```

`tsx` уже devDependency API; не устанавливать зависимости ради этого документа. Для deployed worker предпочтительнее compiled src entry, поскольку data script не входит в обычный Nest build. Обновление API typecheck/lint scope для нового data CLI включить в implementation task.

### 6.2. Алгоритм по одному source

1. **Найти фото.** Read-only inventory ProductImage, включая visible=false, дедупликация по exact URL; URL не unique. Keyset id, фиксировать maxId snapshot. Для большого объёма сохранять bounded inventory на диск, не держать buffers всех фото. Зафиксировать исходный inventory для resume; новые записи выше maxId — следующий run. External URL, `/images/`, hero/MarketPoint вне ProductImage scope — SKIPPED, без network fetch.
2. **Проверить original.** Строгий существующий managed URL, root containment и no symlink; открыть no-follow, fstat size/regular file, bounded read/hash, actual format/pages/dimensions/full decode. Source snapshot `url,sha256,size,mtimeNs` (при необходимости inode/device) фиксируется. Missing/oversized/corrupt — журнал и original fallback, не создание из placeholder и не удаление source.
3. **Проверить варианты.** Strict ready manifest/profile/hash + каждый existing candidate: regular file, size/hash/full decode, actual dimensions и expected bounds. Не считать существование файла или success в журнале доказательством корректности. При hash/version mismatch не удалять старые файлы, создать новый namespace.
4. **Сгенерировать недостающие.** Acquire source lock, повторно проверить original/ready после lock, statfs budget; исправные slots оставить без записи. Encode только отсутствующие slots в private staging. Permanent Sharp/input error — один source FAILED; source не трогать.
5. **Проверить результаты.** Полный decode WebP, dimensions >0, bounding side ≤requested, без enlargement, alpha/ориентация на fixtures, bytes≤output budget, hash. Совпадающие actual widths дедуплицировать. Исходник повторно сверить перед публикацией.
6. **Атомарно опубликовать.** No-clobber финальные файлы; EEXIST verify; повреждённый существующий immutable URL не перезаписывать, использовать согласованный repair suffix. Все перечисленные entries проверены, ready manifest swap последний. Проверенный old ready subset сохраняется при failed extension.
7. **Записать результат.** JSONL `{runId,attempt,imageIds,url,sourceHash,profile,status,outputs,durationMs,errorCode}`; статусы READY/UNCHANGED/SKIPPED/FAILED/DEFERRED. Sanitized errors без DSN/секретов/raw EXIF; flush. Checkpoint атомарный, хранит завершённые keys/retry states и safe contiguous cursor, а не максимальный id завершившейся из параллельных jobs.

Идемпотентность: same source+profile+правильные файлы → UNCHANGED, ноль encode/rewrite, прежние bytes/mtime; missing slot → только missing; new source hash/profile → новый namespace; corrupt published slot → новая URL revision для этого slot. Оригиналы не удаляются ни при каком исходе, correct variants не переписываются.

### 6.3. Прерывание и resume

| Точка остановки | Состояние / восстановление |
| --- | --- |
| До записи temp | Original доступен, resume повторяет проверки |
| В середине encode | Только private partial temp; без ready entry. Resume проверяет ownership/stale lock, удаляет только доказанно свой temp и encode заново |
| Final variants готовы, ready отсутствует | Проверить существующие finals и source hash; построить ready без повторного encode |
| Ready опубликован, журнал не записан | Manifest + проверенные файлы — источник истины; resume журналирует UNCHANGED/RECOVERED |
| Некоторые jobs завершились раньше предыдущих | Checkpoint не пропускает незавершённые ids/keys; сверка inventory, terminal states и retry set |
| Последняя JSONL строка оборвана | Игнорировать только incomplete последнюю строку; повреждение в середине отчёта — ошибка, не молчаливый skip |
| SIGINT/SIGTERM | Прекратить scheduling, дать active job безопасно закончиться в deadline, flush журнал/checkpoint, снять только собственные locks |
| kill/OOM/reboot | Закрытые public originals/готовые variants не меняются; unpublished staging восстанавливается по предыдущим правилам, lock требует доказанной неактивности |

Журнал не заменяет проверку файлов. `--resume` не запускает небезопасную глобальную очистку. Корни нельзя рекурсивно удалять; housekeeping разрешён только для private work entries конкретного доказанно завершённого run. Не следовать symlinks при очистке, не принимать path из exception/journal как готовый путь для unlink.

## 7. Безопасность, диск и отказоустойчивость

### 7.1. Пути и недоверенный input

- Для source оставить существующий managed URL whitelist; для новых variants отдельный parser строгого profile/UUID/hash/bounding-size и optional repair hash. Не расширять `managedPath()` до произвольных вложенных путей.
- UUID parser должен принимать как upload UUID v4, так и детерминированный UUID v8 из `placeholderUrl()`; добавить реальный fixture фотопака. Нестандартный legacy token может остаться original-only, но нельзя лишить его прежней static доступности.
- Никаких URL decode перед конкатенацией с root; `%2e`, `%2f`, `..`, backslash, NUL, query и absolute paths отклоняются. Для legacy распознанный token может не быть strict UUID; не делать старые валидные managed ссылки недоступными из-за нового stricter parser. Новые записи всегда server UUID.
- `resolve` + string startsWith недостаточны: `relative(root,path)` containment, lstat/realpath roots и entries, запрет symlink компонентов; source open с O_NOFOLLOW и fstat. Directory ownership доверен service account, запрет untrusted writers; при возможности secure fd-relative операции. Проверять временные/final paths тоже.
- Не скачивать external ProductImage URL: исключается SSRF и зависимость backfill от сети. Не публиковать original archive/manifest/journal через static root.
- Нормализация MIME/5 MiB/25 MP/page limit сохраняется; variants не обходят admin guard, не добавляют admin mutations в public endpoints. Auth/OTP/Telegram, prices/cart/checkout не меняются.

### 7.2. Дисковый budget

Inventory dry-run даёт count, source bytes, dimensions/eligible/skipped и число missing slots. Реальный output budget получить на репрезентативных **копиях** 20–50 фото: square, portrait/landscape, alpha, high-detail, tiny. Не обещать процент экономии без этих данных.

Оценка: `existing bytes + missing variants estimate + raw archives новых upload + max active staging + journal/state + safety reserve`. Для worker стартовый output cap 2 MiB на variant и 6 MiB на source; staging reserve `concurrency * (5 MiB input + 6 MiB outputs + metadata margin)` плюс fixed reserve. При cap failure оставить original, не повышать лимиты скрытно. Profile/cap уточнить по samples.

На согласованном storage перед каждой job `statfs` доступных bytes и inode headroom. Начальный floor свободного места `max(1 GiB, 10% ёмкости тома)` плюс worst-case active job reserve; это conservative operational default, согласовать для небольшого тестового тома. Проверка свободного места не гарантирует успешную запись при конкурентных writers, поэтому все write/fsync errors обрабатываются.

Тот же disk admission применять до новых upload archive/base/pending writes, включая возможный orphan при rollback и конкурентные admission reservations. Отдельный API preflight max8 уменьшает ненужные archives, но не заменяет окончательный lock/check и дисковый budget.

### 7.3. Поведение при ошибках

| Ошибка | Действие |
| --- | --- |
| Sharp/invalid source | FAILED для source, original/old ready остаются; errorCode, без бесконечного retry. Остальные jobs продолжать только если это не системный/OOM сбой |
| ENOSPC / EDQUOT / inode exhaustion | Остановить новые jobs, безопасно закончить/отменить active, flush насколько возможно; ничего не удалять для автоматического освобождения места. Оператор увеличивает диск/уменьшает batch, затем dry-run/resume |
| EIO / неожиданная permission или FS semantics | Остановить batch; диагностика root/владельца/mount на staging, не fallback на запись в checkout/public temp |
| OOM / hard timeout | Supervisor останавливает worker; concurrency=1, пересмотреть budget/input; resume не объявляет partial output готовым |
| Source исчез/изменился | Прервать публикацию source readiness, журнал; не восстанавливать source из derivative и не писать original |
| Manifest corrupt / source mismatch | API отдаёт original, worker проверяет/reстроит manifest из реально проверенных derivatives; originals сохраняются |
| Объявленный variant missing | Read-only static miss fallback без обработки + frontend one-shot error fallback; исключить entry при refresh registry |

Backup должен включать public originals, raw originals, ready metadata и необходимые checkpoints. Pending/work можно восстановить reconciliation; всё же не удалять их автоматически во время инцидента. Проверять восстановление согласованной копии в staging, не только наличие архива. Chat storage не включать в новый product archive механически.

## 8. Тестовый план для будущей реализации

В этом документационном сеансе тесты не запускались. Новые проверки сначала FS/Sharp-only на temp fixtures; DB интеграция только отдельная изолированная local/staging среда. Не запускать production backfill как тест.

| Группа | Проверки / критерий |
| --- | --- |
| Generator | JPEG EXIF 1/6/8, PNG/WebP alpha, landscape/portrait/square, tiny/no enlargement, actual dimensions, full decode, no crop, stripped derivative metadata; input hash/bytes/mtime неизменны |
| Input security | SVG/HTML/GIF/animated WebP/APNG, spoof MIME, truncated data, >5 MiB, >25 MP, max edge, zero size/dimensions; fail closed, без output readiness |
| FS safety | Traversal/encoded separators/query/backslash/NUL, symlink file/parent/root, nonregular input, duplicate UUID/URL, root overlap/device mismatch; никакого чтения/записи вне allowlisted roots |
| Atomic/idempotent | Crash injection до/после temp, final, ready, journal; same source repeated → output bytes/mtime неизменны; two writers/source lock; EEXIST equal/conflict; partial slots; changed source/profile; corrupt final repair URL |
| Backfill | dry-run zero FS/DB writes, limit semantics, concurrency max, bounded memory, resume завершённого/прерванного run, torn last JSONL, out-of-order completion, skipped external/missing/oversized, missing slots only |
| Failure | ENOSPC/EDQUOT/EIO, no inode, permission denied, timeout/OOM simulation, SIGTERM/kill; correct originals/ready variants сохраняются, premature metadata отсутствует |
| Upload/import integration | New raw archive hash равен input; old original URL/bytes/assignment unchanged; post-commit queue/reconciliation; Sharp error → original usable; лимит8/locks/импорт skip/checksum гарантии сохраняются |
| API/static | Legacy payload совместим; готовые entries в products/list/detail/feed/favorites; hidden images/order unchanged; strict route/HEAD/Content-Type/cache/nosniff; private paths недоступны; missing derivative → no-store original fallback, malformed path → fail |
| Front helper | actual w, dedupe/order, original candidate only known dimensions, no variants fallback, asset origin, one-shot error removes srcset/sizes, URL change resets, feature flag rollback |
| SSR / layout | SSR HTML + payload совпадают при hydration; без window pre-render, square/contain/compact4:3 сохранены, no overflow, row heights/scroll anchor прежние, пустые фото/placeholder |
| Browser/staging | 320/390/430/639/640/767/768/1024/1280/1440/1536, DPR1/2/3, Chromium и Safari/real device; actual box/currentSrc/качество, gallery switch/thumbs, resize/back, fast scroll/jumps, pagination/virtualization |

Существующие образцы, которые нужно сохранить: `apps/api/src/admin/admin.spec.ts:266` (MIME/traversal/history), `admin/images.spec.ts` (visibility/order), `product/photo-pack.spec.ts` (byte preservation), `apps/api/test/photo-import.e2e-spec.ts` (idempotency/conflicts/static/concurrent imports). Последний использует отдельную DB schema; не запускать без разрешённой изолированной среды. `order/chat-images.service.ts` содержит примеры private root/statfs, но его поведение и тесты не менять.

Staging performance protocol: сравнивать один набор товаров/байтовых originals до/после, первые 24 без auto-pagination и отдельно длинный список. Cold cache и repeat cache; одинаковая сеть/CPU/момент scroll, не менее трёх повторов. Измерить early/total image bytes, request count/currentSrc, LCP, paint видимых фото, scroll image readiness, decode/RSS/worker duration, стандартный CLS session-window и отдельно pagination layout shifts. `complete/naturalWidth` не называть paint. Не принимать savings от пропущенных товаров за экономию одинакового набора.

Критерии выхода: ноль объявленных непубликованных candidates, все используемые variants декодируются, originals checksum сохранён, repeat run не меняет correct files, fallback работает, SSR без warnings; заметная экономия bytes подтверждена на том же наборе без устойчивой регрессии LCP/visible paint/быстрой прокрутки. Численный performance budget зафиксировать после baseline, не заявлять успешность до измерений. Устранение CLS `.product-more` — отдельная задача.

## 9. Поэтапное внедрение и откат

| Этап | Изменения | Gate |
| --- | --- | --- |
| A — generator и тесты | Standalone bounded generator, strict manifest/path parser, atomic writer, private raw archive helper, FS-only unit/integration tests; HTTP/API/frontend ещё прежние | Тесты безопасности/bytes/crash/idempotence на temp fixtures, утверждённый storage/profile; никаких миграций |
| B — тестовый backfill | Новый CLI, dry-run + limit/concurrency/resume, inventory из копий, 20–50 samples и repeat/crash test; потом ограниченный staging набор | Реальный disk/RSS/CPU/output budget, no rewrite originals/correct variants, журнал/recovery reviewed |
| C — API/frontend с fallback | Reader enrichment products/feed/favorites, safe static miss fallback/cache; feature flags; Card/thumbs srcset/sizes, contextual loading отдельным проверенным шагом | Legacy и missing/partial variants проходят, SSR payload/types совместимы; main gallery сначала original или отдельно verified sizes |
| D — staging | Post-commit pending/reconciliation worker для новых upload/import, deploy dirs/service/backup review; качество/DPR/fast scroll/cache/restart проверки | Независимые frontend/backend flags, восстановление backup, no 404 по ready metadata, performance comparison, operational runbook |
| E — production backfill | Только после отдельного разрешения: inventory/backup/free space, dry-run, малый limit/concurrency1, validate, постепенное увеличение | Подтверждённые storage roots/права/бюджеты и разрешение. В этом сеансе ничего из production не запускать |

Не merge/cherry-pick PR #5/#6 как prerequisite; не включать их source changes в image pipeline PR без отдельного рассмотрения. Generator/backend, backfill и frontend удобно проверять отдельными небольшими PR. Этот PR — только документация.

**Frontend rollback:** выключить предложенный `public.productImageVariantsEnabled` и вернуть original-only image props либо revert только frontend image commit. Сохранить прежнюю contextual loading policy через отдельный флаг/commit; не откатывать цены/cart/заказы. API additive metadata может остаться. URLs и files не удаляются, DB migrations для отката нет. Изменение runtime config требует согласованного применения в deployment, не является действием этого документа.

**Backend rollback:** остановить worker/новые pending jobs, выключить API enrichment flag; продолжать выдачу original и уже существующих variants URL. Не откатывать public cache к broken route, не удалять raw/variants/ready manifests. Восстановление обработки — dry-run + resume/reconciliation после причины сбоя. Production rollback/deploy также отдельное действие после разрешения.

## 10. Конкретные файлы будущей реализации

### Новые — предлагаемые имена, пока не существуют

| Файл | Ответственность |
| --- | --- |
| `apps/api/src/product/image-variants.ts` + `.spec.ts` | Sharp profile, bounded input/output validation, actual dimensions, generation в private staging |
| `apps/api/src/product/image-storage.ts` + `.spec.ts` | Roots/path parser/no-follow, original archive, locks, no-clobber publication, manifest atomic writes |
| `apps/api/src/product/image-manifest.ts` + `.spec.ts` | Strict schema/profile/source fingerprint, recovery/ready candidates |
| `apps/api/src/product/image-variants.service.ts` + `.spec.ts` | Bounded cached reader, pure response enrichment и pending enqueue; без business/pricing изменений |
| `apps/api/src/product/image-variants.module.ts` | Один provider для Product/Favorite/Admin injection, без глобального I/O в customerProduct |
| `apps/api/src/product/image-static.ts` + `.spec.ts` | Strict variant static namespace/cache/ENOENT original fallback без Sharp |
| `apps/api/src/product/image-worker.cli.ts` | Отдельный compiled worker, spool + reconciliation, process budgets/shutdown |
| `apps/api/data/product-image-variants/run.ts`, `backfill.ts`, `backfill.spec.ts` | CLI flags/inventory/read-only scan/resume/journal; тот же generator, не повторный encoder |
| `apps/web/app/utils/product-image.ts`, `apps/web/test/product-image.test.mjs` | Чистые srcset/sizes/геометрия/дедупликация, unit tests совместимые с текущим runner |
| `apps/web/app/composables/useProductImage.ts` | Reactive one-shot fallback/SSR-safe shared props |
| `deploy/shop-product-images.service` | Отдельный worker с CPU/RAM/доступом только к согласованным product storage dirs |

Допускается объединить маленькие файлы, если это сокращает абстракции; responsibilities и проверки не исчезают. Не создавать generic media platform/repository ради товаров.

### Существующие — только необходимые интеграции

- `apps/api/src/admin/images.service.ts`: raw preservation/base atomic write + post-commit enqueue; не менять authorization/max8/primary/visibility/history checks. `admin/admin.module.ts`: подключить image provider.
- `apps/api/src/product/photo-import.ts`: enqueue после успешного commit, без Sharp внутри transaction; `photo-pack.ts` сохранить byte-preserving audit, не увеличивать buffers всех вариантов в pack. `data/product-photos/run.ts` сохранить текущий CLI contract; hook интеграции не превращать в backfill.
- `apps/api/src/product/product.service.ts`, `product/product.module.ts`: enrich list/get/prioritySearch и результат productFeed после transaction. `product/feed.ts` менять только при необходимости чистого post-query enrichment, без SQL/ranking/cursor изменений.
- `apps/api/src/favorite/favorite.service.ts`, `favorite/favorite.module.ts`: enrich результат list, не favorite mutations.
- `apps/api/src/main.ts`: variant namespace static/fallback ordering/cache. `common/image.ts`: использовать existing validator; изменение общего поведения не требуется и отдельно проверяется, если unavoidable.
- `apps/api/package.json`, `apps/api/tsconfig.catalog.json`: scripts и lint/typecheck scope нового data CLI; Nest build уже включает src worker.
- `apps/web/app/types/product.ts`: единый optional ProductImage type; `components/product/Card.vue`, `Grid.vue`, `Gallery.vue`, `composables/useProductGallery.ts`: props/metadata/srcset/fallback/context.
- `apps/web/app/pages/index.vue`, `components/catalog/View.vue`, `pages/favorites.vue`: общий eager budget/context/offset, не по N каждой группе. `pages/product/[slug].vue`: только если нужны gallery layout hints. `nuxt.config.ts`: feature flag.
- `apps/web/app/composables/useAsset.ts`: существующая функция подходит; достаточно regression tests, не переписывать её без причины. `app.config.ts`/`assets/css/main.css`: источники geometry, менять layout не требуется.
- `deploy/deploy.sh`, `deploy/README.md`: private dirs, ownership, worker и согласованный backup/runbook. `deploy/nginx.conf`: проверить headers/routes; менять только если Nest variant headers не проходят, без воздействия на API/chat rules.

**Не менять в v1:** `apps/api/prisma/schema.prisma`, миграции, `product/select.ts` price transform, cart/checkout/order/Telegram/auth/OTP flows. Существующие исходные изображения и pack assets не включать в изменение.

## 11. Пошаговое задание Codex в VS Code

1. Прочитать `AGENTS.md` и этот документ, проверить текущий branch/status и новые инструкции. Создать отдельную implementation branch от актуального main, не смешивать PR #5/#6. Если есть пользовательские изменения — сохранить, не reset/clean/force push.
2. Подтвердить доступные paths и Nuxt UI container cap из установленного пакета. Собрать read-only inventory размеров/checksum на разрешённых локальных файлах. Не использовать production DSN/VPS; не ставить зависимости без необходимости/разрешённых условий среды.
3. Зафиксировать storage/private roots/profile/лимиты и no-clobber FS support. Если нужен иной storage или Prisma — сначала обновить решение для review, не делать миграцию автоматически.
4. Реализовать этап A: генератор + strict path/manifest/storage helper. Только temp fixtures, raw и public source hashes неизменны. Добавить meaningful tests EXIF/alpha/tiny/traversal/symlinks/atomic/crash/concurrent writer.
5. Реализовать новый backfill CLI с defaults dry-run, точными semantics limit/concurrency/resume и read-only input. Проверить zero writes dry-run, repeat mtime/hash, partial slots, torn journal и shutdown. Не вызывать existing image cleanup.
6. На разрешённой копии выполнить этап B с limit20/concurrency1, сохранить отчёт bytes/CPU/RSS/disk, repeat и controlled interruption/resume. Не переходить к production input.
7. Добавить API reader/enrichment/static fallback под backend flag. Убедиться, что original/hidden/order/query semantics прежние, никаких price/cart/Telegram изменений. FS lookup не держит DB transaction и не декодирует на GET.
8. Реализовать frontend shared type/helper Card/thumbs srcset/sizes под флагом. Сначала сравнить variants при прежней loading policy; потом contextual loading отдельным изменением. Main gallery responsive только с проверенной geometry/larger original. Error удаляет srcset/sizes и не зацикливается.
9. Добавить post-commit pending + отдельный worker/reconciliation для будущих upload/import; raw archive сохраняет bytes, source URL прежний, импортер сохраняет checksum/skip contract. Review worker deployment/private backup, не запускать deploy.
10. Выполнить только целевые unit/FS tests в доступной среде; lint/typecheck профильных файлов по возможностям. Browser/staging measurements из раздела 8 проводить отдельным согласованным сеансом. Не заявлять, что tests/build прошли, если они не запускались.
11. Подготовить небольшие reviewable PR с diff/validation/рисками; этот документ остаётся specification. Не включать сгенерированные uploads/raw архивы/journal/секреты в Git. Frontend rollback подтвердить без удаления files.
12. Остановиться перед production backfill/merge/deploy: представить конкретный отчёт staging, scope/command/budget/backup/recovery и получить отдельное разрешение. Не выполнять migrations, DB updates, force push, reset --hard, git clean или удаление originals.

Готовность к программированию: выбран вариант B без Prisma, определены source/variant semantics, private storage, bounded worker и восстановление, API/frontend contracts и этапы проверки. Окончательные quality/container cap/resource budgets подтверждаются на этапе A/B/D, а не предполагаются результатом этого документа.
