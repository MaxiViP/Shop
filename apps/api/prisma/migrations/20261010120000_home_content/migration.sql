-- Additive migration. Existing order money, products and image files are preserved.
ALTER TABLE "ShopSettings"
  ADD COLUMN "freeDeliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "freeDeliveryThreshold" INTEGER;
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_free_delivery_check" CHECK (
  ("freeDeliveryThreshold" IS NULL OR "freeDeliveryThreshold" BETWEEN 1 AND 100000000)
  AND (NOT "freeDeliveryEnabled" OR "freeDeliveryThreshold" IS NOT NULL)
);

ALTER TABLE "Order"
  ADD COLUMN "freeDeliveryApplied" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "freeDeliveryThresholdSnapshot" INTEGER;
ALTER TABLE "Order" ADD CONSTRAINT "Order_free_delivery_check" CHECK (
  ("freeDeliveryThresholdSnapshot" IS NULL OR "freeDeliveryThresholdSnapshot" BETWEEN 1 AND 100000000)
  AND (NOT "freeDeliveryApplied" OR (type = 'DELIVERY' AND "freeDeliveryThresholdSnapshot" IS NOT NULL))
);

ALTER TABLE "Product"
  ADD COLUMN "isSeasonal" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isHit" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "seasonalStartsAt" TIMESTAMP(3),
  ADD COLUMN "seasonalEndsAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD CONSTRAINT "Product_season_period_check" CHECK (
  "seasonalStartsAt" IS NULL OR "seasonalEndsAt" IS NULL OR "seasonalEndsAt" > "seasonalStartsAt"
);
CREATE INDEX "Product_active_isSeasonal_idx" ON "Product" (active, "isSeasonal");
CREATE INDEX "Product_active_isHit_idx" ON "Product" (active, "isHit");

CREATE TYPE "HomeSlideType" AS ENUM ('PERMANENT', 'TEMPORARY');
CREATE TYPE "HomeSlideContent" AS ENUM ('CUSTOM', 'FREE_DELIVERY', 'SEASONAL', 'HITS');
CREATE TABLE "HomeSlide" (
  id SERIAL PRIMARY KEY,
  key VARCHAR(80),
  type "HomeSlideType" NOT NULL DEFAULT 'PERMANENT',
  content "HomeSlideContent" NOT NULL DEFAULT 'CUSTOM',
  title VARCHAR(140) NOT NULL,
  text VARCHAR(420) NOT NULL,
  eyebrow VARCHAR(60),
  "buttonLabel" VARCHAR(50),
  "to" VARCHAR(2000),
  image VARCHAR(300),
  position VARCHAR(30) NOT NULL DEFAULT 'center',
  active BOOLEAN NOT NULL DEFAULT true,
  published BOOLEAN NOT NULL DEFAULT false,
  priority BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HomeSlide_period_check" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt"),
  CONSTRAINT "HomeSlide_temporary_check" CHECK (NOT published OR type <> 'TEMPORARY' OR "endsAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "HomeSlide_key_key" ON "HomeSlide" (key);
CREATE INDEX "HomeSlide_published_active_sortOrder_idx" ON "HomeSlide" (published, active, "sortOrder");
-- A database invariant backs the serialized ADMIN publication operation.
CREATE UNIQUE INDEX "HomeSlide_one_priority" ON "HomeSlide" (priority) WHERE priority AND published;

-- Preserve the four existing slides, including the uncommitted customer wording.
-- Stable keys make initialization repeatable without overwriting ADMIN edits.
INSERT INTO "HomeSlide" (key, title, text, eyebrow, "buttonLabel", "to", image, published, "sortOrder", "updatedAt")
SELECT 'legacy-hero-' || n,
  E'Не просто доставка.\nАутентичный поход на рынок — без потери времени.',
  'Продавец показывает продукты прямо с прилавка, а вы выбираете именно то, что хотите — по фото и в прямом чате заказа.',
  label, button, '/catalog', '/images/hero/hero-' || n || '.webp', true, n, CURRENT_TIMESTAMP
FROM (VALUES (0, 'Москва', 'В каталог'), (1, 'Прилавки рынка', 'Смотреть каталог'),
  (2, 'Покупки на рынке', 'Выбрать продукты'), (3, 'Рынок рядом', 'Перейти в каталог')) AS legacy(n, label, button)
ON CONFLICT (key) DO NOTHING;

-- Recommendations are drafts. No new advertising is automatically published.
INSERT INTO "HomeSlide" (key, content, title, text, eyebrow, "buttonLabel", "to", image, "sortOrder", "updatedAt") VALUES
  ('recommended-market', 'CUSTOM', 'Продукты с настоящего рынка',
   'Выбирайте продукты из разных торговых лавок в одном каталоге. Оформите заказ через KorzinaMarket и уточняйте выбор в чате заказа.',
   'Прилавки рынка', 'Выбрать продукты', '/catalog', '/images/hero/hero-0.webp', 4, CURRENT_TIMESTAMP),
  ('recommended-delivery', 'CUSTOM', 'Как работает доставка',
   'Выберите доставку в корзине и укажите адрес. Стоимость уточняется по актуальному расчёту перевозчика после сборки заказа.',
   'По Москве', 'Условия доставки', '/delivery', '/images/hero/hero-1.webp', 5, CURRENT_TIMESTAMP),
  ('recommended-free-delivery', 'FREE_DELIVERY', 'Бесплатная доставка от {threshold}',
   'Добавьте товары на нужную сумму. Условие бесплатной доставки проверяется при оформлении и сохраняется в вашем заказе.',
   'Доставка', 'Выбрать продукты', '/catalog', '/images/hero/hero-1.webp', 6, CURRENT_TIMESTAMP),
  ('recommended-preorder', 'CUSTOM', 'Закажите заранее',
   'Выберите доступное время подготовки в корзине. Мы начнём сборку к выбранному времени с учётом графика работы рынка.',
   'Заказ ко времени', 'Как это работает', '/how-it-works', '/images/hero/hero-2.webp', 7, CURRENT_TIMESTAMP),
  ('recommended-pickup', 'CUSTOM', 'Самовывоз с рынка',
   'Выберите самовывоз в корзине и заберите собранный заказ с рынка. Адрес точки самовывоза указан при оформлении.',
   'Покупки на рынке', 'Перейти в каталог', '/catalog', '/images/hero/hero-3.webp', 8, CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;
