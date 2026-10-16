# Image runner: завершение проверки harness после c2e3646

Продолжение [OOM/lifecycle acceptance](product-image-runner-oom.md), ветка
`feat/product-image-production-runner`, исходный HEAD `c2e3646`.
**Production apply остаётся SANDBOX_UNVERIFIED.**

Следующий этап: [production security review — 5Б-3](product-image-security-review.md).

## Сохранённое состояние и изменения

Все найденные незакоммиченные изменения сохранены: обязательный child OOM case,
непустые и точные выборки, manager limits, FDSTORE/fence на каждом poll, диагностика
memory/cgroup/processes и четыре portable regression cases. Проверка quiescence
учитывает удаление cgroup между чтениями; ошибки доступа не разрешают cleanup.
Потеря fence проверяется и на последнем poll; неожиданно полученный probe FD закрывается.
Первоначальная ошибка теста больше не маскируется вторичной ошибкой teardown.

Снимок восстановления: `work/image-acceptance-resume-20261016T073431Z/baseline.json`,
SHA-256 `f0dba030ec2d77eb3658538d63f2748cb2951079473afc46b13ed2fe94b9f9ff`.
В нём закреплены 408 прежних evidence files, включая исходные 263, и 18 source files.
Исходники до правок, первоначальный diff и оба следующих candidate snapshots сохранены
отдельно. Старые logs, snapshots и baseline не перезаписывались.

Добавлен только фиксированный `--namespace-positive` selector для повторения одного
неудачного `test_actual_template_namespace`. Он проходит host → VM → guest;
report содержит selection/count, wrapper сверяет scope. Произвольных test names,
команд, путей и overrides в CLI нет. Без selector остаётся полный suite.

## Сборка приложения

Сохранённые `pnpm typecheck`, `pnpm lint` и `pnpm test` имеют exit 0 и повторно не запускались.
API: 1466 passed, 21 skipped; gateway: 67 passed; web: 399 passed.
Эти application skips не относятся к synthetic acceptance, где skip запрещает PASSED.

Первый `pnpm build` собрал API и gateway, затем Nitro dependency tracer упал на
`EPERM: readlink C:\Users\batti`. Read-only probe подтвердил различие среды:
в sandbox readlink возвращает EPERM, вне sandbox — ожидаемый EINVAL для обычной
директории. Локальный `@vercel/nft` принимает EINVAL, но пробрасывает EPERM.
Повторён только неудачный `pnpm --filter web build` вне sandbox: **exit 0**.
Код приложения, зависимости и Nuxt config для обхода не менялись.

Логи и exit-code receipts: `typecheck*`, `lint*`, `test*`, `build*` в каталоге
восстановления. Первый failed build сохранён отдельно от успешного web build.
Ruff 0.14.0 check/format и изменённый selection regression прошли.

## OOM нагрузка и сохранённые отказы

Восстановленный review run `image-acceptance-6ee442bd0aed472b8a03c6f9693e0f5c`
завершился timeout: peak 747.3 MiB, high=2051, max/oom/kill=0. К концу нагрузки
часть из 32 allocators уже закончила работу; до hard limit оставалось слишком мало
активных allocators. Диагностические снимки заняли суммарно 489226 µs,
максимальный — 60139 µs. Исторический timeout не объявляется успешным OOM.

Нагрузка сохраняет anonymous mapping 1 GiB, THP advice, 32 threads и readv без GIL.
Вместо одного readv на 32 MiB каждый thread fault-ит порции по 2 MiB, с barrier
перед каждым раундом. Потоки не завершают свои участки раньше остальных.
MemoryHigh=512 MiB, MemoryMax=768 MiB, MemorySwapMax=0, OOMPolicy=kill,
memory.oom.group=1, CPUQuota=50%, TasksMax=64 и RuntimeMaxSec=60 сохранены.

Начатый до последнего уточнения full run
`image-acceptance-8b5e25f72e9340b2a332440cd8212715` дал 5 PASSED, 1 FAILED,
58 незапущенных из 64: namespace worker превысил внутренний timeout 20 s.
До OOM он не дошёл. Credentials/EPERM tests прошли. Этот failure и его serial
сохранены; новые прогоны выбирают только проверки, требующие подтверждения.
Namespace timeout, production template и worker security assertions не ослаблялись.

## Точечные native результаты

| Scope | Run | PASSED | FAILED | NOT VERIFIED |
| --- | --- | ---: | ---: | ---: |
| child-oom | `0ed0b589831c4105bc552495d070f8ff` | 1 | 0 | 0 |
| lifecycle | `bdfa2002d3af4f49acffc9a97934238a` | 10 | 0 | 0 |
| namespace-positive | `6ec57256dc4e436b97086fb9e5d79315` | 1 | 0 | 0 |

Child: kernel Result=oom-kill, 27.912 s wall time, peak 768 MiB;
delta high=2776, max=188, oom=4, oom_kill=3, oom_group_kill=1.
MainPID=0, оба исходных pidfd exited, cgroup quiescent, NRestarts=0,
pin active, FDSTORE=1, fence BUSY. Только explicit cleanup известного fixture
после проверки identity/quiescence дал FDSTORE=0 и FREE_AFTER_EXPLICIT_CLEAN.
`oom_kill` не считается числом уникальных process leaders.

Lifecycle: десять cases за 277.433 s. Пройдены CPU quota и TasksMax с реальной
нагрузкой, double-fork/setsid orphan, graceful/ignored SIGTERM, SIGKILL,
hung runtime, FDSTORE после stop/kill, daemon-reload и двух daemon-reexec.
У всех десяти quiescent=true, все исходные pidfd exited, NRestarts=0,
FDSTORE=1/fence BUSY до explicit cleanup, затем FDSTORE=0/fence FREE.
Parent OOM: 29.799 s, peak 768 MiB; delta high=2366, max=309, oom=5,
oom_kill=4, oom_group_kill=1; все три исходных pidfd exited.

Serial child: 121318 bytes, SHA-256
`cb699ed324463e848600d17e28311609d80fd39633dc31996424cb3e5d8b8387`.
Serial lifecycle: 138227 bytes, SHA-256
`01221de02905d87210b247a6092a4df00714e1fee9ed2f176d681cd615b6efdb`.
Serial namespace: 106453 bytes, SHA-256
`a8ad51891cdd7da7709f14c94195e2332ade68cc5e35f066ee34d299f6e550c0`.

Namespace: 1 case за 50.846 s с setup/cleanup, при прежнем worker timeout 20 s.
Подтверждены RO originals/inventory, отсутствие fixture secrets и чужого proc/ptrace,
неизменность unknown lock, native link/fsync/no-clobber, UID/GID/groups/caps,
NNP/seccomp и закрытые binfmt/mqueue/hugepages/shm/pts. Worker и production
template не менялись. Повтор прошёл на отдельной VM без параллельной сборки;
точная причина прежнего timeout этим повтором не устанавливается.

Все три report содержат одинаковые 16 source SHA-256, совпадающие с checkout и
`candidate-v2-source/`. Guest: kernel 7.0.0-34-generic, PID 1 systemd
259.5-0ubuntu3.4, cgroup v2 и реальные namespace probes. Failures/errors/skips=0.

Каждый прогон использует новую VM/overlay/seed; прежний base image подключается
read-only, SHA-256 проверяется до и после копирования. Guest не получает сеть,
SSH, host filesystem или credentials. QEMU/TCG container сохраняет cap-drop ALL,
NNP, read-only root, network none, 3 GiB RAM/swap=0, 2 CPU и 128 tasks.
VM driver сохраняет пределы 1200 s/8 MiB serial. Actual Docker inspect записывается
отдельно для каждого нового прогона. Удаляются только его новые container/volume
после завершения и экспорта serial; старые volumes и shop-db не используются.

## Итоговая матрица и воспроизведение

**64 PASSED / 0 FAILED / 0 NOT VERIFIED** для 64 уникальных synthetic cases:
48 сохранённых, 12 новых native и четыре portable regressions. Это объединённая
матрица, не новый полный прогон на одном boot. Новые native evidence получены для
11 SystemdTests с изменившимся polling и ранее упавшего namespace case. После их
успешных прогонов повторов не было; сохранённые application suites не перезапускались.

Итоговый read-only audit:
`work/image-acceptance-resume-20261016T073431Z/audit-pending-20261016T092306150557Z.json`.
Он сверяет все test IDs, reports, kernel OOM counters, pidfds/fence/cleanup,
actual Docker isolation и source hashes. Подтверждены сохранность 408 прежних
evidence files, 13 неизменённых source files, 11 прежних sources и AST fd-owner
ветки payload. Отдельно проверено сохранение трёх неизменённых portable cases;
изменённый selection case исполнен отдельно после добавления selector.
Старые failures остаются в `retained-failed-attempts.json` и исходных serial logs.

Официальные точечные selectors из корня checkout с локальным Linux Docker:

```powershell
python -B deploy/image-runner/acceptance_host.py --child-oom
python -B deploy/image-runner/acceptance_host.py --lifecycle
python -B deploy/image-runner/acceptance_host.py --namespace-positive
```

В этом продолжении использован сохранённый SHA-pinned read-only base через
ignored `run_pending.py`, без нового скачивания и без reuse overlay/seed.
Не запускать guest entrypoints непосредственно на VPS или обычном host.

## Production blockers

Synthetic fixtures не принимают production packaging или target host.
**Worker CapBnd=0xe4 остаётся открытым security review** при нулевых
CapEff/CapPrm/CapInh/CapAmb. Нулевой bounding set не заявляется.

Остаются immutable Node/Sharp/libvips artifact, actual shop UID/GID/ACL,
API RO и обратная same-UID proc/ptrace boundary, target mounts/budgets и native
storage/durability, crash/reboot/D-state/manual recovery, Linux application
regressions, повторяемость namespace под нагрузкой, independent CI и operational
G2–G9/approvals. Подробности — в
[списке production blockers](product-image-production-acceptance.md#not-verified-и-production-blockers)
и [OOM report](product-image-runner-oom.md).

SANDBOX_UNVERIFIED, launcher, production units, deploy.sh, ImageStorage и БД
не менялись. Нет push/merge/deploy, изменений VPS, originals, reset/stash/clean.
