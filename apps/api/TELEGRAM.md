# Telegram Bot v1/v2 — KorzinaMarket

## Архитектура
Bot v1 сохранён: OrderCtrl → OrderService → успешное сохранение Order/items → неблокирующий TelegramService.notifyNewOrder(id). Plain text, реальные qty/unit и суммы из БД, несколько получателей, максимум 4000 UTF-16 units, timeout sendMessage 7 секунд. Нет новых зависимостей или Prisma migration. Перезапуск процесса может потерять in-flight notification: durable queue/retries по-прежнему отсутствуют.

Bot v2: POST /api/telegram/webhook → TelegramWebhookGuard → TelegramUpdateService → существующий StaffService.confirm/startAssembly → повторное чтение текущего status → answerCallbackQuery + editMessageReplyMarkup.
AppModule импортирует отдельный TelegramWebhookModule. Он импортирует StaffModule, TelegramModule и DbModule. TelegramModule не импортирует StaffModule: цикла Order → Telegram → Staff → Order нет.
OrderService, StaffService, cancellation/payment/assembly business rules не переписываются.

## Env
В /etc/korzinamarket/api.env:
- TELEGRAM_BOT_TOKEN: существующий секрет бота.
- TELEGRAM_ADMIN_CHAT_IDS: comma-separated chat/user IDs; числа нормализуются, некорректные пропускаются, дубликаты удаляются.
- TELEGRAM_WEBHOOK_SECRET: отдельный случайный секрет (рекомендуется минимум 32 символа; Telegram допускает 1–256 символов A-Z/a-z/0-9/_/-).
- ORDER_SITE_URL=https://korzinamarket.ru: существующий source of truth для staff URL.

Секреты никогда не добавлять в git, frontend, логи или отчёты. Env применяется после отдельного штатного перезапуска API.
Без token или IDs Bot v1 отключён. Без webhook secret Bot v1 продолжает отправлять уведомления с URL-кнопкой; callback buttons не добавляются.
Наличие secret включает callback buttons, но НЕ регистрирует webhook автоматически: setWebhook выполняет владелец отдельно.
Без корректного HTTPS ORDER_SITE_URL уведомление остаётся, но URL-кнопки нет; credentials в URL не допускаются.

## Авторизация / security model
Webhook требует X-Telegram-Bot-Api-Secret-Token; отсутствующий, неверный или ненастроенный secret → 403 до обработки body. SHA-256 digests сравниваются timingSafeEqual. Исходные значения не выводятся.
После secret проверяются callback_query.from.id и message.chat.id:
- private: оба ID равны и включены в TELEGRAM_ADMIN_CHAT_IDS;
- group/supergroup: положительный user ID и отрицательный group ID должны ОБА быть в allowlist;
- group ID сам по себе не даёт участникам группы права управления;
- неразрешённый actor получает «Нет доступа», без чтения заказа;
- inline-mode/inaccessible message, bot actors и повреждённые callbacks не принимаются.

Это ограниченный доверенный Telegram staff allowlist с доступом ко всем заказам, как текущий staff интерфейс. Это НЕ account linking и не связь с User table. Telegram allowlist не отзывается автоматически при смене роли сотрудника в БД: владелец обязан отдельно удалить Telegram ID и применить env. Компрометация webhook secret позволяет подделать Telegram update; хранить его отдельно от bot token.

Callback format: order:<positive Postgres Int id>:<whitelisted action>, строго ASCII до лимита Telegram 64 bytes. Role/userId в callback_data/body не используются. Методы StaffService выбираются явным switch; произвольный relay/URL/action endpoint отсутствует.
Authorized staff может управлять любым заказом, но ID никогда не даёт доступ неразрешённому actor. Из callback не строится URL: ссылка только из ORDER_SITE_URL.

## Кнопки и статусы
- NEW: «Подтвердить» + «Открыть заказ».
- CONFIRMED: «Начать сборку» + «Открыть заказ».
- ASSEMBLING/READY/DELIVERING/COMPLETED/CANCELED: только «Открыть заказ».
- После обработки callback текущий status указан в тексте URL-кнопки. Тело исходного уведомления не переформатируется.
- Обновляется нажатое сообщение; копии у других получателей обновятся при следующем callback. Внешние изменения с сайта автоматически в Telegram не транслируются.
- Read-only refresh callback поддержан обработчиком; отдельная кнопка refresh не добавлена.

Статус читается из DB; предварительная проверка UX не заменяет транзакцию/row lock StaffService. Повторный confirm возвращает «Статус заказа уже изменился». При конкурентных confirm допустимы два success ACK, но существующая idempotent business operation меняет статус только один раз. Concurrent assembly также защищена существующей проверкой под блокировкой.
Отдельного Telegram состояния заказа или долговременного update_id cache нет. Replay не обходят staff transitions; exactly-once и вечная дедупликация обновлений не заявляются.

## Почему отмена остаётся на сайте
StaffCtrl.cancel передаёт реальный User.id/role. cancellation audit сохраняет canceledById, роль и автора системного сообщения. Nullable canceledById в схеме не является разрешением лишить новый staff action автора.
Без Telegram↔User mapping нельзя корректно записать actor. Поэтому callback-кнопка отмены НЕ добавлена. Любой cancel_request/cancel_confirm/cancel_back только отвечает «Отмена доступна на сайте», не вызывает StaffService.cancel и не меняет заказ. Ни userId=1, ни «первый ADMIN», ни фиктивный User не используются.
После linking можно добавить обязательное двухшаговое подтверждение отмены с реальным actor; сейчас использовать «Открыть заказ».

## Ответы / ошибки
Каждый callback с пригодным id получает попытку answerCallbackQuery: success, conflict, нет доступа, некорректная кнопка или общая ошибка. Для update без callback id ответить Telegram технически невозможно.
Другие updates игнорируются с HTTP 200.
Обработанные callbacks возвращают 200. Неожиданная DB/programming error вызывает безопасный HTTP 500 после попытки ACK, чтобы ошибка была заметна и Telegram мог retry; исходный error не логируется/не возвращается.
ACK/edit timeout 3 секунды каждый, выполняются параллельно. Provider failures полностью изолированы: уже сохранённый статус не откатывается. Нельзя гарантировать исчезновение spinner при недоступном Telegram API. После сбоя UI восстанавливается следующей обработкой кнопки.
Логи содержат только статические сообщения/номер заказа, без token/secret/chat IDs/телефона/адреса/provider response. Redirect запросов к Telegram запрещён.

## Production — только ручные шаги после отдельного выпуска
1. Сохранить отдельный webhook secret в /etc/korzinamarket/api.env, не заменяя существующие env. Проверить allowlist и ORDER_SITE_URL.
2. Отдельно выпустить backend и применить env штатным перезапуском shop-api.service.
3. Проверить, что существующий proxy /api пропускает POST /api/telegram/webhook: без secret ожидается 403. Nginx менять не требуется, если общий /api proxy уже настроен.
4. В доверенной shell без set -x загрузить token и webhook secret в environment безопасным способом (например read -r -s, затем export). Не вставлять literal secret в историю shell.
5. Выполнить setWebhook вручную командой ниже. Startup приложения не вызывает setWebhook.
6. Проверить getWebhookInfo, затем согласованный тестовый заказ: confirm → assembly и повторное нажатие, URL → штатная staff авторизация.
7. Для отключения webhook выполнить deleteWebhook; убрать TELEGRAM_WEBHOOK_SECRET и отдельно применить env, чтобы новые сообщения снова имели только URL button. Bot v1 остаётся рабочим.

Ниже Bash + Python 3 + curl. URL с bot token и JSON secret передаются curl через stdin config, не через argv. Не включать shell tracing, curl verbose/trace и не публиковать provider output.

```bash
telegram_webhook() {
  case "$1" in setWebhook|getWebhookInfo|deleteWebhook) ;; *) return 2 ;; esac
  TELEGRAM_METHOD="$1" python3 - <<'PY' | curl --config -
import json, os
method = os.environ["TELEGRAM_METHOD"]
payload = {}
if method == "setWebhook":
    payload = {
        "url": "https://korzinamarket.ru/api/telegram/webhook",
        "secret_token": os.environ["TELEGRAM_WEBHOOK_SECRET"],
        "allowed_updates": ["callback_query"],
    }
elif method == "deleteWebhook":
    payload = {"drop_pending_updates": False}
url = "https://api.telegram.org/bot" + os.environ["TELEGRAM_BOT_TOKEN"] + "/" + method
print("url = " + json.dumps(url))
print('request = "POST"')
print('header = "Content-Type: application/json"')
print("data = " + json.dumps(json.dumps(payload)))
print("silent")
print("show-error")
print("fail")
print("connect-timeout = 5")
print("max-time = 15")
PY
}

telegram_webhook setWebhook
telegram_webhook getWebhookInfo
# Только когда действительно нужно отключить webhook:
# telegram_webhook deleteWebhook
```

После работы очистить секретные shell env: unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET. Никакие приведённые команды не запускались против production при разработке.

## Проверки и следующие этапы
Unit/локальные HTTP tests используют mock fetch/DB; real Telegram не вызывается. Проверяются secret gate, allowlist actor/chat, malformed actions, status guards, reuse StaffService, double-click/row-lock поведение, ACK/edit failure, отсутствие утечек, отказ от отмены без actor и сохранность v1.
Команды: pnpm --filter api lint; pnpm --filter api typecheck; pnpm --filter api test; pnpm build; git diff --check.
Следующие этапы: явный Telegram account linking, audit actor, двухшаговая отмена, durable outbox/retries, webhook replay persistence при необходимости, Mini App. Prisma migration/TelegramIdentity сейчас нет.

Официальный API: https://core.telegram.org/bots/api#setwebhook , https://core.telegram.org/bots/api#callbackquery , https://core.telegram.org/bots/api#answercallbackquery .
