# Image pipeline: финальное ревью и Linux CI

2026-10-15. Проверены все шесть коммитов от `f46137b` до `157b987` относительно
полученной с GitHub `origin/main` (`238710e`). Рабочее дерево перед ревью было
чистым. Implementation подготовлена в отдельной ветке
`feat/product-image-pipeline-linux-ci`; ветки Draft PR #5, #6 и #7 не изменяются.

## Результаты ревью

Новых подтверждённых дефектов runtime поверх `157b987` не выявлено. Изменения
этого ревью ограничены Linux workflow, дополнительными POSIX-тестами и этим
документом. Измерительный assertion `57 !== 48` разобран в
[отчёте A/B](product-image-performance.md#причина-57--48): это область подсчёта
теста, не дубли товарных HTTP-загрузок.

| Область | Проверенные гарантии и границы |
| --- | --- |
| Пути и symlinks | Канонические UUID/variant URL, запрет traversal/aliases, disjoint roots, `lstat`/`realpath`, pinning root inode/device и fd identity. На Linux реальные `O_NOFOLLOW`/`O_NONBLOCK`; это не sandbox против враждебной подмены родительских директорий. |
| Atomic/no-clobber | Приватный staging с `O_EXCL`, file fsync, полная проверка bytes/hash/decode; публикация через native hard link. `EEXIST` требует проверки победителя; copy/overwrite fallback отсутствует. |
| Оригиналы | Открываются только для чтения, хеш/mtime/inode контролируются тестами. Конфликтные варианты сохраняются и получают отдельный checksum repair URL. |
| READY | Строгая версия и profile, полный набор 192/384/640, source hash/fingerprint, actual dimensions, bytes и hashes. READY заменяется последним, под owned lock, после повторной проверки source и кандидатов. |
| Сбои и resume | Частичные выходы не означают READY; повтор использует правильные файлы без перезаписи. Журнал не заменяет верификацию файлов. Writable journal обязан иметь один hard link. Чужие/неизвестные locks не удаляются по PID или возрасту. |
| Flags и fallback | Оба флага default off, независимы. Отключённый registry не читает storage; legacy JSON сохраняется. Негодные metadata дают оригинал, ошибка variant — original retry, затем placeholder; HTTP stale variant — `307 no-store` только к безопасному оригиналу. |
| API и бизнес-логика | Enrichment вызывается после service/DB transaction только для products/detail/favorites. Цены, количества, скидки, cart/quote/order расчёты, авторизация, роли и пагинация не менялись. Изменений Prisma schema, миграций и deployment-конфигурации нет. |

Проанализированы generator/storage/CLI/registry/HTTP и frontend diff, а также
регрессии бизнес-контрактов. API HTTP-тесты используют настоящий Nest и сервисы
с mocked DB; это не подтверждение PostgreSQL E2E. Обычная legacy static-раздача
оригиналов сохранена: доверенные owners/ACL и отсутствие посторонних writers
в roots/ancestors остаются обязательной предпосылкой всего pipeline.

## Влияние registry на ответ API

При включённом флаге controller ожидает enrichment, поэтому файловые проверки
добавляются к времени ответа после завершения DB transaction. Cold lookup читает
до пяти файлов на уникальное фото: manifest, оригинал и три кандидата, проверяя
хеши и заголовки без Sharp decode/генерации. Positive cache hit проверяет stat
подписи, без чтения тел; concurrent дубли объединяются. Тесты подтверждают пять
body opens для cold lookup, ноль для hot lookup и максимум четыре одновременных
I/O-операции.

Есть лимиты pending/очереди, размера файлов и LRU (10 000 записей/16 MiB учёта),
TTL 30/5 секунд и деградация к legacy при отказах. Это ограничивает ресурсы, но
не устанавливает hard deadline на filesystem I/O или SLA времени ответа.
Перед включением нужны cold/warm p50/p95/p99 на целевом mount, с реальными
размерами каталога и конкуренцией API/variant requests. Такие production-замеры
в этом ревью не выполнялись. Сохранённая A/B серия не изолирует стоимость registry.

## Отдельный Linux workflow

[image-pipeline.yml](../../.github/workflows/image-pipeline.yml) запускается на
релевантных pull requests, push в main и вручную. Runner — `ubuntu-24.04`,
Node 24, pnpm 11.24.0; действия закреплены полными официальными SHA.
Используются `contents: read`, `persist-credentials: false`, отмена устаревших
запусков и жёсткий timeout job 15 минут, install/tests — по 5 минут.

Для всех fixtures/encoder children создаётся отдельный temp root с mode 0700,
передаваемый через TMPDIR/TMP/TEMP. Нет DB service, VPS, deployment environment
или пользовательских секретов. Dummy loopback URL на закрытом порту 1 задаётся
только для `prisma generate`, который генерирует типы без подключения к БД.
Миграции, seed, production backfill, Lighthouse и браузерные серии не запускаются.

Workflow выполняет typecheck/lint, image/backend compatibility tests, frontend
unit-тесты и production builds с выключенными флагами. JSON-отчёт Vitest должен
содержать ноль failed/skipped/todo и все 13 native Linux cases в состоянии passed.
Пропуски Windows не могут стать зелёным Linux результатом. Отчёт сохраняется
как CI artifact на семь дней. Результат конкретного Linux запуска фиксируется
в отдельном Draft PR; наличие workflow само по себе не означает успешный CI.

Добавлены четыре Linux-only случая в `image-storage.spec.ts`:

- Подмена обычного файла на symlink после `lstat`: ожидается настоящий kernel
  `ELOOP` от `O_NOFOLLOW`, а не только обнаружение symlink предварительной проверкой.
- Два режима private root, 0755 и 0770: отказ до encoder и любых записей.
- Ошибка native directory `sync()` после успешного hard link: отказ без READY,
  сохранение оригинала, последующее восстановление без clobber уже опубликованного
  inode. Ошибка fsync не игнорируется как на Windows.

Существующие native symlink, hardlink/no-clobber, single-link journal, permissions,
partial publication и recovery проверки также входят в job. Linux платформу и
POSIX flags не подменяют. CI на одном ephemeral mount не сертифицирует другой FS.

Локально на Windows: общий typecheck и lint прошли; backend scope из workflow —
436 passed, 13 Linux-only skipped (20 файлов); frontend unit — 399/399.
API и gateway build прошли. Frontend Nitro build внутри sandbox встретил известный
`EPERM: readlink C:\Users\batti`; повтор только frontend build с обычным доступом
к workspace прошёл, подтверждён exit code 0 дочернего Node-процесса. Новый workflow
прошёл actionlint 1.7.12; `git diff --check` также пройден.

## TBT главной: факты и гипотезы

Дополнительно прочитаны существующие `A/B-lh-home-{1,2,3}.json`; новые замеры
не проводились. Здесь используются только Lighthouse данные.

Подтверждено:

- Медиана TBT выросла с 496 до 643,2 мс, Performance снизился с 44 до 40;
  диапазоны TBT пересекаются: A 479–511, B 478,5–842 мс. Всего по три запуска,
  последовательность A затем B, набор товарных фотографий главной менялся.
- В самих audit scores LCP остаётся 0 во всех шести запусках, несмотря на
  улучшение времени с 19,10 до 11,97 с. TBT имеет weight 30 и теряет score
  (медиана 0,58 → 0,46); улучшение LCP в этой области не увеличивает его вклад
  в общий Performance. Это объясняет снижение score, но не причину роста TBT.
- JS (873 876 bytes) и CSS (286 860 bytes) одинаковы в A/B: использовалась одна
  сборка. Медиана HTML выросла с 202 500 до 271 078 bytes.
- В `mainthread-work-breakdown` медиана `scriptEvaluation` выросла примерно
  1 170 → 1 426 мс, `parseHTML` 56,6 → 103,7 мс, garbage collection 14,1 →
  51,9 мс. Это отдельные Lighthouse audit durations, не слагаемые TBT.

Гипотезы, требующие trace/attribution перед исправлениями:

- Дополнительные metadata/`srcset`/длинные `sizes` увеличивают parsing и работу
  hydration/атрибутов. Сам компонент ProductImage присутствует в обеих группах;
  его добавление нельзя автоматически считать причиной разницы A/B.
- Async decoding, более ранняя загрузка изображений и иное расписание задач
  могут переместить длинные задачи относительно окна расчёта TBT.
- Вариативность CPU/GC и выдачи главной при n=3 могла повлиять на медиану.
  Registry может сдвигать SSR/расписание загрузки, но серверное I/O само по себе
  не является блокировкой main thread браузера.

## Перед production

Нужны успешный Linux CI на точном head PR и code review, проверка целевого mount
(native hard links/no-clobber, rename, file/directory fsync, permissions, symlinks),
owners/ACL для реальных worker/API identities и недоступность state через static.
Hard-linked outputs сохраняют mode 0600, поэтому чтение другим UID надо проверить
явно. Перенос READY между файловыми системами может нарушить source fingerprint.

Требуются операционный план для unknown-owner locks после kill/reboot, проверка
реального crash/power-loss recovery, hard process-tree memory/deadline enforcement
и контроль latency registry. Текущий CLI намеренно допускает apply только в temp
sandbox до 50 источников; production backfill требует отдельного этапа.
Включение двух флагов, rollback и диагностика TBT согласуются отдельно.
