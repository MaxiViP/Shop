# KorzinaMarket — SEO / GEO / AEO аудит
Дата: 20.09.2026. Проверены production read-only и код; реализованы безопасные P1 в frontend. Commit/push/deploy не выполнялись. Backend/Prisma не менялись.

## Аудит до изменений
| Area | Current state | Problem | Priority | Proposed change |
|---|---|---|---|---|
| HTTP/HTTPS/domain | 301 HTTP→HTTPS, 308 www→non-www | Нет | — | Сохранить |
| SSR | Public pages 200, H1 и товары в HTML | Crawl blocker не подтверждён | P0 не найден | Сохранить SSR |
| Главная | Нет title/description | Неполные metadata | P1 | Единые defaults |
| Каталог/категории/товары | Короткие title | Нет полных динамических metadata | P1 | Fallback из реальных данных |
| Canonical | Отсутствует | Query-дубли | P1 | Canonical на основной домен |
| Русский язык | ru-RU, og:locale ru_RU, Content-Language ru | Нет | — | Сохранить nginx |
| Open Graph | Неполные данные | Слабые previews | P1 | Title/description/url/image |
| robots.txt | Allow all, нет Sitemap | Неполный discovery | P1 | Добавить Sitemap |
| Private pages | cart/orders/favorites/admin login без noindex | Могут индексироваться | P1 | Meta + HTTP noindex |
| Sitemap | /sitemap.xml и /api/sitemap.xml 404 | Нет списка URL | P1 | Динамический Nitro endpoint |
| Product schema | Отсутствует | Нет структурированных Offer | P1 | Реальные цены/данные |
| Availability | active = публикация, inventory API нет | Нельзя вывести наличие | P2 | Источник stock отдельно |
| Entity | Нет WebSite/OnlineStore | Бренд не описан | P1 | Только известные факты |
| Breadcrumbs | Нет полной цепочки | Слабая иерархия | P1 | Ссылки + JSON-LD |
| Delivery | Недостаточно фактических условий | Слабая public landing | P1 | Подтверждённые районы/расчёт/provider |
| Shipping schema | Доставка динамическая | Fixed rate будет ложным | P2 | Не выдумывать тариф |
| Category models | DB parentId есть, public API id/name/slug | Нет описаний/parent chain | P2 | Расширить API/admin |
| SEO overrides | DB/admin полей нет | Нет редакторского SEO | P2 | Optional frontend readiness |
| Internal links | Первые 24 товара SSR, затем JS load more | Нет crawlable next links | P2 | SSR-пагинация |
| Publication | Product.active фильтруется, category.active у товаров нет | Возможен товар скрытой категории | P2 | Согласовать политику |
| API failures | Ошибка API могла стать 404 | Риск деиндексации | P1 | Отличать 404/503 |
| YML | /yml.xml 404 | Feed отсутствует | P2 | После согласования наличия/формата |
| IndexNow | Отсутствует | Нет notifications | P2 | Асинхронно после транзакции |
| Images/CWV | WebP, product alt; измерений CWV нет | Runtime не проверен | P2 | Отдельная performance проверка |
| AI crawlers | Robots не блокирует OAI-SearchBot | WAF/IP отдельно не проверены | P2 | Сохранить доступ |
| llms.txt | Нет | Не обязательный стандарт SEO | P3 | Не заменять им SEO |
| Webmaster кабинеты | Доступа нет | Регион/индекс неизвестны | P2 | Checklist владельцу |

## Реализовано
Единый shared/utils/site.ts: бренд, canonical URL, Москва, Багратионовская, Фили-Давыдково, прилегающие районы, зависимость цены доставки от адреса/расстояния. Название «Яндекс Доставка» берётся из существующего deliveryProvider.YANDEX; в проекте есть соответствующая интеграция.

Главная получила точные title/description владельца, видимый factual block и ссылку на доставку. Hero behavior не изменялся. Категории/товары получают универсальные metadata без hardcoded категорий; product.description используется при наличии. Optional seoTitle/seoDescription имеют приоритет, когда API начнёт их возвращать. Новые категории/товары не создавались.

SSR metadata: title, description, canonical, OG title/description/url/site_name/locale/image, Twitter card. Default image — существующий hero-0.webp. Canonical без query/hash, основной домен HTTPS non-www.

Private routes cart/checkout/profile/orders/favorites/admin/staff/auth: noindex, follow. Существующая более строгая политика tracking-страницы сохранена. Фильтры/сортировки каталога noindex, tracking params не делают страницу noindex. Query page сейчас не создаёт отдельную SSR-пагинацию: при её реализации понадобится собственный canonical каждой страницы.

Product/Offer: реальные name/id/category/images/description, RUB, API price в рублях, priceQty/unit. Нет вымышленных availability/rating/reviews/vendor/barcode. Active не приравнивается к InStock. WebSite + OnlineStore: реальные бренд/URL/описание/areaServed; без вымышленных адреса/телефона/графика/соцсетей. Видимые breadcrumbs и BreadcrumbList. JSON-LD защищён от закрытия script через пользовательский текст.

404 для отсутствующего slug; 503 при недоступности upstream. /delivery объясняет известные условия и заказ, без fixed time/rate/free delivery и вымышленных условий самовывоза. Fake FAQ schema и shippingRate не добавлены.

Robots разрешает crawling и assets, содержит Sitemap: https://korzinamarket.ru/sitemap.xml. OAI-SearchBot, Googlebot, Bingbot, YandexBot не заблокированы. GPTBot policy не менялась.

## Sitemap и масштаб
/sitemap.xml — Nitro поверх действующего public API из БД. Автоматически root/catalog/delivery, опубликованные категории/товары. Query/private URL исключены; optional indexable=false учитывается. Cache до 60 секунд, без stale-while-revalidate. Обход всех страниц по 60 товаров, максимум 4 параллельных запроса. Ошибка API → 503, не пустой успешный sitemap. Нет ложных lastmod/changefreq/priority: updatedAt API пока не отдаёт.

2 000 товаров — около 34 list-запросов на обновление, без detail-запросов. Перед 50 000 URL нужен sitemap index. Обход API не транзакционный snapshot; при росте/частых публикациях стоит серверная потоковая генерация. Child categories получают стабильный slug URL, если public API их возвращает; полная parent chain требует расширения API.

## Второй этап
- DB/admin Category: существующие slug/parentId/updatedAt + description, seoTitle, seoDescription, image, indexable. Product: seoTitle/seoDescription/indexable и отдельно достоверное наличие. Public API должен отдавать эти поля. Миграций сейчас нет.
- Согласовать товары скрытых категорий. OutOfStock держать по полезному URL после появления inventory source.
- История slug и точные 301; удалённым товарам 404/410, не redirect всем на homepage.
- Настоящая SSR-пагинация с crawlable links и self-canonical; sitemap не заменяет internal linking.
- YML НЕ реализован. Нужен динамический DB feed с реальными id/url/price/RUB/categoryId/picture/name/description; available по согласованной модели. Выбрать целевой сервис Яндекса и актуальный формат. Не выдумывать manufacturer/barcode.
- IndexNow НЕ реализован, отправок нет. Env-only key + keyLocation, queue/outbox после успешной транзакции; timeout/retry; ошибки не блокируют admin. Уведомлять старый и новый URL при смене slug.
- Контакты/адрес/телефон/график/самовывоз/правила возврата — TODO владельцу. Не выдумывать LocalBusiness.
- Hero hydration bug из предыдущей задачи не подтверждён и не исправлен этим SEO audit. Browser недоступен. CWV/LCP/CLS/INP отдельно проверить; не изменялись slider behavior и ProductCard layout.
- Не создавать fake categories, doorway pages, скрытые тексты и отзывы. Редакторские уникальные descriptions нужны поверх универсальных fallback.

## GEO и официальные источники
Для AI features Google не требует специальной AI-разметки/файла: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features).
OAI-SearchBot и GPTBot имеют разные назначения и независимую политику: [OpenAI bots](https://platform.openai.com/docs/bots).
Noindex требует доступного crawling: [Google noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing).
Пагинации нужны ссылки и корректные canonical: [Google ecommerce pagination](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading).
[Product snippets](https://developers.google.com/search/docs/appearance/structured-data/product-snippet), [IndexNow](https://www.indexnow.org/documentation).
Источники проверены прямыми HTTP GET: web connector не работал. Разрешение crawler не гарантирует показ в выдаче/ответах.

## Checklist владельцу
- Яндекс Вебмастер: подтвердить сайт, отправить sitemap после публикации, проверить индексирование, регион Москва, запросы и crawl errors.
- Яндекс Бизнес: реальные название/сайт/телефон/график/фото, адрес или подходящий формат бизнеса, зоны Багратионовская/Фили-Давыдково, реальные отзывы.
- Google Search Console: verify, sitemap, index coverage/URL Inspection, Rich Results, Core Web Vitals.
- Bing Webmaster Tools: verify, sitemap, crawl reports; IndexNow после реализации.
- Google Business Profile, Bing Places, 2GIS — если бизнес соответствует требованиям; только реальные данные.
- После публикации Rich Results Test/Schema Validator, проверка OG image и повторный production SSR audit.
- Подтвердить контакты, часы работы и условия самовывоза/доставки.

## Проверки
Lint PASS; typecheck PASS; production build PASS; git diff --check PASS.
8 новых SEO unit tests PASS: metadata/canonical/noindex, цены/единицы, отсутствие invented fields, escaping, store facts, sitemap pagination/error handling.

Production Nitro SSR smoke PASS с локальным fixture API и снимком реального публичного каталога (3 категории, 28 товаров). Без backend/БД и внешних fetch. Проверены /, /catalog, /catalog/frukty, /product/ananas, /delivery: title/description/canonical/один H1/robots/JSON-LD. Product Ananas: 800.00 RUB из API. Private meta/X-Robots-Tag, 404 отсутствующих category/product, 503 API error PASS.
/robots.txt PASS. /sitemap.xml: 34 уникальных canonical URL, XML parser PASS.
Команды: pnpm --filter web lint; pnpm --filter web typecheck; pnpm --filter web build; node --test apps/web/test/seo.test.mjs; node apps/web/test/seo.smoke.mjs; git diff --check.
Smoke принимает SEO_SMOKE_FIXTURE с snapshot JSON и сохраняет HTML/XML/results в TEMP/shop-seo-smoke.
YML отсутствует и не валидировался. Backend tests не запускались, backend не менялся. Старые checkout fixtures не изменялись.
Runtime browser/hydration/CWV не проверены; SSR smoke не является их подтверждением.
Production не обновлён. Сторонние favicon changes сохранены. git diff --stat не включает untracked.
