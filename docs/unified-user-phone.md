# Единый телефон пользователя

База изменений: `6bb6bc33cf354b11e34a8a8cce16d3ba11aadb03`.
Ветка: `codex/unified-user-phone`.

`User.phone` является основным телефоном для входа, профиля, поиска в админке
и контакта заказа по умолчанию. `verifiedAt` показывает подтверждение этого номера.
Дополнительные номера `OrderPhone` и явно выбранный `User.orderPhone` остаются
отдельными контактами заказа и не предоставляют права входа.

## Привязка и конфликты

- Telegram OIDC записывает основной номер только из свежего ID Token после
  существующих проверок подписи RS256/JWKS, issuer, audience/azp, state, nonce,
  exp/iat/nbf, профиля и одноразового использования flow. Обязательны
  `phone_number` и строгое `phone_number_verified === true`.
- Номер нормализуется существующим российским нормализатором. Неподдерживаемый
  номер не становится основным; вход через Telegram остаётся доступным.
- Повторный вход находит пользователя по Telegram identity. Существующий
  основной номер и дата его подтверждения сохраняются. Новый подтверждённый
  Telegram-номер может обновить метаданные Telegram, но не заменяет другой
  основной номер пользователя.
- Занятый номер вызывает `ACCOUNT_LINK_REQUIRED`: автоматического объединения
  пользователей или переноса заказов, корзин, адресов и сессий нет.
  OIDC callback показывает понятную ошибку через фиксированную страницу
  `/telegram?error=phone-conflict`, без идентификаторов аккаунтов в URL.
- Для привязки используются транзакция, общие с SMS advisory locks по номеру
  (`704002`) и пользователю (`704004`), блокировка строки User и существующий
  уникальный индекс `User.phone`. Ошибка откатывает также identity, replay и сессию.
  Блокировка User согласована с административной сменой ролей.
- Основной номер администратора и роль ADMIN не получают обхода парольного входа.
  Роль SELLER и права владельцев точек не меняются.

## Существующие Telegram-only пользователи, включая ID 10

Массового backfill и миграции данных нет. Сохранённое `phoneVerified = true`
нельзя считать доказательством OIDC: существующий код бота также записывает
этот флаг. Mini App initData и профиль не подтверждают владение телефоном.
Обработка контактов бота не расширялась; её метаданные не повышаются до User.phone.

После установки этой версии пользователь должен открыть существующий профиль
и выбрать подтверждение основного номера:

1. Повторный OIDC-вход тем же Telegram-аккаунтом с разрешением доступа к номеру;
   либо существующее SMS-подтверждение свободного номера в текущей сессии.
2. Номер и `verifiedAt` сохраняются в том же User. Для пользователя ID 10 не
   создаётся отдельный аккаунт и не требуется изменение рабочей БД вручную.
3. Если номер уже занят, операция откатывается. Следует использовать существующий
   аккаунт или отдельный процесс восстановления; этот патч не реализует слияние.

Форма профиля не использует TEST_PHONE для подтверждения и не отправляет
демонстрационный OTP на вход: такой код не доказывает владение номером.
Обычные SMS/OTP, HttpOnly cookie, CSRF, Mini App и OIDC guards сохраняются.

## Отображение и оформление заказа

- Профиль показывает основной номер и его статус, при необходимости предлагает
  SMS или новый OIDC. Telegram-метаданные показываются отдельно при отсутствии
  основного номера и не получают статус подтверждённого основного номера.
- Список и карточка пользователя в админке показывают основной номер. При его
  отсутствии доступен номер Telegram с сохранённым `phoneVerified`, с явной
  пометкой источника и отсутствия подтверждённого основного номера.
- Поиск поддерживает форматированный номер, локальное `8` и фрагменты номера,
  а также Telegram fallback у пользователей без основного номера.
- Web и бот используют основной номер по умолчанию. Telegram-метаданные больше
  не становятся контактом автоматически. Их можно выбрать как отдельный контакт.
- Сохранённый выбор `User.orderPhone`, выбор дополнительного `OrderPhone` и
  вручную введённый телефон получателя сохраняют приоритет. Обновление профиля
  не перезаписывает явно отредактированный номер в форме заказа.

## Изменённые файлы

Backend:

- `apps/api/src/auth/telegram-auth.service.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/telegram-init-data.ts`
- `apps/api/src/auth/telegram-auth.ctrl.ts`
- `apps/api/src/auth/telegram-oidc.service.ts`
- `apps/api/src/admin/users.service.ts`
- `apps/api/src/order-phone/order-phone.service.ts`
- `apps/api/src/telegram/customer-checkout.service.ts`

Frontend:

- `apps/web/app/components/auth/PhoneVerification.vue`
- `apps/web/app/components/auth/ProfileCard.vue`
- `apps/web/app/components/auth/OrderPhones.vue`
- `apps/web/app/components/admin/UserDetail.vue`
- `apps/web/app/pages/profile.vue`
- `apps/web/app/pages/admin/users.vue`
- `apps/web/app/pages/cart.vue`
- `apps/web/app/pages/telegram.vue`
- `apps/web/app/types/admin.ts`
- `apps/web/app/utils/checkout-recipient.ts`

Тесты:

- `apps/api/src/auth/telegram-auth.ctrl.spec.ts`
- `apps/api/src/telegram/customer-checkout.service.spec.ts`
- `apps/api/test/telegram-auth.e2e-spec.ts`
- `apps/web/test/admin-phone.test.mjs`
- `apps/web/test/phone-verification.test.mjs`
- `apps/web/test/profile.test.mjs`
- `apps/web/test/checkout.test.mjs`
- `apps/web/test/order-phones.test.mjs`
- `apps/web/test/telegram-auth.test.mjs`

Prisma schema и миграции не менялись: нужные поля и уникальные ограничения уже
существуют. Проверены существующие миграции, клиент Prisma сгенерирован локально.

## Проверки

- Профильные backend unit-тесты: **285 passed**, 12 файлов
  (`src/auth`, административные права и Telegram checkout).
- Профильные HTTP/PostgreSQL-тесты: **102 passed** суммарно в пяти наборах:
  Telegram auth, OrderPhone, auth method, staff flow, delegated ADMIN.
  Финальный повтор Telegram auth + OrderPhone: **37 passed**.
- `pnpm typecheck`: успешно для всего монорепозитория; после финальной правки
  backend повторно прошёл его typecheck.
- `pnpm lint`: успешно для всех приложений после финальных изменений.
- `pnpm build`: production build API, web и telegram-gateway успешен;
  после финальной правки API также пересобран отдельно.
- Prisma `validate` и `generate`: успешно, schema не изменялась.
- Полный `pnpm test`: **2590 passed**, без падений:
  API — 2037 passed / 23 skipped в 102 файлах, gateway — 90 passed,
  frontend — 463 passed. Пропуски определены условиями существующих тестов;
  профильные интеграционные тесты выше прошли без пропусков.

Первый полный прогон внутри песочницы Windows столкнулся с запретами junction
и localhost. Контрольные три файловых теста прошли вне песочницы, после чего
полный прогон с локальными разрешениями также прошёл. Nuxt build завершён, несмотря на недоступные
в песочнице каталоги внешних шрифтов и предупреждения зависимостей.

Все PostgreSQL-тесты используют отдельный контейнер на `127.0.0.1:55434`,
временные тестовые БД и случайные изолированные схемы. Production, рабочая БД,
конфигурация сервера, reset и seed не использовались. Временный тестовый контейнер
удалён после проверок. Деплой не выполнялся.
