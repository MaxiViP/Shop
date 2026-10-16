# Image runner: child OOM и lifecycle — продолжение 5Б-2Б

Исходный HEAD `6cee5d0a566e6525984769a9a25bb72e5582d7e6`, ветка
`feat/product-image-production-runner`. Продолжение
[credentials acceptance](product-image-runner-credentials.md) и
[disposable Linux acceptance](product-image-production-acceptance.md).
**Production apply остаётся SANDBOX_UNVERIFIED.**

Продолжение после `c2e3646`: [проверка harness и точечный acceptance](product-image-runner-acceptance-review.md).

## Восстановление после WebSocket

До запуска проверены git/index, Windows processes, явный локальный Docker endpoint,
сохранённые logs и две прежние fixture volumes. HEAD совпал; незакоммичены только
изменения выбора scope в `acceptance_host.py` и `vm.py`. Python/QEMU/acceptance
containers отсутствовали. В Docker работал только существующий `shop-db`;
его данные и процессы не использовались. Обе прежние volumes сохранены.

`work/image-oom-20261016/baseline.json` имеет SHA-256
`420eb52e7e3562bb4b5d746712410826c95614b56c3a2b16e786f1853272f5f6`.
Все 263 previous evidence files существуют и совпадают по SHA-256; все пять файлов
`before/` совпали с исходниками на момент восстановления. Все шесть protected files
совпали с baseline. После baseline новых evidence files вне его каталога не было;
OOM-тест после разрыва не запускался. `baseline.py` повторно не выполнялся.
Read-only аудит сохранён отдельными `recovery-*.json` и `local-state.json`.

Сохранённый full run `image-acceptance-7e8724242b4f4b64b27150b3ed1d7c94`:
49 PASSED, 1 FAILED (child OOM), 10 NOT VERIFIED из 60 tests, 0 errors/skips.
Успешные 49 tests, application/typecheck/lint/build не повторялись.

## Причина timeout

Первый новый prepare `image-acceptance-0b7ca988072040d2805381573683e73e`
остановился на curl TLS error 35 до загрузки VM и до тестов. Это NOT VERIFIED,
не OOM failure. Его logs и volume сохранены. TLS verification не отключалась.

Для следующих VM отдельный ignored wrapper
`work/image-oom-20261016/run_cached.py` читает только base image из прежней
`image-acceptance-5c9c822361e1409e983fb65a8b91732b` volume, подключённой read-only.
Проверяются marker и закреплённый SHA-256 до и после копирования в новую пустую
volume. Старые overlay/seed не используются. Новые VM сохраняют прежние cap-drop
ALL, NNP, readonly container root, network none, CPU/RAM/swap/tasks limits, QEMU/TCG
без KVM, 1200 s/8 MiB bound, отсутствие SSH, guest network и host cgroup mounts.
Prepare теперь тоже проходит без сети. Production wrappers и Docker auth не нужны.

Диагностический run `image-acceptance-0c17a7a1ca4f4b5fa968eb9674ef45dc` выбрал
только `test_child_cgroup_oom` с прежним single MAP_POPULATE payload. Native
preflight: PID 1 systemd 259.5-0ubuntu3.4, kernel 7.0.0-34-generic, cgroup v2,
memory/cpu/pids и реальное создание namespaces. Все 16 guest source hashes
совпали с исходниками и отдельным `diagnostic-source/` snapshot.

Получены 12 OOM_SAMPLE records, memory.events/local, memory.current/peak/pressure,
cpu.stat, cgroup.procs/events и status/wchan/stack обоих процессов. Child находится
в D-state в `__mem_cgroup_handle_over_high → try_charge_memcg → … → __mm_populate`.
`high` вырос с 0 до 1659; `max`, `oom`, `oom_kill`, `oom_group_kill` остались 0.
Journal подтверждает RuntimeMaxSec, затем SIGKILL обоим PID, Result=timeout;
memory peak 564.7 MiB. Hard limit 768 MiB не достигнут.

Это synchronous reclaim/throttling внутри mmap, а не отсутствие MemoryMax или
неработающий OOMPolicy. Linux вызывает high handling прямо из try_charge при
достаточном batch, даже до возвращения syscall в userspace:
[Linux v7.0 memcontrol.c](https://github.com/torvalds/linux/blob/v7.0/mm/memcontrol.c).
`memory.high` не вызывает OOM; смысл hierarchical/local counters описан в
[kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

После timeout: cgroup удалена, descendants отсутствуют, NRestarts=0,
FD store=1, pin active, fence BUSY с прежним inode. Release выполнялся только
для созданного fixture после quiescence и проверки exact identity. VM штатно
выключилась; serial экспортирован, удалена только её новая volume.
Diagnostic result: 0 PASSED, 1 FAILED, 0 NOT VERIFIED из одного выбранного test.
Serial SHA-256 `0a3c063d4e8076ed030db2f171475b71abbc92eccdc3df818e4911b3478b1091`,
141277 bytes. Исторический failure сохранён, ожидание oom-kill не заменено timeout.

## Изменения fixture harness

- `--child-oom` выбирает ровно один case; `--lifecycle` — оставшиеся десять,
  без повторения уже принятого child OOM. Без flag остаётся полный suite.
  Выбор передаётся host → VM → guest и проверяется в host report; report содержит
  `selection` и `selectedTests`, чтобы partial run не выдавался за полный.
- OOM нагрузка использует один anonymous mapping 1 GiB в выбранном parent/child,
  MADV_HUGEPAGE и 32 потока по 32 MiB. Barrier создаёт ограниченный burst;
  readv из `/dev/zero` освобождает Python GIL и fault-ит настоящие страницы.
  Это замена тестовой нагрузки, не изменение controller policy. Указание THP
  относится только к этой fixture VM и не гарантирует такой результат на другом kernel.
- MemoryHigh=512 MiB, MemoryMax=768 MiB, MemorySwapMax=0, OOMPolicy=kill,
  memory.oom.group=1, RuntimeMaxSec=60, CPUQuota=50%, TasksMax=64 сохранены.
  Production template, launcher, deploy fence implementation и gate не менялись.
- Уникальный fixture slice с unlimited high/max сохраняет hierarchical events
  после удаления service cgroup. Условие успеха требует Result=oom-kill и положительные
  delta max/oom_kill/oom_group_kill. Снимки local service events снимаются до и во
  время нагрузки. Unrelated guest services не входят в этот slice.
- Для исходных parent/child/grandchild открываются pidfds до воздействия;
  после quiescence каждый должен быть readable как exited. Fence остаётся BUSY
  после stop/kill/OOM/runtime и reload/reexec. После explicit fixture CleanUnit
  проверяются FD store=0 и успешный acquire того же файла. Автоматического
  production release/restart/resume нет.

## Проверка исправленного child OOM

Run `image-acceptance-3709301203c346b9a35354350273a1a3`:
**1 PASSED, 0 FAILED, 0 NOT VERIFIED**, 0 errors/skips.
Те же kernel/systemd/controllers/namespace preflight и pinned Ubuntu image;
все 16 source SHA-256 совпали с checkout, snapshot — `oom-source/`.

MemoryHigh/Max/Swap, CPU/tasks и RuntimeMaxSec не менялись. Unit завершился
за 48.313 s с Result=oom-kill и memory peak 768 MiB. Delta memory.events:
`high=2265`, `max=356`, `oom=10`, `oom_kill=3`, `oom_group_kill=1`.
Это kernel group OOM, подтверждённый counters и journal, не внешний kill.
MainPID=0, оба исходных pidfd exited, cgroup удалена, NRestarts=0,
FD store=1, pin active, fence BUSY. После проверки exact inode/bytes/quiescence
explicit fixture clean дал FD store=0 и FREE_AFTER_EXPLICIT_CLEAN.
Group OOM может завершить несколько threads одного process; `oom_kill=3`
не выдаётся за три уникальных process leader PID.

Test runner: 1 test за 66.052 s с setup/cleanup; VM штатно выключилась.
Serial SHA-256 `c69224afa2702cddd5271ab5e63ff2d17ba3514d00b8737d7a67287b7b2c5f69`,
129564 bytes. Новая volume удалена только после export/отсутствия containers;
прежние volumes не менялись. Новые logs и analysis хранятся в ignored `work/`.

## Оставшиеся lifecycle tests и итоговая матрица

Run `image-acceptance-cd9dd019c0224a078ec9efbe5feb150e` выбрал ровно оставшиеся
десять cases: **10 PASSED, 0 FAILED, 0 NOT VERIFIED**, 0 errors/skips,
300.545 s. Child OOM и прежние 49 successful tests не запускались повторно.
Все 16 guest source SHA-256 совпали с проверенным snapshot `oom-source/` и
неизменёнными исходниками. Serial SHA-256
`b1bb22d9b990b643402de9b8d1c7ef237b0fd9a799bf37fad371dbfd06c10900`,
140221 bytes; guest штатно выключился, его новая volume удалена после export.

Пройдены CPU quota с реальной whole-tree нагрузкой, fork до EAGAIN/TasksMax,
double-fork/setsid orphan, graceful и ignored SIGTERM, SIGKILL, hung runtime,
FDSTORE после stop/kill, reload и двух daemon-reexec. Для каждого из десяти cases
quiescence=true, все исходные pidfd exited, NRestarts=0, manager FD store=1 и
fence BUSY до explicit fixture clean; затем FD store=0 и acquire разрешён.

Parent OOM: Result=oom-kill за 35.941 s, peak 768 MiB;
delta `high=2263`, `max=299`, `oom=3`, `oom_kill=4`, `oom_group_kill=1`.
MainPID=0, все три исходных pidfd exited; pin active и fence BUSY после OOM.
Kernel log содержит выбор leader и group kill потомков; `oom_kill` не считается
числом уникальных process leader PID.

Actual Docker inspect lifecycle VM сохранён в `runtime-isolation.json`:
Privileged=false, ReadonlyRootfs=true, NetworkMode=none, CapDrop=ALL, CapAdd=null,
NNP, 3 GiB Memory=MemorySwap (swap=0), 2 CPU, 128 tasks, private IPC,
без host PID namespace, devices/KVM, port bindings и Docker socket.
RW mount — только новая `/vm` volume; selected fixture sources read-only,
tmpfs `/tmp` ограничен 64 MiB. Container не попадал под host OOM kill.

| Область подсчёта | PASSED | FAILED | NOT VERIFIED |
| --- | ---: | ---: | ---: |
| Итоговые состояния 60 уникальных synthetic cases | 60 | 0 | 0 |
| Из них сохранённые successful cases прежнего full run | 49 | 0 | 0 |
| Новые успешные cases: child OOM + lifecycle | 11 | 0 | 0 |
| Диагностический запуск старого single-allocator payload | 0 | 1 | 0 |
| Все case executions четырёх учтённых runs, включая историю | 60 | 2 | 0 |
| Prepare с TLS error, без VM/test execution | 0 | 0 | 1 |

Последние две строки используют отдельные единицы учёта. Два failed executions —
старый full-run child OOM и новая диагностика того же отказа; они не удалены и
не считаются текущими failed cases после успешного исправления. Это собранная
матрица с сохранением evidence, не новый full-suite запуск на одном boot.

## Параллельный сеанс и граница локального коммита

Во время lifecycle VM второй активный сеанс Codex в той же папке дополнил
`acceptance.py`, `acceptance_host.py` и `test_systemd.py` проверками manager
properties, fence во время polling и empty-selection guards. Он также прочитал
child analysis до последующих правок; повторное создание analysis было отвергнуто
exclusive open, существующий файл сохранился.

Эти исходники сохранены отдельно в `concurrent-source-20261016T0643Z/`.
Они новее NoCloud seed обоих successful runs. Локальный коммит этого продолжения
содержит **проверенный `oom-source/` snapshot**; дополнительные изменения второго
сеанса оставлены в рабочей папке. Их native acceptance этим отчётом не заявляется.
Index формируется из отдельного patch, без замены working files, reset/stash/clean.

После завершения своих VM обнаружен принадлежащий второму сеансу новый
`image-acceptance-85dbe5f2ff7d47999baca2c67ce9b596-vm` с `--child-oom`.
Он не запускался и не останавливался этим продолжением, не входит в счётчики выше.
`post-suite-local-state.json` подтверждает отсутствие трёх собственных fixture
containers/volumes, сохранность двух прежних volumes и volume TLS failure.
Существующий `shop-db` имеет прежний ID; его содержимое не использовалось.

Ruff 0.14.0 check и format --check прошли для пяти изменённых Python files
проверенного snapshot. Прежние application/typecheck/lint/build не повторялись:
application/package/lockfile, Prisma schema, production gate, ImageStorage,
deploy.sh, launcher и оба production templates не менялись.
SHA-256 baseline/263 previous evidence/protected files проверяются итоговым
read-only audit; список test IDs хранится там же.

**Production остаётся NOT VERIFIED / SANDBOX_UNVERIFIED.** Immutable Node/Sharp/
libvips artifact, actual shop identities/ACL и API RO/proc/ptrace boundary,
target persistent storage/durability/budgets, reboot/D-state/manual recovery,
independent CI и operational approvals не принимаются synthetic fixtures.
Нет push/merge/deploy/backfill, изменений VPS, production, БД, originals или flags.

## Подтверждение manager telemetry и удержания fence

Локальный `5e6ca5a` сохранил проверенные выше fixture changes. Следующий точечный
run `image-acceptance-85dbe5f2ff7d47999baca2c67ce9b596` проверил оставленные
дополнения manager/fence telemetry: **1 PASSED, 0 FAILED, 0 NOT VERIFIED**,
0 errors/skips. Он начат только после завершения lifecycle VM и экспорта её logs.
Ни остальные десять lifecycle cases, ни прежние 49 успешных tests не повторялись.
Предыдущий раздел о параллельном сеансе описывает границу первого коммита;
дополнения теперь имеют отдельное native evidence.

PID 1/systemd 259.5-0ubuntu3.4, kernel 7.0.0-34-generic, cgroup v2,
controllers/namespaces и pinned Ubuntu image подтверждены повторным preflight.
Все 16 source SHA-256 совпали с текущими файлами; Python snapshot сохранён
в `work/image-oom-20261016/manager-source/`. Production templates, launcher,
deploy.sh, ImageStorage и SANDBOX_UNVERIFIED gate остались byte-for-byte прежними.

| Параметр | Actual systemd manager | Actual service cgroup |
| --- | --- | --- |
| High | MemoryHigh=536870912 | memory.high=536870912 |
| Max | MemoryMax=805306368 | memory.max=805306368 |
| Swap | MemorySwapMax=0 | memory.swap.max=0 |
| OOM | OOMPolicy=kill | memory.oom.group=1 |

Условие успеха дополнено проверкой этих manager properties. Во время каждого
poll проверяются FDSTORE=1 и FENCE_BUSY; каждый running OOM_SAMPLE сохраняет оба
факта. Пустая выборка tests или отсутствие child OOM case теперь дают отказ.

Получены десять samples с memory.current/peak/events.local/pressure, pids.current,
cpu.stat и процессами. До нагрузки: current=12292096, peak=12300288 bytes,
pids.current=2. Последний живой service sample: current=peak=785162240 bytes,
pids.current=17; local high=2057, max/oom/oom_kill/oom_group_kill=0.
PSI: some avg10=85.44, full avg10=67.23; total some=32263389,
full=23193994 microseconds. Максимум pids.current среди samples — 30, при лимите 64.
Это периодические снимки, а не точная фиксация каждого промежуточного пика.

Service затем удалён manager после настоящего OOM. Уникальный родительский slice
сохранил **hierarchical** memory.events delta: high=2261, max=344, oom=6,
oom_kill=3, oom_group_kill=1. Его собственные memory.events.local остались нулевыми:
нагрузка выполнялась только в дочернем service, не в slice. Финальные local
counters удалённого service недоступны; они не подменяются counters родителя.
Положительные max/oom/kill events этого изолированного subtree и kernel journal
подтверждают memcg OOM. Journal: Result=oom-kill, 52.146 s wall time,
service memory peak 768 MiB. Сохранённый peak slice — 805318656 bytes.

После OOM slice current=176128 bytes, pids.current=0, populated=0; service cgroup
удалена, оба исходных pidfd exited, MainPID=0 и NRestarts=0. Pin active,
FDSTORE=1, fence BUSY до explicit fixture cleanup. После проверки quiescence,
того же device/inode/nlink и bytes только известный fixture CleanUnit дал
FDSTORE=0 и FREE_AFTER_EXPLICIT_CLEAN. Production fence не открывался.

Runner: 1 test за 73.204 s. VM штатно выключилась; wrapper exit 0, serial экспортирован,
удалена только новая volume. Serial: 134821 bytes,
SHA-256 `9ed4ce4b719c9d12ed37914c0bed5991edee18500ef90744c489eb6c7382f1aa`.
`work/image-oom-20261016/manager-verification.json` содержит report, все samples,
manager/kernel limits, journal и fence evidence. Проверены неизменность всех
263 прежних evidence files, шести protected files, 11 сохранённых source files
и AST прежней fd-owner ветки payload, на которую опираются старые native tests.

Последняя матрица остаётся **60 PASSED, 0 FAILED, 0 NOT VERIFIED** в synthetic scope:
49 сохранённых cases и 11 новых, с одним дополнительным успешным child повтором
для manager telemetry. Пять учтённых test runs содержат 61 passed execution и
два исторических failed executions; старые failures не удалены и не объявлены
успешными. Prepare TLS failure остаётся отдельным NOT VERIFIED infrastructure attempt.
Это по-прежнему объединённое evidence, а не повторный full-suite запуск.

**CapBnd=0xe4 у worker остаётся открытым security review**, даже когда
CapEff/CapPrm/CapInh/CapAmb равны нулю. Нулевой bounding set не заявляется;
никакие дополнительные capabilities, ambient capabilities или root-worker
не добавлялись. Этот review обязателен до production acceptance.

Production остаётся **NOT VERIFIED / SANDBOX_UNVERIFIED**: immutable Node/Sharp/
libvips rootfs и exact shop UID/GID/ACL/request/approval; API RO и обратная
same-UID proc/ptrace изоляция; target mounts, binfmt/autofs compatibility,
native storage/durability и disk/inode/quota/retained/I/O/headroom budgets;
power-loss durability и решение G7 для ext4 nobarrier;
crash-point publication/journal/checkpoint, boot ownership, reboot/D-state/manual
recovery/quarantine; Linux application regressions нового HEAD, independent CI
и operational G2–G9 (backup/restore, no-DB rollback, inventory, HTTPS/cache/fallback,
latency/flags и approvals). Эти требования не закрываются synthetic fixtures.
