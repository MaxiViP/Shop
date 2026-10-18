# Linux WebP readiness: diagnostics and remaining gates

Продолжение после отдельного разрешения владельца на локальный broker и DB/pool:
[manager broker и lifecycle](product-image-broker-lifecycle.md). Ниже сохранён
исторический результат этапа до этого разрешения; прежние NOT VERIFIED и
отрицательные evidence не переписываются.

2026-10-16. Продолжение после `4bfba36`, `a6e9e02`, ветка
`feat/product-image-production-runner`. Это локальные synthetic fixtures;
**SANDBOX_UNVERIFIED** остаётся обязательным отказом production apply.

## Сохранённая база

Начальный Git был чистым. Предыдущая операция завершилась: 71 Linux application
test, 4 artifact verifier test, Node/Sharp smoke и API PID 1/SIGTERM lifecycle
приняты в [предыдущем отчёте](product-image-linux-artifact.md). Их не повторяли.
Использован тот же artifact, без пересборки:

- `work/linux-artifact-4a7a4141fcaa4759a3d266f99e25b6ab/artifact/`;
- rootfs SHA-256 `03a848f6365b6c543ed50a57c5b396a4b35d6e6b7d685895ca8b8c65ebb5f607`;
- manifest SHA-256 `b88768853b9384e8ec7df931603214bb9aa0dc06eed7553a04b56075bb387381`;
- 7536 entries; Node 24.20.0, Sharp 0.35.4, libvips 8.18.6, Linux x64.

Новые evidence: `work/linux-readiness-20261016T152643Z/`. `baseline.json`
содержит исходный HEAD, предыдущий receipt и hashes защищённых файлов.
Каждый VM case имеет отдельные frozen sources, serial, result, isolation и cleanup
logs в `work/image-application-<id>/`. Неудачные attempts сохранены.

VM: QEMU TCG, 2 GiB/2 vCPU, Ubuntu 26.04, systemd 259.5, kernel 7.0.0-34.
Нет NIC, KVM, SSH, host home или production mounts. Внешний Docker container:
network none, read-only, cap-drop ALL, NNP, 3 GiB/no swap, 2 CPU, 128 tasks.
Только cache volume подключается read-only; каждый запуск получает новый owned
volume. Существующий `shop-db` не используется и не меняется.

## Supervised 800×600

Run `image-application-d2594df0393f4481beb5e1156669e896`: PASS, 1 test,
170.530 s, без failures/errors/skips. Synthetic PNG 800×600, тот же профиль
192/384/640. Production timeout 30,000 ms и child memory budget 512 MiB не
переопределялись. Unit: CPU `50000 100000`, memory.high 512 MiB, memory.max
768 MiB, swap 0, pids.max 64.

| Наблюдение | Значение |
| --- | ---: |
| Supervised encode | 23,473.287 ms |
| Первый child usage sample | 12,383.102 ms |
| Последний child usage sample | 22,878.403 ms |
| Peak sampled child RSS | 115,814,400 bytes |
| Usage samples | 102 |
| Parent TS import | 11,679.824 ms |
| Direct encode после supervised | 6,107.193 ms |
| Throttled periods, before → after | 88 → 631 |
| Cumulative throttled usec, before → after | 4,401,905 → 56,141,276 |
| Memory events high/max/OOM/kill | все 0 |

Три supervised/direct hashes совпали. После unit: cgroup quiescent, NRestarts=0,
все 7536 artifact entries неизменны. Serial SHA-256:
`3da356a9b8e993f60a7ecf0e9f59e2804bd4b68af8e94978f5843f21b1f556b0`.

Предыдущий TIMEOUT 800×600 сохранён. Там direct encode выполнялся первым, а
parent Sharp не получал настройки concurrency/cache production CLI. Новая
диагностика запускает supervised первым и использует parent concurrency=1,
cache.memory=32, как CLI. Это контролируемое изменение fixture, не исправление
production encoder. Измерения указывают на существенную стоимость холодного
Node/TSX startup и CPU throttling в TCG; отсутствие OOM подтверждено kernel counters.
Причинное влияние порядка/Sharp threading отдельно не доказано. Один успешный
case с запасом около 6.5 s не принимает worst-case latency, нагрузку или capacity
реального target. Production лимиты сохранены.

## Полный launcher и fence

Новые opt-in selectors `--launcher-only`, `--launcher-stop` используют тот же
artifact и unchanged `launcher.py`. Synthetic NSS: UID 997, GID 55001,
намеренно разные; это не actual target identity. Создаётся один disposable WebP,
inventory и предложение через настоящий Node dry-run. Apply/backfill не вызываются.

Сохранённые отрицательные cases:

- `4bb2ef64f65d46fc8ed5f6755034f0ed`: preparation unit start failed до inspector,
  1 error, 82.938 s. Причина setup не была экспортирована первым fixture;
  это ограничение evidence не скрыто. Подготовка переведена на уже принятый
  root supervisor → Node child со сбросом UID/GID/groups; journal теперь
  экспортируется и при ошибке. В source receipt отдельно указан один unused
  host MJS, не переданный этим ранним VM builder.
- `e73a6fdbe9324175a718d283b084c10c`: preparation PASS, unchanged inspector
  отказал `MANAGER_UNVERIFIED` до fence/Node, 1 failure, 140.118 s.
  Serial SHA-256 `c1c87c37d865c95fd583f414baaad6df02b2c68c8455d461e059d57c1902e780`.

`launcher_entry.py` — отдельная fixture диагностика: сохраняет returncode,
stderr и размер stdout того же `systemctl show`, до и после создания пустого
`/run/systemd/system` в private tmpfs, только при точном отказе sd_booted.
Затем exec запускает unchanged inspector как PID 1. Нет нового host bind,
capability, permission или обхода manager checks. Это явный fixture bootstrap;
production unit/runtime из такого case не следует считать принятым.
Клиент [systemd v252](https://github.com/systemd/systemd/blob/v252/src/shared/bus-util.c)
проверяет sd_booted до соединения с private manager socket; сам
[sd_booted](https://github.com/systemd/systemd/blob/v252/src/libsystemd/sd-daemon/sd-daemon.c)
проверяет существование `/run/systemd/system`.

Run `3394b23a0faa4b63852eb7c4c529eb65`: FAILED, 1 failure, 144.188 s;
preparation PASS. До bootstrap: returncode 1, stdout 0,
`System has not been booted with systemd ... Host is down`.
После создания private boot marker: returncode 1, stdout 0,
`Failed to connect to bus: No data available`. Unchanged inspector снова
отказал MANAGER_UNVERIFIED до fence/Node. Serial SHA-256:
`e9792875a6d72d3987559807aba6f68c69c675aeb16a90df54552570a2761474`.

В [getpeercred systemd v252](https://github.com/systemd/systemd/blob/v252/src/basic/socket-util.c)
ENODATA возвращается при невалидном peer PID после namespace translation;
[bus_check_peercred](https://github.com/systemd/systemd/blob/v252/src/shared/bus-util.c)
вызывает эту проверку. Это согласуется с manager за пределами private PID
namespace, но raw SO_PEERCRED отдельно не измерялся. В
[v259](https://github.com/systemd/systemd/blob/v259/src/basic/socket-util.c)
та же проверка остаётся: простая замена версии клиента не имеет доказанного
решения. Нельзя лечить отказ удалением PrivatePIDs или ослаблением peer checks.
`--launcher-stop` не запускался: общий startup уже подтверждённо отказывает
до child, поэтому повтор не проверил бы shutdown. Полный production launcher,
его FDSTORE/fence и shutdown с этим artifact остаются NOT VERIFIED. Прежняя
synthetic Python/kernel fence acceptance не заменяет этот gate.

Fixture требует настоящие manager properties, PrivatePIDs/PrivateUsers,
kernel process status, FDSTORE=1, FENCE_BUSY при работе и после exit/daemon-reload,
MainPID=0, cgroup quiescence, завершение наблюдаемых pidfds и неизменность
storage/input/fence/rootfs. Pin target не останавливается, FDSTORE не очищается,
lock inode не заменяется. Только shutdown owned VM освобождает её kernel state.

## Actual target: только согласованный read-only audit

`deploy/image-runner/target_audit.py` подготовлен, на VPS не запускался.
Запрошены отдельное согласование и проверенный SSH alias/user@host/порт.
Скрипт не принимает путей/команд и ограничен 35 s, каждый subprocess — 5 s.
Читает NSS shop UID/GID/groups, stat/ACL/xattr names фиксированных roots и
родителей, mount metadata/capacity, выбранные API systemd properties,
UID/GID/groups/namespaces существующего API PID. PID race/permission denial
отмечаются UNVERIFIED, не вызывают restart или fallback write.

Не читает фото, `.env`, process environ/cmdline, содержимое БД. Не запускает
write/link probes. Mount source и неизвестные options не экспортируются, чтобы
не сохранить credentials. Отсутствие getfacl, unit/property или доступа означает
UNVERIFIED. Не устанавливает инструменты, не меняет ACL/ownership/systemd.

Согласуемые roots: `/var/lib/korzinamarket/uploads`, `products`,
`product-variants`, `.product-image-state`, `/var/lib/korzinamarket-image-runner`.
После согласования результат нужно сохранить локально вместе с SHA-256 скрипта,
временем и endpoint identity; не загружать скрипт/результаты на target.
Чтение metadata не принимает writers/aliases, I/O/durability или capacity под
нагрузкой. Owner-reported UID 997/ext4/nobarrier не заменяет live audit.
PrivatePIDs=yes требует подходящего systemd; старый target нельзя принимать
через удаление directive или подавление unknown-property error.

## Real DB/pool: подготовка, без запуска БД

`db_lifecycle.mjs` по умолчанию выполняет только `--plan` и выводит
PREPARED_NOT_RUN. Ни одной БД/кластера этот этап не создавал и не менял.
Guard checks выполнены без DB. Режимы `--close`/`--signal` требуют Linux UID
55000, private Unix socket `/run/korzina-db-fixture/.s.PGSQL.5432`, directory
UID 55000/mode 0700 и marker `owned` с точным содержимым
`korzina-db-pool-disposable-v1\n`. Для `--signal` Node должен быть PID 1.
Наследованные DATABASE_URL, PG*, DOTENV_* и loader overrides отвергаются,
значения credentials не печатаются. Нет произвольного URL/SQL или `.env`.

Будущая среда должна быть отдельной и получить согласование на создание
disposable DB перед запуском. Конкретный план для review:

1. Новый уникальный label/run ID и пустые owned resources. Не использовать
   compose, `shop-db`, существующие volumes, Windows `.env`, migrations или
   production paths. Зафиксировать image IDs, source/manifest/script hashes.
2. Два отдельных containers с network none, без портов/host network. Node image
   получить из принятого rootfs с проверкой всего manifest; server image —
   `postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af`
   (локально доступный 18.6, RepoDigest сохранён в `db-image-plan.json`).
   Построение/совместимость этих fixture images ещё не проверялись.
3. PGDATA только в новом tmpfs; Unix socket в отдельном новом private tmpfs
   volume, UID/GID 55000 и mode 0700. Оба процесса фиксированного fixture UID;
   mount namespace, PID namespace, NNP, capabilities, memory/PID/CPU/time budgets
   задать явно. Read-only Node rootfs, только socket и bounded `/tmp` доступны
   для записи. Ни общих production ресурсов, ни remote transport.
4. Инициализация создаёт только fixture role/database `fixture` /
   `korzina_pool_fixture`. `listen_addresses=''`, private socket permissions,
   `default_transaction_read_only=on` после setup. Без business schema, seed,
   migrations и таблиц. Эти init actions пока не выполнялись.
5. Node получает очищенный env и marker. Он проверяет parsed pg connection
   parameters на фиксированный Unix socket до подключения. Использует настоящий
   compiled DbService/PrismaPg/pg.Pool, минимальный Nest module без background jobs.
   Допустимые queries: SELECT 1/pg_backend_pid и observer SELECT pg_stat_activity.
6. Отдельные свежие runs: `app.close()` и SIGTERM после DB_POOL_READY. Сохранить
   DB_POOL_BEFORE_FIXTURE_CLEANUP, DB_POOL_RESULT, exit/timing, pool counters и
   отсутствие backend PID. Pool.end instrumentation делегирует настоящим методам;
   provider не подменяется. Сначала оценивается cleanup приложения, потом
   отдельный `$disconnect()` убирает fixture. Ручной cleanup не превращает
   отсутствующий lifecycle hook в PASS. При сигнале отдельно проверить отсутствие
   процессов/container после bounded stop.
7. После serial/log export и quiescence удалить только новые ресурсы по точному
   run ID и ownership labels. Старые containers/volumes не трогать.

Static finding: текущий DbService не содержит shutdown hook с `$disconnect()`.
Локальный PrismaPg adapter создаёт собственный pg.Pool и вызывает pool.end при
dispose. [node-postgres](https://node-postgres.com/apis/pool) описывает pool.end
как закрытие pool clients и timers. Реальный runtime результат пока неизвестен;
production DbService на основании одного static finding не менялся. Проверка
scope минимального provider не заменяет будущий полный API + actual DB lifecycle.

## Решение manager connection для отдельного согласования

Изменений security policy не вносили. До одобрения допустимы только текущий
отказ и диагностика. Предлагаемый предмет review — отдельный read-only manager
broker в свежей VM, сохраняющий PrivatePIDs, PrivateUsers, caps, cgroup limits,
проверки request/approval/storage и удержание fence. Это новый control channel,
поэтому его implementation/security review требуют отдельного согласования.

Ограничения предлагаемого протокола:

- Unix endpoint root:root 0600 в root-owned directory, новый RO bind только
  этого endpoint; никаких parent host directories, bus mounts или TCP.
- Только две фиксированные операции получения свойств
  `shop-image-runner@<validated UUID>.service` и соответствующего pin target.
  Allowlist содержит все поля нынешнего manager_policy плюс MainPID;
  Environment/ExecStart payload и произвольные unit/commands запрещены.
- Broker проверяет kernel peer UID и связывает caller PID/pidfd с настоящим
  MainPID и ControlGroup данного instance, проверяет request/hash binding;
  Node UID 997 и другой instance должны получить отказ до запроса manager.
- Client проверяет root-owned endpoint identity и подлинность peer; точный
  способ аутентификации через PID namespace должен пройти отдельный review.
  Нельзя принимать ответ лишь потому, что payload утверждает uid=0 или PASS.
- Bounded messages/timeouts, один response snapshot; прежний manager_policy
  применяет все exact comparisons к реальным значениям. Нет start/stop/reload,
  file writes, command strings, inherited secrets или новых capabilities.
- После одобрения сначала negative tests: чужой UID/instance, PID reuse,
  подмена endpoint/reply, timeout/oversize, остановка broker. Затем полный
  inspector/fence/daemon-reload и SIGTERM с живым child в отдельных fresh VM.
  Production apply по-прежнему всегда SANDBOX_UNVERIFIED.

Это проект решения, не готовый broker и не разрешение его установки. VPS,
production units, RootDirectory provisioning и release/base choice отдельно
не проверены и не менялись.

## Проверки и ограничения

Portable selector regression сохраняет обязательный child OOM case исходной
матрицы. Readiness tests opt-in и не расширяют уже принятую full discovery.
Существующие application/API TypeScript, production units, launcher, lockfile,
Prisma schema, apply gate не менялись. Поэтому 71+4 и прежняя kernel acceptance
не повторялись; новые diagnostics проверяются отдельно.

Portable verification receipt: `portable-20261016T160322Z.json`. Ruff check/format
и AST для 11 Python files, selector regression (1), audit guards (3), DB plan
guards (3), Node
syntax (4) и diff check прошли. В encode selector добавлено строгое требование
outcome=SUCCESS; сохранённый report d2594df... удовлетворяет ему. Отдельный
повтор уже успешного native encode ради этого assertion не выполнялся.

Preservation: 782 старых evidence files и прежние receipts сохранили hashes;
6 защищённых sources и accepted artifact tar/manifest неизменны. Final Docker
inventory `final-docker-20261016T160527Z.json`: только прежний healthy `shop-db`
и 4 прежних volumes, новых application containers/volumes нет. Connection к БД
не предпринимался. Все новые QEMU VM остановлены после экспорта evidence.

Ожидаемые открытые gates: actual target audit/ACL/storage/PrivatePIDs;
production runtime manager connection; fixture DB provisioning/run;
worst-case latency/capacity; operational approvals G2–G9. Никакой результат здесь
не разрешает deploy, backfill или production apply.

## Локальная привязка

`e91d17f` содержит diagnostics/selectors, full launcher fixtures, read-only audit
и guarded DB probe. Production/app sources не входят в этот commit. Frozen VM
sources сохранены независимо от Git line endings. Поздние audit PID-race guards
проверены portable tests; более строгое encode outcome assertion проверено по
сохранённому SUCCESS report и повторным AST/Ruff. Они не требуют повторять
прежний успешный encode или заведомо отказавший manager startup.

После docs commit сохраняется отдельный `verified-local-*.json` в evidence
directory: оба commit ID, clean Git, связь каждого нового source с Git blob,
hashes receipts и явные NOT VERIFIED gates. Artifact provenance не переписывается
на новый HEAD, прежние результаты не заменяются.
