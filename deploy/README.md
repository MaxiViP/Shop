# Первый staging deploy: Ubuntu 24.04 / Timeweb Cloud

Исходный application checkpoint: `bd75bef` в `main`. Эти deployment-файлы нужно
отдельно включить в `main` и опубликовать после согласования: один только checkout
`bd75bef` ещё не содержит `deploy/`. Данная preparation-задача не выполняет commit,
push или команды на сервере.

Схема одного сервера:

```text
Internet -> Nginx :443 (korzinamarket.ru)
              /          -> Nuxt SSR 127.0.0.1:3000
              /api/      -> Nest API 127.0.0.1:4001/api/
              /uploads/  -> Nest API 127.0.0.1:4001/uploads/
                               -> PostgreSQL 18.6, Docker, 127.0.0.1:5432
                               -> /var/lib/korzinamarket/uploads/products
```

Приложения работают от `shop`, Node.js 24 установлен системно в `/usr/bin/node`.
NVM для systemd не используется. pnpm берётся из `packageManager` репозитория
(`pnpm@11.24.0`). API запускается как `node apps/api/dist/main.js` — явный ESM
entrypoint текущей сборки; web — готовый Nitro output, без dev/watch/preview.
Root `compose.yml` остаётся development-конфигурацией.

## 1. Сразу после SSH: пакеты и runtime

Команды рассчитаны на свежую Ubuntu 24.04 и SSH-пользователя с `sudo`.

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git nginx ufw build-essential
sudo install -d -m 0755 /etc/apt/keyrings

# Docker Engine и Compose plugin из официального apt repository.
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

# Node.js 24 из NodeSource, системный путь /usr/bin/node.
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' |
  sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null

sudo apt update
sudo apt install -y nodejs docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo npm install --global corepack
sudo corepack enable
sudo systemctl enable --now docker nginx
/usr/bin/node --version
sudo docker compose version
```

Проверить `v24.x`. Версию PostgreSQL не повышать обычным обновлением image tag
через major version: это отдельная процедура миграции данных.

## 2. Firewall и DNS

В firewall Timeweb Cloud разрешить входящие TCP **22, 80, 443**. Внутренние порты
**3000, 4001, 5432 не открывать**. Приложения и Docker bind ограничены loopback;
для Docker это существенно, поскольку опубликованные Docker-порты могут обходить
обычные правила UFW.

Если SSH использует другой порт, сначала разрешить именно его. Сохранить текущую
SSH-сессию и проверить вход второй сессией после включения firewall.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

В DNS создать `A` для `korzinamarket.ru` с публичным IPv4 сервера и `CNAME` для
`www` на `korzinamarket.ru` (либо второй `A`). `AAAA` добавлять только при рабочем
IPv6 с доступными 80/443; устаревший `AAAA` может сломать доступ и выпуск SSL.
Первый deploy рассчитан на прямой доступ Internet -> Nginx, без CDN/другого proxy.

## 3. Пользователь, репозиторий и env-файлы

```bash
id shop >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /home/shop --shell /usr/sbin/nologin shop
sudo install -d -o shop -g shop -m 0755 /opt/korzinamarket
sudo -u shop -H git clone --branch main https://github.com/MaxiViP/Shop.git /opt/korzinamarket
cd /opt/korzinamarket
sudo -u shop -H git status --short
sudo -u shop -H git log -1 --oneline
test -f deploy/deploy.sh

sudo install -d -o root -g shop -m 0750 /etc/korzinamarket
# touch не перезаписывает существующие secrets при повторном выполнении.
sudo touch /etc/korzinamarket/api.env /etc/korzinamarket/web.env /etc/korzinamarket/db.env
sudo chown root:shop /etc/korzinamarket/api.env /etc/korzinamarket/web.env
sudo chmod 0640 /etc/korzinamarket/api.env /etc/korzinamarket/web.env
sudo chown root:root /etc/korzinamarket/db.env
sudo chmod 0600 /etc/korzinamarket/db.env
sudoedit /etc/korzinamarket/db.env
sudoedit /etc/korzinamarket/api.env
sudoedit /etc/korzinamarket/web.env
```

`git clone` выполняется только при первом развёртывании. Для private repository
настроить чтение от имени `shop`, например read-only SSH deploy key и SSH remote;
не записывать access token в URL или README. Последующие deploy требуют clean
working tree на `main` и не переключают ветку.

Ниже шаблоны; пустые обязательные значения заполнить непосредственно на сервере.
Не копировать development `.env`, не помещать production env в репозиторий и не
печатать их через `cat`, `env`, `set -x` или полный вывод Compose config.
Использовать однострочные `NAME=value`; значения с пробелами/`#` заключать в кавычки.
Без `export`, shell-подстановок и ссылок на другие переменные: файлы читают systemd,
Node `--env-file` и Docker Compose, а не `source`.

### `/etc/korzinamarket/db.env`

```dotenv
POSTGRES_DB=shop
POSTGRES_USER=shop
POSTGRES_PASSWORD=
```

Обязателен уникальный длинный пароль. Для первого запуска удобно использовать
случайный hex-пароль из менеджера секретов: он не требует URL-encoding и не
содержит Compose-подстановок `$`. `POSTGRES_*` инициализируют только пустой volume;
редактирование файла не меняет пароль существующей PostgreSQL role.

### `/etc/korzinamarket/api.env`

```dotenv
NODE_ENV=production
PORT=4001
DATABASE_URL=
AUTH_SECRET=
CORS_ORIGINS=https://korzinamarket.ru
TRUST_PROXY=127.0.0.1/32,::1/128
UPLOAD_DIR=/var/lib/korzinamarket/uploads/products

ADMIN_PHONE=
ADMIN_PASSWORD=

PAYMENT_RECIPIENT_NAME=
PAYMENT_PHONE=
PAYMENT_BANK_NAME=
PAYMENT_CARD_NUMBER=
PAYMENT_SBP_LINK=
PAYMENT_QR_IMAGE_URL=

YANDEX_DELIVERY_ENABLED=false
ORDER_SMS_ENABLED=false
ORDER_SITE_URL=https://korzinamarket.ru
```

`DATABASE_URL` имеет вид
`postgresql://<POSTGRES_USER>:<URL_ENCODED_PASSWORD>@127.0.0.1:5432/<POSTGRES_DB>?schema=public`.
Подставить те же DB/user/password, что в `db.env`. Спецсимволы в user/password
кодировать как URL-компоненты, не кодировать весь URL. `AUTH_SECRET` обязателен для
старта API: задать отдельный длинный случайный секрет, не равный паролю БД или ADMIN.

`ADMIN_PHONE` — нормализуемый российский номер, `ADMIN_PASSWORD` — уникальный
длинный пароль. Первый успешный password login создаёт/назначает ADMIN штатным
путём; production seed для этого не нужен. Payment-поля заполнить подходящими
реквизитами перед проверкой оплаты; ссылки принимаются только `https:`. Эти
реквизиты по назначению будут видны покупателю, поэтому не использовать реальные
платёжные реквизиты для нежелательных тестовых переводов.

Для последующей настройки Yandex проект действительно читает следующие имена:

```dotenv
YANDEX_DELIVERY_ENABLED=false
YANDEX_DELIVERY_TOKEN=
YANDEX_DELIVERY_SOURCE_ADDRESS=
YANDEX_DELIVERY_SOURCE_NAME=
YANDEX_DELIVERY_SOURCE_PHONE=
YANDEX_DELIVERY_SOURCE_EMAIL=
YANDEX_DELIVERY_SOURCE_LONGITUDE=
YANDEX_DELIVERY_SOURCE_LATITUDE=
YANDEX_DELIVERY_SYNC_INTERVAL_MS=30000
YANDEX_DELIVERY_CALLBACK_URL=
```

Добавлять их в `api.env` без дублирования существующих ключей. Координаты задаются
парой. Callback необязателен; существующий endpoint:
`https://korzinamarket.ru/api/delivery/yandex/callback`. Основная синхронизация —
polling API. Credentials и включение интеграции требуют отдельной настройки;
этот deploy их не создаёт. Order SMS не является OTP adapter, поэтому оставлен
выключенным. Имена `ORDER_SMS_PROVIDER`, `ORDER_SMS_API_URL`, `ORDER_SMS_API_KEY`,
`ORDER_SMS_SENDER` из текущего `.env.example` сами по себе не добавляют SMS adapter.

### `/etc/korzinamarket/web.env`

```dotenv
NODE_ENV=production
NUXT_PUBLIC_API_BASE=https://korzinamarket.ru/api
NUXT_PUBLIC_SITE_URL=https://korzinamarket.ru
NUXT_PUBLIC_PICKUP_NAME="ТЦ «Багратионовский»"
NUXT_PUBLIC_PICKUP_ADDRESS="ул. Барклая, 10, Москва"
```

Pickup-переменные уже поддерживаются текущим Nuxt runtimeConfig. `NITRO_HOST` и
`NITRO_PORT` заданы в unit как `127.0.0.1` и `3000`; не переопределять их другим
адресом в `web.env`. `NUXT_PUBLIC_*` публичны: никогда не размещать в них secrets.
Systemd читает env при старте процесса; после ручного изменения env нужен restart
соответствующего сервиса. Nuxt production server не загружает repository `.env`.

## 4. База, Nginx и SSL до первого запуска приложения

```bash
cd /opt/korzinamarket
sudo docker compose --env-file /etc/korzinamarket/db.env -f deploy/compose.db.yml config --quiet
sudo docker compose \
  --env-file /etc/korzinamarket/db.env \
  -f deploy/compose.db.yml \
  up -d
sudo docker compose --env-file /etc/korzinamarket/db.env -f deploy/compose.db.yml ps

sudo install -m 0644 deploy/nginx.conf /etc/nginx/sites-available/korzinamarket.conf
sudo ln -sfn /etc/nginx/sites-available/korzinamarket.conf /etc/nginx/sites-enabled/korzinamarket.conf
sudo nginx -t
sudo systemctl reload nginx

# Только после того, как DNS обоих имён указывает на этот сервер, а порт 80 доступен.
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx \
  -d korzinamarket.ru \
  -d www.korzinamarket.ru \
  --redirect
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Дождаться healthy у PostgreSQL. Volume называется **`shop_pgdata`**, mount —
`/var/lib/postgresql`; для image 18.6 фактический PGDATA внутри —
`/var/lib/postgresql/18/docker`. Порт БД опубликован только на `127.0.0.1:5432`.

До SSL Nginx обслуживает обычный HTTP. Certbot добавляет сертификаты и перенаправление
HTTP -> HTTPS; заранее certificate paths не задаются. `www` перенаправляется на
apex, чтобы браузер, cookie и CORS использовали один origin. Первоначальные 502
на `/` до запуска приложений ожидаемы: HTTP challenge Certbot обрабатывает сам
Nginx, запущенные Nuxt/API для выпуска сертификата не нужны.

SSL выпускается **до** `deploy.sh`, потому что Nuxt SSR вызывает API по
`https://korzinamarket.ru/api`, включая запросы при локальной HTTP-проверке SSR.
Проверить, что сервер сам может разрешить этот домен и обратиться к нему.

Nginx передаёт `/api/health` в API именно как `/api/health`: у `proxy_pass` нет
URI и завершающего `/`. `/uploads/products/...` также сохраняет путь. Лимит тела
6 MB покрывает multipart upload изображения до 5 MB. API не кэшируется.

Nginx перезаписывает `X-Forwarded-For` значением `$remote_addr`, а также задаёт
Host, X-Real-IP и X-Forwarded-Proto. Входной XFF не добавляется в цепочку.
Не включать глобальное доверие произвольному `real_ip_header`/`set_real_ip_from`.
H4 остаётся без изменений; trust policy предназначена только для локального Nginx.

**После Certbot не копировать исходный `deploy/nginx.conf` поверх действующего
конфига:** это удалит внесённую TLS-конфигурацию. Последующие изменения переносить
с сохранением HTTPS и проверять `nginx -t` перед reload. `deploy.sh` Nginx не трогает.

## 5. Первый и последующие deploy

```bash
cd /opt/korzinamarket
sudo bash deploy/deploy.sh
sudo systemctl is-active shop-api shop-web
sudo ss -ltnp

curl --fail http://127.0.0.1:4001/api/health
curl --fail -I http://127.0.0.1:3000
curl --fail -I https://korzinamarket.ru
curl --fail https://korzinamarket.ru/api/health
curl -I http://korzinamarket.ru
curl -I https://www.korzinamarket.ru
```

Убедиться: 3000/4001/5432 слушают только loopback, HTTP ведёт на HTTPS, а `www` —
на `https://korzinamarket.ru`. При 502 смотреть `systemctl status shop-api shop-web`
и локально `journalctl -u shop-api -u shop-web`; не публиковать необработанные логи.
`/api/health` — текущая liveness-проверка `{ "ok": true }`, не тест SMS/Yandex или
полноценная проверка БД. Миграции проверяют доступ к БД; каталог и ADMIN проверяются
отдельно в браузере.

Скрипт требует clean `main`, берёт lock от параллельного deploy, делает `fetch` и
`pull --ff-only`; локальные commits вне `origin/main` останавливают deploy.
Git/install/build/Prisma работают от `shop`, systemd и установка файлов — от root.
Secrets читаются Node как env-данные, не исполняются shell и не передаются в argv.

Deploy создаёт uploads directory при отсутствии, устанавливает два systemd unit,
останавливает процессы на время in-place сборки, устанавливает зависимости по
lockfile, генерирует Prisma Client и выполняет build. Затем применяет только
**`prisma migrate deploy --config apps/api/prisma7.config.ts`**. CLI вызывается
через установленный `apps/api/node_modules/prisma/build/index.js`; это эквивалент
workspace-команды с явно загруженным `api.env`. Сейчас цепочка содержит **19
миграций**, включая business settings, delivery attempt и OTP identity. На пустой
БД применится вся цепочка; на существующей — только ожидающие миграции.

После успешных стадий скрипт включает автозапуск, перезапускает API/Web и проверяет
локальные и публичные URL. `migrate dev`, `db push`, Prisma reset и seed не
используются. Build выполняется до миграций, чтобы ошибка сборки не обновляла БД.

Это простой deploy **с окном недоступности**, без атомарного переключения releases.
При ошибке после остановки процессы могут остаться остановленными; не запускать
старый output вслепую поверх уже изменённой schema. Разобрать причину и повторить
deploy; автоматического rollback БД нет. Перед обновлением работающего магазина
сделать backup. Изменения исходников или неожиданные generated files останавливают
скрипт, а не отбрасываются. Root development Compose на сервере не запускать.

## 6. Первый online test и ограничения

**H2 открыт: production OTP SMS adapter отсутствует.** USER/SELLER не получат SMS
для новой OTP-сессии. `NODE_ENV` должен оставаться `production`; включать `devCode`
для обхода этого ограничения нельзя.

Для первого теста доступны storefront, guest checkout, ADMIN password login,
каталог/товары/настройки/корзина и staff fulfillment через роль ADMIN. Войти на
`https://korzinamarket.ru/admin/login`; после штатного первого входа ADMIN настроить
категории, товары, фотографии и реквизиты. Seed и демонстрационные данные не создаются.

Пока реальные Yandex credentials не настроены, **до гостевого тестового заказа**
в Admin Settings вручную установить:

- `deliveryEnabled = false`;
- `pickupEnabled = true`.

Deploy не изменяет эти значения в БД. `YANDEX_DELIVERY_ENABLED=false` отключает
интеграцию, но сам по себе не скрывает способ получения DELIVERY в ShopSettings.
После настройки Yandex сначала проверить реальный booking/recovery отдельно.

Остальные audit findings остаются открытыми: M3 idempotency, M4 Yandex terminal
return/cancel, M5 CSRF, M6 stale order lists, M7 default address race, M8 image
cleanup race, M9 favorites rollback, M10 over-limit extra decrease, M11 history
pagination, LOW L1–L3. Это preparation для ограниченного staging-теста, а не
подтверждение устранения production blockers.

## 7. Persistence и backup

Постоянные данные находятся в Docker volume **`shop_pgdata`** и каталоге
**`/var/lib/korzinamarket/uploads`**. Сохранять оба независимо от `/opt/korzinamarket`.
Обычный deploy не удаляет volume, изображения или существующие заказы.
Перезапуск/recreate контейнера с тем же volume сохраняет БД; удаление сервера требует
заранее вынесенного backup. Не выполнять очистку volumes или uploads как часть deploy.

Пример согласованного backup перед обновлением (короткая остановка записи;
команды ниже выполняются в отдельной root shell):

```bash
sudo -i
umask 077
backup_dir="/var/backups/korzinamarket/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
systemctl stop shop-web shop-api
docker compose --env-file /etc/korzinamarket/db.env \
  -f /opt/korzinamarket/deploy/compose.db.yml exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/database.dump"
tar -C /var/lib/korzinamarket -czf "$backup_dir/uploads.tar.gz" uploads
systemctl start shop-api shop-web
exit
```

Проверить успешное завершение обеих backup-команд, хранить копию вне сервера и
проверить восстановление в отдельном окружении. Secrets из `/etc/korzinamarket`
сохранять отдельно в защищённом хранилище. Резервирование не равно проверенному
disaster recovery; восстановление и расписание backup на сервере ещё нужно настроить.

## 8. Проверка конфигурации

На сервере перед запуском:

```bash
cd /opt/korzinamarket
bash -n deploy/deploy.sh
sudo docker compose --env-file /etc/korzinamarket/db.env -f deploy/compose.db.yml config --quiet
sudo systemd-analyze verify deploy/shop-api.service deploy/shop-web.service
sudo nginx -t
```

`systemd-analyze` предполагает установленный Node, пользователя и существующие
пути сборки/storage. На Windows доступны Compose validation, Bash syntax check и
статическая проверка units/Nginx; она не заменяет runtime-проверки Ubuntu, DNS,
TLS, firewall и реального доступа к серверу.

Основания для инфраструктурных настроек:
[Docker на Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
[PostgreSQL Docker image / PGDATA 18](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata),
[Nuxt Node server](https://nuxt.com/docs/4.x/getting-started/deployment#nodejs-server),
[NodeSource Node.js packages](https://github.com/nodesource/distributions/blob/master/DEV_README.md).
