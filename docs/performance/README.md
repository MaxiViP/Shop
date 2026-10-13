# Аудит производительности KorzinaMarket — 13 октября 2026, МСК

Безопасные исправления сократили мобильный Lighthouse на локальном fixture с **31 до 44**, desktop — с **47 до 63**. Мобильный FCP в Lighthouse: **8,42 → 4,25 с**. На дополнительном браузерном профиле 10 Мбит/с мобильный LCP: **3,48 → 2,84 с**. Это результаты локального приложения, а не показатели korzinamarket.ru. Цели 80+, LCP <2,5 с и TBT <200 мс пока не достигнуты.

База: актуальная `main`, `238710e4a04d05e7920f6e1fa596a3e992c0b19a`. Ветка: `perf/storefront-loading`. Production, VPS, БД, миграции и deploy не затронуты. Авторизация, Telegram OIDC, SMS OTP, DEMO/TEST_PHONE, сессии и бизнес-расчёты не менялись.

## Доступность production и границы доказательств

Попытка `curl -I --http2 https://korzinamarket.ru` через установленный прокси завершилась `CONNECT tunnel failed, response 403`. Ответ принадлежит прокси Envoy, а не магазину. Домен отсутствует в разрешённых HTTP-направлениях среды. Ограничение не обходилось. GitHub доступен; PR #5 и актуальная main прочитаны.

Поэтому **не измерены** production TTFB, SQL/API latency, HTTP/2/3, действующие TLS/Nginx, Cache-Control, сжатие, console errors и полевые CWV. Исходный production JSON Lighthouse не приложен: показатели ниже перенесены из задания, причина console errors по ним не устанавливается.

| Метрика production | До, из задания | После на production |
| --- | ---: | --- |
| Performance | 34 | Не измерено |
| Accessibility | 96 | Не измерено |
| Best Practices | 96 | Не измерено |
| SEO | 100 | Не измерено |
| FCP | 8,5 с | Не измерено |
| LCP | 16,1 с | Не измерено |
| TBT | 1080 мс | Не измерено |
| CLS | 0 | Не измерено |
| Speed Index | 8,5 с | Не измерено |
| Переданный объём | 5147 КиБ | Не измерено |

## Воспроизводимые локальные замеры

Lighthouse **13.5.0**, Chromium **154.0.8037.57**, Node 24.19.0, pnpm 11.25.0. Production-сборки Nuxt/Nitro, loopback HTTP, отдельный Chromium. Fixture API в памяти: 24 товара, уникальные URL одной WebP 324254 байта, два слайда; по 150 мс задержки на API-запрос. Никакого запуска Nest/Prisma/БД. Искусственно тяжёлые карточки позволяют видеть конкуренцию запросов; их нельзя приравнивать к production-каталогу.

Lighthouse использовал стандартную **симуляцию**: mobile 412×823, DPR 1,75, CPU ×4, RTT 150 мс / 1638,4 Кбит/с; desktop — `--preset=desktop`. Точные настройки и значения находятся в [lighthouse-summary.json](lighthouse-summary.json). По одному Lighthouse-прогону на профиль и сборку: это сравнение, а не статистическое доказательство или полевая p75. [Полные JSON/HTML-отчёты, screenshots и сырые данные](reports.zip) включают manifest с SHA-256 и ссылкой на Draft PR #6.

| Lighthouse | Mobile до | Mobile после | Desktop до | Desktop после |
| --- | ---: | ---: | ---: | ---: |
| Performance | 31 | 44 | 47 | 63 |
| Accessibility | 92 | 92 | 92 | 92 |
| Best Practices | 100 | 100 | 100 | 100 |
| SEO | 100 | 100 | 100 | 100 |
| FCP, с | 8,418 | 4,251 | 1,622 | 0,942 |
| LCP, с | 35,571 | 31,323 | 6,393 | 5,690 |
| TBT, мс | 1448 | 913 | 451 | 285 |
| CLS | 0 | 0 | 0 | 0 |
| Speed Index, с | 8,418 | 4,251 | 2,023 | 1,034 |
| Переданный объём, КиБ | 9290 | 8453 | 9379 | 8453 |

Отдельный CDP-профиль применяет **реальное ограничение** сети 10 Мбит/с / 60 мс, CPU ×4 на 390 px и ×1 на 1440 px, высоту 950 px, DPR 1, отключённый cache. Три прогона, ниже медианы. Эти FCP/LCP нельзя смешивать с симулированными Lighthouse-значениями. Сохраняются Resource Timing waterfall, LCP entries, long tasks, layout shifts, размеры изображений и времена запросов API. После исправлений каждый прогон использует отдельный browser context; темы и корзина из функциональных проверок не переходят в следующий прогон.

| CDP, первый экран | 390 px до → после | 1440 px до → после |
| --- | ---: | ---: |
| TTFB, мс | 721 → 469 | 679 → 422 |
| FCP, мс | 1728 → 1036 | 1524 → 736 |
| LCP, мс | 3484 → 2836 | 3480 → 2772 |
| Завершённые resource entries к снимку | 108 → 83 | 112 → 77 |
| Переданные JS, байт | 869886 → 250307 | 949458 → 250307 |
| Переданные CSS, байт | 267037 → 32912 | 278315 → 32912 |

Resource entries фиксируются после hydration/загрузки hero плюс 2,5 с; это ограниченное окно, не полный трафик сессии. JS/CSS-экономия объединяет сжатие и изменение prefetch; она не означает такое же сокращение распакованного кода или затрат hydration. Shared cloud VM даёт шум, особенно в первом холодном прогоне. [До](before-chromium.json), [после](after-chromium.json).

## Топ-10 наблюдений о задержках

Ниже доказательства по коду и локальной лаборатории. Их вклад в production остаётся предметом замера; потенциальные экономии Lighthouse не складывались и не использовались как измеренное ускорение.

| № | Причина / ограничение | Доказательство и вывод |
| --- | --- | --- |
| 1 | Исходники существенно крупнее карточек | 146 импортных WebP — 1024×1024, 23 028 456 байт. На 390 px карточка fixture занимает 177,75×177,75 CSS px. `Card.vue` имеет только `src`, без готовых вариантов и `srcset`. DPR необходимо учитывать; WebP сам по себе не устраняет лишние пиксели. |
| 2 | Фото ниже первого экрана конкурируют с критическими ресурсами | Первая страница содержит 24 карточки; у main нет `loading`, значит применяется eager по умолчанию. Lighthouse fixture передал 25 тяжёлых фото вместе с hero. Lazy-кандидаты PR #5 имеют известные UX-компромиссы; без размера файлов не решают полный трафик. |
| 3 | Приоритет hero не выделен | Во всех шести исходных CDP-прогонах LCP — `img.hero__image`, исходник 1672×941 / 324254 байта. В исходном HTML нет fetchpriority. После изменения первый слайд high, следующий auto; остальные слайды не вставлены в DOM заранее. Причина подтверждена на fixture, production LCP ещё требует проверки. |
| 4 | Последовательная цепочка SSR главной | `index.vue` ожидала categories, затем products; асинхронный дочерний HeroCarousel затем ожидал slides. В trace начало каждого запроса идёт после окончания предыдущего. Теперь три запроса перекрываются; каждый endpoint запрашивается один раз и передаётся через SSR payload. Авторизационный запрос app.vue не менялся. |
| 5 | Несжатый render-blocking CSS | Основной entry CSS — около 200 КБ. Исходный Lighthouse показывает 940 мс потенциальной экономии render-blocking, но это не измеренное ускорение. После сборочного сжатия тот же CSS: identity 200489, gzip 26632, br 21246 байт; декодированное содержимое идентично. |
| 6 | Несжатые статические JS | Исходная сборка не создаёт gzip/br, Nitro по умолчанию `compressPublicAssets: false`. Локальные HTTP-ответы после изменения подтверждают negotiation/Vary; сокращение transfer не убирает стоимость выполнения JS. Фактическое production-сжатие неизвестно. |
| 7 | Предзагрузка связанных маршрутов после hydration | В исходном waterfall появляются дополнительные JS/CSS каталога, корзины и товара около 5 с; Lighthouse показывает 211 КиБ потенциально неиспользуемого JS. Теперь prefetch происходит по наведению/фокусу. Фокус запускает загрузку, навигация проверена. На первом посещении touch-маршрут может загружаться при нажатии — это остающийся компромисс. |
| 8 | Значительная работа hydration / основного потока | Исходный mobile Lighthouse: main thread 3,38 с, JS bootup 1,74 с, девять long tasks; TBT 1448 мс. После безопасных изменений TBT 913 мс, всё ещё выше цели. Точная стоимость отдельных Vue/UI-компонентов не доказана; массовое client-only или удаление функций не применялись. |
| 9 | Повторные загрузки публичных фото из-за TTL | У static hero нет Cache-Control, но есть ETag/Last-Modified; Express static products не задаёт долгий maxAge. У hashed `/_nuxt/` уже корректно `public, max-age=31536000, immutable`. Долгий cache публичных неизменяемых UUID-файлов предложен отдельно; это преимущественно повторные визиты, не холодный LCP. |
| 10 | Затраты layout и измерения DOM | Исходный Lighthouse: Style & Layout 609 мс. `useGridWindow` читает computed style/rect каждой смонтированной карточки, сохраняет anchor и обновляет окно. Локальный forced-reflow insight не указал виновный стек; нельзя объявлять его причиной production long tasks. Алгоритм не переписан без trace на реальном списке. |

Фоновые запросы уведомлений возникают после hydration; повторной загрузки categories/products/slides при первоначальной hydration в контролируемом сценарии нет. Console errors/warnings в новом storefront smoke отсутствуют; исходные production console errors не идентифицированы. Шрифты не дали подтверждённого отдельного bottleneck; font providers или семейства произвольно не отключались.

## Группа 1: безопасные изменения обычного PR

- `index.vue`: независимые categories/feed/slides стартуют до общего await. `useHomeSlides` продолжает регистрировать lifecycle hooks до await; его refresh/expiration сохраняются на странице. Hero получает реактивные slides как props.
- `HeroCarousel.vue`: eager/high для первого LCP-кандидата, auto для последующих активных слайдов. SSR-текст, h1 страницы, кнопки, swipe, autoplay, pause, темы и резерв высоты сохранены.
- `nuxt.config.ts`: статические gzip/Brotli генерируются при сборке. Nitro сохраняет MIME, ETag, Vary и immutable для hashed assets. API/HTML публично не кешируются этой настройкой.
- `NuxtLink`: prefetch по interaction вместо visibility; функции маршрутов сохранены.
- Адаптированы реальные unit fixtures, добавлен самостоятельный smoke и CI. Не добавлены production-зависимости, `any`, новые observers на карточки или изменения данных товаров.

Эффект отдельных настроек, кроме объёмов сжатия и перекрытия API, не изолирован: таблицы измеряют весь безопасный набор. Холодный LCP и полный размер картинок остаются главным открытым этапом.

## Изображения: фактическое состояние и эксперимент

**В этом PR фото и их URL не меняются.** Ниже фактическое до/после и отдельная модель следующего этапа, а не выданные за внедрение thumbnails.

| Файлы | До | После безопасного PR |
| --- | --- | --- |
| hero-0.webp | WebP, 1672×941, 324254 байта | То же |
| hero-1.webp | WebP, 1672×941, 409290 байт | То же |
| hero-2.webp | WebP, 1672×941, 307628 байт | То же |
| hero-3.webp | WebP, 1672×941, 312292 байта | То же |
| 146 импортных фото | WebP, 1024×1024, всего 23028456 байт | То же |

`scripts/product-image-audit.mjs` только читает импортный набор и кодирует варианты в памяти через уже установленный sharp, quality 85, без enlargement. Для 12 самых крупных файлов: **3242748 → 381206 байт** при 384 px, экономия **88,2%**. Это выбранная крупная выборка, не среднее по production. AVIF не внедрён и его качество/CPU не измерялись.

| Пример | Исходник 1024×1024, байт | Предложение WebP 192 px | 384 px | 640 px |
| --- | ---: | ---: | ---: | ---: |
| bakery-sourdough-wheat-bread | 337230 | 9990 | 36294 | 90796 |
| bakery-rye-bread | 309978 | 8296 | 32166 | 83588 |
| kondifud-marmalade-500g | 283714 | 8016 | 29658 | 76174 |

Полный инвентарь и sample encodings: [image-audit.json](image-audit.json). Визуальная приёмка, DPR 2/3, portrait/alpha, Safari и реальные originals должны предшествовать включению.

## PR #5 и совместимость

[Draft #5](https://github.com/MaxiViP/Shop/pull/5), head `ba935d9eaec1ed930c8c2d0955e486e7a247378e`, рассмотрен вместе с первоначальным и повторным отчётом. Его политика four eager/high + lazy/async + lookahead 3000 px не принята автоматически: повторная ограниченная сеть не показала устойчивого LCP-выигрыша; адаптивный lookahead ухудшал ожидание после прыжков. Вывод «уменьшать размеры готовых вариантов прежде дальнейшей настройки loading» обоснован.

Четыре production-файла image-политики #5 (`Card.vue`, `Grid.vue`, `catalog/View.vue`, `favorites.vue`) здесь не меняются. Его observers и eager-бюджет не дублируются. #5 основан на более старой main; переносить весь diff с текущей main как будто это его собственные изменения нельзя. Сохранённые отчёты #5 — чужие измерения, а не повторно полученные результаты этого аудита.

## Группа 2: обработка/хранение изображений — отдельное согласование

1. Сохранить каждый существующий URL/master для галереи и historical order snapshots. При новых загрузках отдельно сохранять оригинал; публичные варианты очищать от EXIF и согласовать private storage оригинала.
2. Существующий sharp: rotate, no enlargement, лимиты MIME/пикселей/pages как сейчас. WebP 192/384/640, quality по визуальной приёмке; AVIF — отдельный эксперимент CPU/качества, не обязательная новая зависимость.
3. Генерировать при upload/import или ограниченным worker, не на каждый GET. Сначала атомарно создать готовые файлы, затем опубликовать metadata. Ограничить concurrency/место/ошибки; rollback удаляет только новые собственные варианты.
4. Необязательная metadata готовых вариантов в API с width/height/type. Legacy без metadata продолжает отдавать исходник. При необходимости Prisma — отдельный PR и отдельно согласованная миграция; сейчас schema не менялась.
5. `srcset` только из реально существующих файлов, `sizes` по Nuxt container/колонкам/gaps, original как кандидат для больших DPR. Card использует contain/квадратную область; hero требует cover с учётом высоты, а не механического `sizes=100vw` на телефоне.
6. Сначала backfill на копии/staging, ограничение CPU, визуальное сравнение, проверка MIME, cache/404 и historical references. Production backfill не выполнен. Не удалять originals или пользовательские фото.
7. Повторить mobile/desktop Lighthouse и реальный scroll/paint с одинаковым набором товара; затем уточнять lazy/loading/decode вместе с #5. Заранее обещать 80/90+ нельзя.

## Группа 3: сервер и Nginx — отдельное развёртывание

В `deploy/nginx.conf` находится **HTTP bootstrap**, который Certbot дополняет TLS вне репозитория. `proxy_http_version 1.1` относится к Nginx → Node и **не доказывает HTTP/1.1 между браузером и HTTPS**. Нельзя добавлять HTTP/2 в несуществующий в репозитории TLS server и считать проблему решённой.

[nginx-performance.patch](nginx-performance.patch) — **предложение против шаблона, не применённое изменение**. Оно добавляет gzip для текстовых ответов, отдельный `/_nuxt/` с сохранением Nitro headers, private/no-store для общего SSR и годовой cache только для write-once UUID WebP products. Ответы ошибок не получают годовой TTL. `/api/` и chat-upload no-store/лимиты остаются прежними; private chat не включается в публичную раздачу. Patch проверен через `git apply --check`; runtime `nginx -t` здесь не выполнен. Неверсионированные hero остаются revalidation-кандидатами, а не автоматически immutable.

**Не копировать bootstrap поверх production-конфига Certbot.** После отдельного согласования оператор переносит только нужные директивы в действующий TLS server, сохраняя сертификаты, redirects, trusted proxy и остальные location. Перед любым будущим применением:

```sh
nginx -v
nginx -V
sudo nginx -t
curl --http2 -I https://korzinamarket.ru
curl -sS -o /dev/null --http2 -w 'http=%{http_version} ttfb=%{time_starttransfer}\n' https://korzinamarket.ru
```

Для Nginx ≥1.25.1 после проверки модуля и реального TLS server допустимы `listen 443 ssl;` + `http2 on;`; для более старого — `listen 443 ssl http2;`. Это условные варианты, не готовый diff неизвестной production TLS-конфигурации. HTTP/3 требует отдельной проверки QUIC/module/firewall и в первый этап не включён. Brotli-модуль Nginx не требуется для подготовленных Nitro `.br`; gzip остаётся полезен для HTML. Команд reload/deploy здесь нет.

Далее измерить без записи в production: HTML, успешный hashed asset, существующий public product, отсутствующий product (404 без immutable), приватный API с cookies, MIME/Content-Encoding/Vary/ETag и 304. Cache для SSR с персональным payload, cart/auth/sessions/private API запрещён; `proxy_cache off` сохраняется.

Production web.env в deploy-инструкции задаёт публичный HTTPS API также для SSR. Приватный loopback API для серверного Nuxt может убрать внешний hop, но требует отдельной настройки и проверки cookie/proxy behavior; сейчас общий `useApi` и auth транспорт не изменялись. SQL/feed содержит revision count/aggregate и оконное ранжирование с ограниченным memory cache. Его фактическая latency не измерена; планы EXPLAIN, pg_trgm или новые индексы без production evidence/согласования не применялись.

## Проверки

`pnpm check` успешно: typecheck, lint, backend **1127 passed / 3 skipped**, gateway **67 passed**, frontend **366 passed**, сборки всех трёх приложений. Prisma Client локально generated для типов; миграции и подключения к БД не выполнялись. Первый check встретил штатный storage guard теста chat: `/tmp` всего 4,9 ГиБ при пороге 10 ГиБ. Повтор с `TMPDIR` в workspace, где достаточно места, прошёл без изменения порога или приложения.

`catalog.smoke.mjs`: **18 сценариев**, 240 товаров, ширины 320/360/390/768/1024/1440; SSR, hydration, категории/history, сортировка, поиск/фильтры, пагинация/виртуализация, overflow и мобильные controls. Новый smoke на 390/1440 подтвердил [темы, interaction prefetch, навигацию, видимые фото и гостевую корзину](flows.json), единичные SSR-запросы, приоритет hero и отсутствие console/hydration warnings. [HTTP headers](headers.json) подтверждают br/gzip и побайтовое совпадение декодированного CSS.

Полный существующий `home.smoke.mjs` прошёл layout/carousel на шести ширинах и проверку cart quantity/free-delivery/pickup, затем остановился в сценарии админки на отсутствующей кнопке `Опубликовать` (`home.smoke.mjs:207`). Он не объявляется полностью успешным. В отдельно собранном worktree чистой main `238710e` воспроизведён тот же TypeError в том же шаге, после успешных шести viewport-проверок. Это существующий дефект smoke-сценария; административные UI/fixtures здесь не менялись. Снимки первого экрана 390 px, run 1, до/после побайтово совпадают (SHA-256 `8b0a619d43c819534b2b4c72cc91adb1664548a62df5cb4d8c9a389f327bb42a`); это проверка данной fixture, а не всех возможных storefront-данных.

Новый `.github/workflows/storefront-performance.yml` повторяет локальный browser regression в CI. Успешный локальный запуск не означает уже завершённый GitHub CI; его результат следует проверить в Draft PR.

## Воспроизведение

```sh
pnpm install --frozen-lockfile
pnpm --filter api exec prisma generate --config prisma7.config.ts
pnpm check
pnpm --filter web build
CATALOG_BROWSER_PATH=/usr/bin/chromium PERF_EXPECT_PARALLEL=1 PERF_EXPECT_COMPRESSED=1 node apps/web/test/storefront-performance.smoke.mjs
node scripts/product-image-audit.mjs
```

Для Lighthouse установить CLI **только в scratch**, не в package.json: `npm install --prefix work/performance/lighthouse --no-package-lock --no-save lighthouse@13.5.0`. Затем добавить `PERF_LIGHTHOUSE_CLI=work/performance/lighthouse/node_modules/lighthouse/cli/index.js` к smoke-команде. На baseline выключить `PERF_EXPECT_PARALLEL`/`PERF_EXPECT_COMPRESSED`; использовать ту же fixture-версию и исходный built main. `PERF_ARTIFACT_DIR` задаёт каталог отчётов, `PERF_RUNS` — число CDP-повторов. Nitro smoke блокирует внешние server-side fetch; fixture/браузер не используют production данные.

Осталось подтвердить production метрики/протокол/console, качество thumbnail/DPR/Safari, field p75 и сроки first-touch навигации. Полный checkout E2E с БД не запускался в этом аудите. Размеры фото и тяжёлая hydration объясняют, почему безопасный этап не достигает всех целей; следующий существенный выигрыш ожидается от согласованного image pipeline, затем точечного профилирования UI и инфраструктуры.
