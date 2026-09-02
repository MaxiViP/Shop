# Shop

Интернет-магазин свежих продуктов с московского рынка: каталог, корзина, гостевой checkout, профиль покупателя, сборка заказов продавцом и интеграция с внешней доставкой.

Проект развивается как production-oriented monorepo с отдельными Nuxt frontend и NestJS API.

## Что уже реализовано

### Покупатель

- каталог и карточки товаров;
- поиск по названию и описанию, фильтрация по категории, безопасная сортировка и постраничная загрузка;
- избранное: локально для гостя, в аккаунте для авторизованного пользователя и автоматическое объединение после входа;
- товары на вес и поштучно;
- корзина;
- оформление заказа без регистрации;
- доставка и самовывоз;
- вход по номеру телефона и OTP без постоянного пароля;
- профиль и сохранённые адреса;
- история заказов;
- просмотр заказа по защищённому `publicId`;
- публичная страница отслеживания `/track/:token` без авторизации;
- guest-session: гость видит свои заказы на том же устройстве;
- после входа по тому же номеру подходящие гостевые заказы связываются с аккаунтом.

### Продавец

Рабочее место продавца доступно ролям `SELLER` и `ADMIN`.

Order flow:

```text
NEW
→ CONFIRMED
→ ASSEMBLING
→ READY
→ DELIVERING
→ COMPLETED
```

Во время сборки продавец может:

- указать фактический вес/количество;
- отметить товар как `PICKED`;
- отметить товар как `MISSING`;
- вернуть ошибочно обработанную позицию обратно в `PENDING`;
- завершить сборку только после обработки всех позиций.

Финальная стоимость товаров рассчитывается backend по фактически собранному количеству.

### Доставка

Поддерживаются два провайдера:

- `YANDEX` — автоматическая интеграция с Yandex Delivery B2B API;
- `OTHER` — ручная внешняя курьерская служба.

#### Yandex Delivery

Backend умеет:

- рассчитывать актуальную стоимость доставки;
- создавать Yandex claim;
- принимать заявку;
- получать tracking URL;
- хранить внешний статус;
- автоматически синхронизировать активные доставки;
- переводить заказ в `DELIVERING`, когда курьер забрал заказ;
- автоматически переводить заказ в `COMPLETED` после успешной доставки.

Основные Yandex endpoints:

```text
POST /offers/calculate
POST /claims/create
POST /claims/info
POST /claims/accept
POST /claims/tracking-links
POST /claims/bulk_info
```

Активные Yandex-доставки синхронизируются backend примерно раз в 30 секунд. Polling работает без frontend и без обязательного callback.

Стоимость Yandex не рассчитывается приложением самостоятельно: source of truth — ответ Yandex API. Деньги внутри приложения хранятся как integer kopecks.

#### Other delivery

Для другой курьерской службы продавец вводит данные вручную.

Обязательно:

- имя курьера;
- телефон курьера.

Необязательно:

- tracking URL;
- внешний ID;
- стоимость.

## Роли

```text
USER    покупатель
SELLER  продавец / сборщик
ADMIN   полный административный доступ + staff workflow
```

## Стек

### Frontend

- Nuxt 4.5
- Vue 3.5
- TypeScript
- Nuxt UI 4
- Tailwind CSS 4
- Pinia
- SSR

### Backend

- Node.js 24
- NestJS 12
- TypeScript
- Prisma 7
- PostgreSQL 18
- `@prisma/adapter-pg`
- Zod / Standard Schema validation
- Vitest
- oxlint

### Infrastructure

- pnpm workspace
- Docker Compose
- PostgreSQL 18.6

## Структура

```text
Shop/
├─ apps/
│  ├─ api/                 NestJS API
│  │  ├─ prisma/           schema, migrations, seed
│  │  └─ src/
│  │     ├─ address/
│  │     ├─ auth/
│  │     ├─ category/
│  │     ├─ common/
│  │     ├─ db/
│  │     ├─ delivery/
│  │     ├─ health/
│  │     ├─ order/
│  │     ├─ product/
│  │     └─ staff/
│  └─ web/                 Nuxt application
├─ compose.yml
├─ AGENTS.md
├─ package.json
└─ pnpm-workspace.yaml
```

## Модель данных

Основные сущности:

```text
Category
Product
ProductImage
User
Address
Session
Otp
GuestSession
Order
OrderItem
Delivery
Favorite
```

Деньги хранятся целыми числами в копейках, вес — целыми граммами.

`Order` и `Delivery` разделены: жизненный цикл заказа не смешивается с состоянием внешнего курьера.

## Каталог и избранное

`GET /api/products` принимает `q`, `category`, `sort`, `page` и `limit` и возвращает объект `{ items, total, page, limit, pages }`. Для получения актуальных гостевых избранных также доступен ограниченный фильтр `ids`.

Серверное избранное защищено пользовательской сессией:

```text
GET    /api/favorites
POST   /api/favorites/:productId
DELETE /api/favorites/:productId
POST   /api/favorites/sync
```

Гостевое избранное хранит в `localStorage` только идентификаторы товаров. После успешного входа они добавляются в серверное избранное; локальные данные очищаются только после успешной синхронизации и повторной загрузки списка.

## Локальный запуск

### Требования

- Node.js `>=24 <25`
- pnpm `11.24+`
- Docker Desktop / Docker Engine

### 1. Установить зависимости

```bash
pnpm install
```

### 2. Запустить PostgreSQL

```bash
docker compose up -d
```

По умолчанию локальная база:

```text
host: 127.0.0.1
port: 5432
database: shop
user: shop
password: shop
```

### 3. Настроить API env

Создать:

```text
apps/api/.env
```

Минимальная конфигурация:

```dotenv
DATABASE_URL=postgresql://shop:shop@127.0.0.1:5432/shop?schema=public
AUTH_SECRET=replace-with-a-long-random-secret
```

### 4. Применить миграции

```bash
cd apps/api
pnpm exec prisma migrate dev
```

При необходимости заполнить dev-данные:

```bash
pnpm exec prisma db seed
```

### 5. Запустить проект

Из корня:

```bash
pnpm dev
```

После запуска:

```text
Frontend  http://127.0.0.1:3000
API       http://127.0.0.1:3001/api
Health    http://127.0.0.1:3001/api/health
```

## Yandex Delivery env

Для настоящей автоматической доставки нужны Yandex Delivery business account и B2B API token.

```dotenv
YANDEX_DELIVERY_ENABLED=true
YANDEX_DELIVERY_TOKEN=
YANDEX_DELIVERY_SOURCE_ADDRESS=
YANDEX_DELIVERY_SOURCE_NAME=
YANDEX_DELIVERY_SOURCE_PHONE=
YANDEX_DELIVERY_SOURCE_EMAIL=

# optional
YANDEX_DELIVERY_SOURCE_LONGITUDE=
YANDEX_DELIVERY_SOURCE_LATITUDE=
YANDEX_DELIVERY_SYNC_INTERVAL_MS=30000
YANDEX_DELIVERY_CALLBACK_URL=https://api.example.com/api/delivery/yandex/callback
```

`YANDEX_DELIVERY_CALLBACK_URL` необязателен. Основная автоматическая синхронизация выполняется backend через `claims/bulk_info`.

Без `YANDEX_DELIVERY_TOKEN` приложение продолжает работать, а сценарий `OTHER` остаётся доступным.

## Основные команды

```bash
# frontend + backend в dev mode
pnpm dev

# production build всех workspace
pnpm build

# TypeScript
pnpm typecheck

# lint
pnpm lint

# API unit tests
pnpm --filter api test

# API e2e
pnpm --filter api test:e2e
```

## Auth

Основной пользовательский вход — телефон + одноразовый код.

- OTP TTL: 5 минут;
- повторный запрос: не чаще одного раза в минуту;
- максимум 5 неверных попыток;
- session TTL: 30 дней;
- session token хранится в HttpOnly cookie;
- production cookie использует `__Host-sid`.

В development API возвращает `devCode`, поэтому SMS-провайдер для локальной разработки не требуется.

## Безопасность заказов

- покупатель не получает доступ к заказу только по числовому ID;
- обычные order routes проверяют ownership;
- guest-заказы привязаны к guest session;
- публичный tracking использует криптографически случайный token;
- `/track/:token` не раскрывает полный адрес и другие лишние персональные данные;
- frontend не может произвольно устанавливать `Order.status`, `Delivery.status`, `actualTotal` или финальные суммы.

## Проверки качества

Перед merge / push рекомендуется выполнять:

```bash
pnpm typecheck
pnpm lint
pnpm --filter api test
pnpm --filter api test:e2e
pnpm build
git diff --check
```

## Текущий статус

Проект находится в активной разработке.

Уже сформирована основа customer → seller → courier flow. Следующие крупные продуктовые блоки: полноценное управление каталогом и остатками, изображения/S3, адресные подсказки, онлайн-оплата, SMS и production deployment.

## Roadmap

Ближайшие направления:

1. Admin catalog: категории, товары, цены, единицы, доступность и сортировка.
2. Остатки и временное отсутствие товаров.
3. Загрузка и хранение изображений в S3-compatible storage.
4. DaData / адресные подсказки и валидация зоны доставки.
5. Онлайн-оплата и корректировка суммы после фактической сборки.
6. SMS-уведомления и отправка tracking URL.
7. Production configuration, deployment, logging и monitoring.
8. CI/CD и автоматические проверки GitHub Actions.

## Repository

https://github.com/MaxiViP/Shop
