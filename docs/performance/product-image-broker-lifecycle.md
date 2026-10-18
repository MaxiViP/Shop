# Local manager broker and DB lifecycle

2026-10-16. Продолжение `9aa3a9b`, ветка
`feat/product-image-production-runner`. Владелец отдельно разрешил разработку
root-only read-only broker и DB/pool probes в локальных disposable Linux VM.
**SANDBOX_UNVERIFIED сохранён.** Production apply, VPS, deploy, backfill,
миграции, БД магазина и оригинальные изображения в scope не входят.

## Восстановление и сохранённая база

На момент разрыва оставались незакоммиченные broker/fixture sources и кандидат
`DbService.onModuleDestroy()`. Проверка `7b80dff5...` уже завершилась; её не
запускали повторно. После разрыва не осталось application VM/containers/volumes.
Docker inventory сохранил только healthy `shop-db` и четыре прежних volumes;
подключение к БД магазина не выполнялось.

Evidence: `work/linux-broker-20261016T161655Z/`. Исходный `baseline.json`,
`resume-20261016T170129Z.json`, frozen sources, serial, runtime isolation и
cleanup receipts сохраняют связь запусков с точными raw SHA-256. Неудачные
attempts сохранены. Все VM без NIC/SSH, внешние containers без сети, с read-only
root, cap-drop ALL, NNP, 3 GiB/no swap, 2 CPU и 128 tasks. Каждый run получает
новый owned volume; прежний cache подключается только RO.

Повторно используется принятый artifact `linux-artifact-4a7a4141...`:
7536 entries, Node 24.20.0 / Sharp 0.35.4 / libvips 8.18.6. Его tar/manifest
и provenance не переписываются. Прежние 71 application tests, 4 verifier tests
и encode 800×600 повторно не запускались.

## Manager transport

Прямой manager socket не работает из private PID namespace. Кандидат broker
запускается только в marked disposable VM, вне PID namespace inspector. Helper
имеет пустые capabilities, NNP, seccomp, RO system protection и bounded resources.
Inspector сохраняет PrivatePIDs=yes, PrivateUsers=full, NNP/seccomp, прежние
capabilities, cgroup limits, request/approval/storage и fence checks. Вместо
manager bus монтируется один root:root 0600 Unix SOCK_SEQPACKET endpoint.

Одна операция `snapshot` возвращает allowlist свойств ровно двух unit текущего
UUID: runner и pin target. Вызов manager — фиксированный `systemctl show`, без
start/stop/reload, произвольных properties, команд, Environment или ExecStart.
Каждый запрос ограничен размером/временем, связан с request SHA-256 и nonce.

Server сверяет SO_PEERCRED, SCM_CREDENTIALS и живой SO_PEERPIDFD; pidfd inode
должен совпасть с новым pidfd конкретного caller PID. Проверяются kernel
UID/GID, namespace PID 1, caps/NNP/seccomp, настоящий cgroup, manager MainPID и
ControlGroup, hashes runner/pin units. Клиент проверяет socket dev/inode,
owner/mode и peer pidfd dev/inode из root-owned request 0600. Требуются уникальные
pidfs identities: credential-only fallback отсутствует. Принудительное повторное
использование числового PID отдельно не воспроизводилось.

Manager v259 экспортирует PrivateUsers как `yes`, а точный режим —
PrivateUsersEx=`full`. Проверка требует обе реальные величины и отвергает
`no`/`self`/`identity`; directive PrivateUsers=full не ослаблялась. Production
units и production runtime artifact в этом этапе не изменяются. Candidate
sources отдельно монтируются RO в VM, поэтому результат не принимает их
production packaging/provisioning.

## Принятый полный launcher

`image-application-7b80dff5ded348b483c26825b273ee32`: PASS, 1 test,
266.181 s, без errors/failures/skips. Serial SHA-256:
`1c5e335c63b4f6b53a28060b197026fbff0fda5ab93a25cfc0507186161d921e`.

Проверены 13 атак: start/stop/reload, чужие unit/properties/instance, поддельная
identity, неверный request digest, duplicate key, oversize, отправка через
унаследованный socket другим процессом, неправильный broker pidfd и настоящий
root fake broker. Отдельно отказаны root вне unit, PID 1 другого cgroup и UID
997 до доступа к endpoint. Разрешённый snapshot получен от настоящего manager.

Настоящий inspector запустил Node dry-run с UID 997, GID 55001, пустыми groups,
E/P/I/A=0, NNP=1 и Seccomp=2. Fence занят при работе и после exit/daemon-reload;
FDSTORE=1 сохранён, повторный start отказал FENCE_BUSY, ручной stop pin target
отказан. MainPID=0, NRestarts=0, cgroup quiescent, все 3 наблюдаемых pidfds
завершены. Input/storage/fence inode и все runtime entries неизменны.

Позднее клиент стал также отвергать boolean вместо числовой protocol version.
Ранее сохранённые snapshots используют integer 1; новая проверка проходит
отдельно в shutdown fixture. Исходный успешный launcher не повторяется ради
этого ужесточения parser.

## Shutdown и отказавший broker

`image-application-37859e765d1e4752876cb6f26f095d86`: PASS, 1 test,
229.582 s, без errors/failures/skips. Serial SHA-256:
`56bd524fb44d6b1d92e66df83d1c0be45388f65031a613cc4fd31efa78824948`.

`broker_fault.py` принял 11 negative cases: timeout, oversize, nonce/digest/version,
чужой unit, запрещённое property, неверный тип поля, duplicate key, заменённый
endpoint и остановленный peer. Для malformed ответов проверен точный отказ;
timeout ограничен client budget 3 s. Тестовые root peers явно доверены только
внутри response-parser fixture; подмена настоящего broker проверена отдельно
в предыдущем run.

Затем тот же PID 1 exec запустил inspector; systemctl stop отправил SIGTERM при
живом Node child UID 997/GID 55001. Получен STOP_REQUESTED, cgroup quiescent,
MainPID=0, NRestarts=0, все 4 наблюдаемых pidfds завершены. FDSTORE=1 и BUSY
сохранены после exit/daemon-reload, повторный start и ручной stop pin target
отказаны. Input, storage, fence inode и runtime manifest неизменны. Broker
остановлен, его pidfd завершён; только shutdown owned VM освобождает её
retained fence. После serial export owned container/volume удалены.

## Real DB/pool

PostgreSQL 18.6 export из локального pinned image:
`postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af`.
Curated rootfs: 784 entries, tar SHA-256
`36a0f2d9c3bac688eeea31fb9f0be246587da3e677dc8961a116ec1a1c18b07f`.
Существующие containers/volumes/compose/.env не используются. Экспортирующий
container не запускает PostgreSQL, не подключает volumes и удаляется после export.

В новой VM PGDATA и socket — отдельные bounded tmpfs, UID/GID 55000, mode 0700.
Server/probes имеют PrivatePIDs/PrivateUsers, cap-drop, NNP/seccomp и AF_UNIX.
listen_addresses пуст, default_transaction_read_only=on; фиксированное исключение
PGOPTIONS доступно только setup unit для создания пустой korzina_pool_fixture.
Нет business schema, tables, seed или migrations. Probe проверяет socket owner,
marker, parsed connection parameters, readonly setting и отсутствие TCP address
до lifecycle assertions. Соединения — настоящий compiled DbService/PrismaPg/pg;
provider не подменяется.

План сравнивает исходный compiled DbService и кандидат с `$disconnect()` в
onModuleDestroy, каждый через app.close() и SIGTERM после DB_POOL_READY. Pool
instrumentation делегирует настоящим методам. Наличие product hook оценивается
до manual fixture cleanup; ручной cleanup не превращает baseline failure в PASS.
Observer отдельно проверяет отсутствие исходного backend PID в pg_stat_activity.
Strict API typecheck/lint/build выполнены локально. В VM TypeScript 6.0.3
из enumerated media проверяет совпадение Linux emit с уже собранным JS, отдельно
запускается native Linux oxlint; затем подменяется только один RO compiled file.
Сравнение emit игнорирует только CRLF/LF, крайние пробелы и sourceMappingURL
comment; исполняемый JS не переписывается. SHA-256 исходника, compiled JS и
исходного API check receipt фиксируются в media manifest. Исходный runtime
artifact остаётся неизменным.

`13f47463...` подтвердил отсутствие cleanup hook у исходного compiled DbService:
после app.close() и SIGTERM до ручного cleanup оставался один idle client,
pool.end не вызывался. Ручной `$disconnect()` затем убрал backend PID. Это
отрицательный результат baseline, не принятие всей VM: при следующем шаге
компиляции Docker отметил outer OOMKilled=true, итоговый guest report отсутствует.
Frozen sources и raw serial сохранены в отдельном partial receipt без заявления
final guest/source binding. После export удалены только owned container/volume.

Следующая DB VM получает 1536 MiB вместо 2048 MiB, чтобы оставить больше места
внешнему QEMU/cache внутри прежнего 3 GiB envelope. Inspector/application limits
не меняются; compiler/server/probe по-прежнему ограничены своими cgroups.
`16b80d5b...`: OOMKilled=false, memory cgroup samples oom/oom_kill=0; оба
baseline cases снова подтвердили отсутствие hook. Полная semantic TypeScript
проверка generated Prisma graph остановлена по отдельному fixture deadline
150 s до emit. Никакой production timeout не увеличивался. Этот optional Linux
semantic pass остаётся NOT VERIFIED; он не выдаётся за успешно пройденный.
Для дальнейшего runtime probe используется уже успешно typechecked/build API
output, с проверкой Linux emit и native lint. Media `linux-postgres-candidate-db441597...`
содержит 27 enumerated files вместо полного generated type graph. В run
`fa226d64...` Linux emit comparison прошёл, но native lint остановился до DB
candidate: минимальный Node rootfs не содержит требуемую oxlint `librt.so.1`.
Причина сохранена; подготовка кандидата и весь run не объявлены PASS.

Следующий media `linux-postgres-candidate-ffaa13d1...` содержит 29 files.
Lint-only `librt.so.1` взята из уже сохранённого pinned PostgreSQL export;
libc export, curated PG artifact и фактического Node rootfs должны совпасть
по SHA-256. `LD_LIBRARY_PATH=/run/db-build/lib` задан только фиксированному
lint subprocess. Server, DB probes и inspector сохраняют loader environment
scrub; application artifact, capabilities, mounts и limits не расширены.
Для раннего отказа preparation/candidate cases теперь идут перед baseline.

## Принятый DB lifecycle

`image-application-68ff8eac76ad4a47b81eeddf6b87d4cf`: PASS, 1 test с четырьмя
real DB cases, 414.108 s, без errors/failures/skips. Serial SHA-256:
`9c367993b3a2fee911232e8fdc72bbfe118dbce1e0bea371747e594843f7dcbd`.

| Subject | app.close() | SIGTERM после DB_POOL_READY |
| --- | --- | --- |
| Исходный compiled DbService | Один idle client, pool.end не вызван; ожидаемый DB_LIFECYCLE_HOOK_MISSING. | То же; ручной fixture cleanup отдельно убрал backend. |
| Исправленный compiled DbService | До ручного cleanup total/idle/waiting=0, pool.end вызван, unit success. | Те же нулевые counters, unit success, stop 6.334 s при budget 30 s. |

`DbService` теперь реализует OnModuleDestroy и ожидает `$disconnect()`.
Проверены настоящий PrismaPg/pg, source→compiled binding и отсутствие backend
PID после observer check. Все четыре cgroups quiescent, оба candidate units
завершились с exit status 0. PostgreSQL остановлен; оба runtime manifests
проверены после stop и неизменны. Это минимальный Nest provider context,
без AppModule/background jobs: полный API + actual DB остаётся отдельным gate.

Linux emit совпал с реальным API build, native oxlint 1.80.0 прошёл. Compiled
SHA-256 `c801eae4a0148d14e4f477c4e37c9722183e10ae5f4cce6f87b9c21eac072f95`;
source SHA-256 `ddd44ebf3113a2d2c966e5a9ced9c0da7f3b8fa731a3b511865b1eab7666334a`.
Отдельная полная Linux semantic typecheck не принята и не подменяется emit
comparison; успешный strict API typecheck выполнен на Windows.

## Сохранённые отрицательные attempts

| Run | Результат |
| --- | --- |
| `679b35ec...` | 13 broker attacks приняты; inspector отказал MANAGER_POLICY_UNVERIFIED из-за несовпадения PrivateUsers manager representation. |
| `74d305db...` | systemd отказал на USER до Node/DB: UID 55000 отсутствовал в NSS новой VM. Добавлен отдельный fixture account. |
| `438f1252...` | guards и initdb прошли; CREATE DATABASE отказал: UnsetEnvironment удалил фиксированный PGOPTIONS setup unit. Все owned resources убраны. |
| `13f47463...` | оба baseline lifecycle cases выявили отсутствующий hook; outer QEMU OOM во время compiler step, итоговый guest report отсутствует. |
| `16b80d5b...` | уменьшенная DB VM без OOM; full Linux semantic compiler step не уложился в fixture deadline 150 s. Все owned resources убраны. |
| `fa226d64...` | Linux emit совпал с API output; native lint не загрузился из-за отсутствующего librt.so.1. DB candidate не запускался. Все owned resources убраны. |

## Проверки и оставшиеся gates

Portable receipt `portable-20261016T194231Z.json`: AST/Ruff check/format для
35 Python files; 40 manager/broker/policy/lifecycle tests; 3 DB plan guards;
Node syntax и git diff check — PASS. API typecheck, lint и build — PASS.

`preservation-20261016T195410Z.json` подтвердил hashes 12 прежних receipts,
9 frozen host snapshots, исходных и производных tar/manifest. Из protected
sources изменены только согласованные launcher и DbService; production units,
Prisma schema, lockfile и unconditional apply gate сохранены.
`final-docker-20261016T195413Z.json`: только прежний healthy shop-db и четыре
прежних volumes. Новые application containers/volumes удалены после export,
все новые QEMU VM завершены. БД магазина не подключалась.

Открыты actual target UID/GID/ACL/storage/PrivatePIDs и согласованный SSH audit,
production packaging нового control channel, полный API + actual DB lifecycle,
worst-case capacity и operational approvals G2–G9. Локальный broker не является
разрешением установки на VPS. Никакой результат не снимает SANDBOX_UNVERIFIED.

## Локальная привязка

`0e8eb75` содержит product cleanup hook; `aec3627` — broker и fixture
implementation. Данный evidence report фиксируется отдельным docs commit.
После него `verified-local-*.json` связывает три commit ID, clean Git, все
текущие frozen sources и DbService с Git blobs.
Raw SHA-256 сохраняются; для Git сравнения допускается только CRLF/LF.
Artifact provenance не переписывается на новый HEAD.
