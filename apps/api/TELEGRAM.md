# Telegram: уведомления о новых заказах (этап 1)

## Поток
OrderCtrl → OrderService: текущие quote, limits, guest, цены → успешный Prisma order.create с nested items → void TelegramService.notifyNewOrder(id).
TelegramService читает сохранённые поля заказа через DbService и отправляет каждому настроенному получателю отдельный POST sendMessage.
OrderModule импортирует TelegramModule; TelegramModule импортирует только DbModule и экспортирует TelegramService. Цикла с OrderModule нет.
Существующий SMS NotificationService не меняется. Новых HTTP endpoints нет.

## Конфигурация
Переменные backend:
- TELEGRAM_BOT_TOKEN — секрет бота; только env, не git/логи/клиент/БД.
- TELEGRAM_ADMIN_CHAT_IDS — целочисленные chat IDs через запятую. Допускаются отрицательные group IDs; пробелы/пустые элементы убираются, дубликаты объединяются, некорректные значения игнорируются.
- ORDER_SITE_URL — существующая переменная NotificationService, HTTPS origin магазина. Для production: https://korzinamarket.ru.

Если token отсутствует или после проверки нет ни одного chat ID, Telegram выключен: нет чтения заказа для уведомления и нет сетевого вызова.
При неправильном/отсутствующем ORDER_SITE_URL сообщение отправляется без кнопки; лог просит проверить конфигурацию. Credentials в URL запрещены.

## Production configuration — выполняет владелец отдельно
1. Создать/выбрать бота через BotFather. Секрет сохранить вне репозитория.
2. Каждый личный получатель должен открыть бота и нажать Start. Для группы добавить бота с правом отправлять сообщения. Проверить реальные chat IDs разрешённым административным способом; не добавлять production polling.
3. На сервере отредактировать существующий /etc/korzinamarket/api.env, сохранив его остальные переменные и ограниченные права доступа:
   - TELEGRAM_BOT_TOKEN — значение секрета, не копировать в отчёты/команды с выводом;
   - TELEGRAM_ADMIN_CHAT_IDS — проверенные IDs через запятую;
   - проверить существующее ORDER_SITE_URL=https://korzinamarket.ru, не добавлять вторую SITE_URL.
4. После отдельного согласованного выпуска backend применить env перезапуском shop-api.service по принятой процедуре. Этот этап реализации не выполняет deploy/restart/SSH.
5. Создать согласованный тестовый заказ на сайте. Проверить обычный ответ checkout, сообщение каждому получателю и кнопку «Открыть заказ». Кнопка ведёт на /staff/orders/{id}; доступ по-прежнему требует штатную авторизацию ADMIN/SELLER.
6. При сбое проверить локально настройки и минимальный warning в journal. Не публиковать env, token, provider response или полный Telegram request URL. Для отключения убрать token или очистить IDs и отдельно применить env.

## Формат и ограничения
Plain text, без parse_mode. Пользовательские <>&_*[] не интерпретируются как разметка.
Сообщение содержит номер заказа, имя/телефон, delivery/pickup, адрес только DELIVERY, имеющиеся детали адреса, желаемое время (Москва), позиции с qty/unit и сохранёнными суммами, subtotal/deliveryPrice/total, комментарий.
GRAM: 500 г / 1 кг / 1,5 кг; PIECE: шт.; PACK: уп.; BUNCH: пучок/пучка/пучков. Деньги из копеек форматируются ru-RU, цены не пересчитываются.
Для null deliveryPrice — «рассчитывается», null total — «уточняется». Pickup address не копируется из frontend.
Текст ограничен 4000 UTF-16 units, ниже лимита Telegram 4096; длинные поля обрезаются без разрыва surrogate pair, оставшиеся позиции обозначаются «…и ещё N позиций». Суммы и комментарий сохраняют зарезервированное место.
Telegram API: https://core.telegram.org/bots/api#sendmessage (официальная документация проверена при реализации).

Запросы имеют timeout 7 секунд, запрещают redirect, выключают link preview. Каждый recipient независим. HTTP/API/JSON/network/timeout и DB ошибки перехватываются; лог содержит только order ID или предупреждение конфигурации, без caught error.
OrderService не ожидает отправку. Перезапуск процесса может потерять in-flight уведомление: это best-effort, без durable queue, гарантий доставки, retries или exactly-once. Повторный ручной вызов метода может отправить повторное сообщение.

## Tests
Unit tests используют mock fetch и mock DB, никогда реальный Telegram. Token для теста создаётся случайно в памяти.
Покрыты disabled config, несколько получателей, ошибки одного получателя, отсутствие утечки секрета, timeout, plain text, размеры, все units, PICKUP/DELIVERY, nullable суммы, optional fields, post-save dispatch, отсутствие dispatch при DB write failure, guest checkout и отсутствие ожидания Telegram.
Команды: pnpm --filter api lint; pnpm --filter api typecheck; pnpm --filter api test; pnpm build; git diff --check.

## Bot v2
Отдельно проектировать durable outbox/retries/idempotency при требовании гарантированной доставки; webhook с проверкой secret; callback_query и разрешения STAFF; linking аккаунтов; Mini App.
Сейчас нет webhook/polling, callback mutations, login/linking, платежей, TelegramIdentity, Prisma migration или frontend изменений.
