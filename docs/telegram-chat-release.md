# Выпуск чатов KorzinaMarket без миграций

Инструкция для уже работающего сервера с конфигурацией из deploy/README.md: checkout /opt/korzinamarket, пользователь shop, systemd shop-api/shop-web, env в /etc/korzinamarket, PostgreSQL в deploy/compose.db.yml. Фактический сервер в этой задаче не обследовался; если пути или сервисы отличаются, сначала сопоставьте их с установленной конфигурацией.

Изменения этой задачи не добавляют Prisma schema, миграций, зависимостей или секретов. Существующие токены, webhook и gateway сохраняются. Не заменяйте установленные systemd units: репозиторный shop-api.service содержит PrivatePIDs/особые mounts с отдельными требованиями к ОС.

deploy/deploy.sh здесь НЕ используется: он требует main, устанавливает units и всегда выполняет prisma migrate deploy.

## 1. Подготовить проверенный код

После push ветки perf/mobile-lighthouse создайте PR в main, проверьте diff и выполните слияние на GitHub. Commit/push ветки не являются слиянием и не публикуют сайт.

Подключитесь к серверу своим обычным SSH-пользователем. Сначала сделайте snapshot сервера средствами хостинга. Затем откройте root shell:

```bash
sudo -i
cd /opt/korzinamarket
as_shop() { runuser -u shop -- env -i HOME=/home/shop PATH=/usr/local/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }
as_shop git status --short --branch
as_shop git branch --show-current
node --version
systemctl is-active shop-api.service shop-web.service
```

Продолжать только с чистым working tree на main, Node 24 и известной конфигурацией работающих сервисов. Локальные изменения на сервере сначала разберите; не используйте reset/stash/clean.

```bash
as_shop git fetch origin main
as_shop git log --oneline HEAD..origin/main
as_shop git diff --stat HEAD origin/main
as_shop git diff --exit-code HEAD origin/main -- apps/api/prisma/schema.prisma apps/api/prisma/migrations
```

Сверьте target с проверенным PR. Если последняя команда показывает изменения схемы/миграций, остановитесь: эта инструкция не разрешает их применение. Если в main есть другие изменения, их нужно оценить отдельно.

## 2. Резервная копия и окно обслуживания

Все дальнейшие команды — в том же root shell. Не включайте set -x, не печатайте env.

```bash
set -euo pipefail
umask 077
exec 9>/run/lock/korzinamarket-deploy.lock
flock -n 9
OLD_SHA=$(as_shop git rev-parse HEAD)
TARGET_SHA=$(as_shop git rev-parse origin/main)
BACKUP=/var/backups/korzinamarket/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$BACKUP"
printf '%s\n' "$OLD_SHA" > "$BACKUP/previous-commit.txt"
printf '%s\n' "$TARGET_SHA" > "$BACKUP/target-commit.txt"
systemctl stop shop-web.service
systemctl stop shop-api.service
tar -czf "$BACKUP/runtime.tgz" apps/api/dist apps/web/.output node_modules apps/api/node_modules apps/web/node_modules pnpm-lock.yaml package.json apps/api/package.json apps/web/package.json
docker compose --env-file /etc/korzinamarket/db.env -f deploy/compose.db.yml exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/database.dump"
test -s "$BACKUP/runtime.tgz"
test -s "$BACKUP/database.dump"
```

Остановка создаёт окно недоступности; запланируйте его заранее. Если любой шаг завершится ошибкой, не продолжайте запуск по частично выполненной инструкции. Резервная копия runtime может быть большой: заранее проверьте место на диске.

## 3. Получить код и собрать

```bash
as_shop git merge --ff-only "$TARGET_SHA"
as_shop pnpm install --frozen-lockfile --prod=false
as_shop /usr/bin/node --env-file=/etc/korzinamarket/api.env apps/api/node_modules/prisma/build/index.js migrate status --config apps/api/prisma7.config.ts
as_shop /usr/bin/node --env-file=/etc/korzinamarket/api.env apps/api/node_modules/prisma/build/index.js generate --no-hints --config apps/api/prisma7.config.ts
as_shop pnpm --filter api build
as_shop pnpm --filter web build
as_shop git status --short
```

migrate status только проверяет состояние БД; generate создаёт локальный клиент. Если status сообщает pending/failed migrations — остановитесь и согласуйте их отдельно. Команд migrate deploy/reset, seed и импорта каталога здесь нет.

## 4. Запустить и проверить

```bash
systemctl restart shop-api.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 --max-time 10 http://127.0.0.1:4001/api/health
systemctl restart shop-web.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 --max-time 10 --head http://127.0.0.1:3000
curl --fail --silent --show-error https://korzinamarket.ru/api/health
curl --fail --silent --show-error --head https://korzinamarket.ru
systemctl is-active shop-api.service shop-web.service
as_shop git log -1 --oneline
```

При ошибке смотрите локально journalctl -u shop-api.service -u shop-web.service --since '10 minutes ago'; не публикуйте секреты/персональные данные из журналов. Затем пройдите ручные сценарии из telegram-chat-experience.md в обоих настоящих ботах. /start или /menu обновит покупательское меню; /start или /work — продавецкое. Новые команды доступны без изменения BotFather; его список команд при желании обновляется отдельно.

## 5. Если нужен откат

При неизменённой схеме и до приёма новых заказов можно вернуть сохранённый runtime. В том же shell:

```bash
systemctl stop shop-web.service
systemctl stop shop-api.service
test -s "$BACKUP/runtime.tgz"
tar -xzf "$BACKUP/runtime.tgz" -C /opt/korzinamarket
systemctl restart shop-api.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 http://127.0.0.1:4001/api/health
systemctl restart shop-web.service
curl --fail --silent --show-error --head http://127.0.0.1:3000
```

Это аварийное восстановление файлов сборки/зависимостей, а не возврат Git: HEAD останется новым. Зафиксируйте факт отката и восстановите согласованное состояние исходников отдельным revert/исправлением через PR. БД автоматически не восстанавливается: после новых заказов восстановление старого дампа потеряет новые данные и требует отдельного решения.

Настоящие команды на сервере в этой задаче не выполнялись.
