# Image runner: disposable Linux acceptance — 5Б-2Б

Основа: `549c016`, ветка `feat/product-image-production-runner`. Контракты
[production plan](product-image-production-plan.md),
[runner](product-image-production-runner.md) и
[sandbox 5Б-2А](product-image-production-sandbox.md) сохраняются.
**Production apply остаётся безусловно заблокирован через SANDBOX_UNVERIFIED.**
Этот harness не устанавливает production units, не исполняет deploy.sh,
не использует магазинные фото, БД, VPS или credentials.

## Изменения и исправления review

- Launcher проверяет CapPrm, CapBnd и CapInh в дополнение к CapEff/CapAmb,
  NoNewPrivs и seccomp. Ранее лишние permitted/bounding capabilities могли пройти
  проверку при допустимом effective set. Регрессии проверяют лишние и отсутствующие
  поля. Allowlist самого unit не расширена.
- Preflight требует disposable marker, root, настоящий PID 1 systemd ≥258,
  cgroup v2, controllers memory/cpu/pids, доступные PID namespaces и успешное
  реальное создание mount/PID namespace. Marker и env opt-in — полномочия для
  fixture-тестов, а не доказательство containment.
- На гостевой ОС обнаружены stacked boot mounts. Host preflight проверяет
  непосредственно cgroup mount; строгий запрет stacked/unsafe mounts внутри
  runner остаётся прежним. Отдельная регрессия проверяет обе границы.
- В unit выявлены inherited stacked binfmt_misc mounts. Доступ к binfmt_misc
  сначала закрывался InaccessiblePaths; последний прогон до разрыва и новый
  `image-acceptance-1f5781aeebff45a6a185954f37b1a28f` доказали, что ни он, ни
  дополнительный norbind `/proc/sys` не устраняют скрытый RW binfmt mount.
  Прогон `image-acceptance-38493a6dd3034abea12f87385973d835` подтвердил тот же
  отказ даже с пустым RO tmpfs. Эти попытки сохранены; norbind/4K tmpfs из final
  template убраны. После marker/root/systemd preflight harness останавливает и
  runtime-mask только три binfmt units новой VM: automount, systemd-binfmt.service
  и mount. Требуются actual LoadState=masked, ActiveState=inactive и отсутствие
  binfmt mounts в guest mountinfo; значения включаются в report. Это явное условие
  fixture OS, не обход проверки runner и не разрешение менять target host.
  Production template сохраняет обязательный InaccessiblePaths; minimal rootfs
  содержит mountpoint. Native probe требует RO/noexec/nosuid/nodev, mode 0000,
  пустоту и отказ доступа worker. Запрет STACKED_MOUNT не отключается и не фильтрует
  скрытые RW записи. Сборка mount namespace описана в
  [systemd 259 namespace.c](https://github.com/systemd/systemd/blob/v259/src/core/namespace.c).
- После подготовки binfmt гостя обнаружен следующий fail-closed отказ:
  UNEXPECTED_WRITABLE_MOUNT. PrivateDevices может переносить mqueue/hugetlbfs из
  host `/dev`; image worker эти API не использует. Добавлены обязательные
  InaccessiblePaths для `/dev/mqueue` и `/dev/hugepages`, без расширения RW allowlist.
  Native probe проверяет RO/noexec/nosuid/nodev, mode 0000, пустоту и отказ доступа
  worker для обоих путей. Полный fixture mountinfo выводится в serial evidence,
  чтобы последующие отказы можно было оценить по actual topology.
  Run `image-acceptance-63e9d24ce85d4937b98ed039ce24fcbd` подтвердил оставшийся
  RW hugetlbfs; его source snapshot до добавления hugepages guard сохранён и
  сверен с guest digests. Также закрыты host `/dev/shm` и `/dev/pts`, которые worker
  не использует: PrivateDevices сам по себе не доказывает приватность этих binds.
- RootDirectory на systemd 259 автоматически bind-mount manager notify socket в
  `/run/host/notify`. Launcher принимает только два точных systemd пути:
  `/run/systemd/notify` и `/run/host/notify`; прежний широкий startswith заменён
  точным allowlist. Новая регрессия запрещает произвольные/abstract/prefix-lookalike
  sockets. FDSTORE/BARRIER и проверка реального manager FD store сохранены.
  Автоматический bind описан в [systemd.exec](https://github.com/systemd/systemd/blob/v259/man/systemd.exec.xml).
- Read-only proc bind теперь требует точного source root kernel subtree. Ранее
  RO чужой proc root в /proc/sys мог пройти parser; регрессия это запрещает.
  Разрешены только совпадающие RO kernel subtrees, включая реальные systemd binds
  /proc/fs и hostname. PID=1 дополнен проверкой /proc/self=1; чужой proc не принимается.
- После закрытия host mounts предыдущий positive namespace case завершился EPERM
  при запуске worker с `extra_groups=[]`. В template явно задан `PrivateUsers=full`,
  launcher требует это effective manager property, а preflight отвергает systemd
  ниже 258. Native fixture записывает uid_map/gid_map/setgroups, требует
  `setgroups=allow`, отдельный user namespace и пустые supplementary groups worker.
  Capabilities, NoNewPrivileges и seccomp не расширены ради запуска child.
- Старые lifecycle tests только читали CPU/tasks limits. Добавлены настоящие
  CPU hog descendants, рост cpu.stat nr_throttled, ограничение общего CPU time,
  fork до EAGAIN, pids.events и pids.current. MemoryHigh/Max/Swap не ослаблены.
- Для OOM предусмотрен отдельный bounded runtime вместо прежних пяти секунд,
  которые могли завершить unit до достижения memory.max при throttling. Реальный
  запуск подтвердил timeout даже за 60 s на постепенном bytearray payload: такой
  тест не доказывает OOMPolicy. Payload заменён на anonymous MAP_POPULATE внутри
  тех же hard cgroup limits; его результат учитывается только после native запуска.
- Добавлены graceful SIGTERM и double-fork/setsid orphan; descendants закрывают
  fence FD. Все lifecycle cases проверяют manager FDSTORE/BARRIER, pin, reload,
  окончательную quiescence, retained fence и отсутствие restart. Отдельные cases
  проверяют сохранение FD store после daemon-reexec.
- Реальный systemd отказал CleanUnit для failed fixture services. Fixture cleanup
  теперь сначала подтверждает quiescence/identity, делает reset-failed только своего
  unit, повторно проверяет retained pin/store/fence и лишь затем чистит его FD store.
  В production launcher автоматического cleanup/release по-прежнему нет.
- Native EXDEV test читает kernel mnt_id открытых directories через fdinfo вместо
  строгого разбора всех host mounts. Реальные EXDEV/no-clobber assertions сохранены.
- Удалён CPUAccounting=yes, который systemd 259 явно отверг как removed option.
  CPUQuota=50% сохранён; на cgroup v2 accounting доступен автоматически. Enforcement
  проверяется реальными cpu.max/cpu.stat, не отсутствием warning в unit parser.

ImageStorage, publisher, manifests, inventory/approval, test CLI, API и deploy.sh
не менялись. Нет нового механизма WebP publication или способа открыть apply.

## Изолированная среда и воспроизведение

Из корня checkout с локальным Linux Docker daemon:

```powershell
python -B deploy/image-runner/acceptance_host.py
```

На disposable Linux CI команда такая же с `python3`. Запуск host wrapper не требует
sudo. Повышенные привилегии используются только внутри новой гостевой VM.
Не запускать guest acceptance.py/test_systemd.py вручную на VPS или обычном host.

[acceptance_host.py](../../deploy/image-runner/acceptance_host.py) обращается только
к явному локальному Docker endpoint, с новым пустым client config. Remote contexts,
Docker auth, home и весь checkout в контейнер не передаются. Новый UUID определяет
volume, container names и каталог отчётов `work/image-acceptance-<uuid>/`.

[Dockerfile.acceptance](../../deploy/image-runner/Dockerfile.acceptance) содержит
QEMU/TCG tooling, без KVM и без production artifact. Prepare скачивает только
публичный [Ubuntu image](https://cloud-images.ubuntu.com/releases/resolute/release/)
через HTTPS, максимум 1 GiB и 600 s. Закреплён SHA-256:

```text
8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2
```

Изменение release по тому же URL вызывает отказ по digest. Автоматического
обновления pin нет. До скачивания нужно минимум 8 GiB свободного места в fixture
volume filesystem; пользовательские файлы/кеши не очищаются.

[vm.py](../../deploy/image-runner/vm.py) создаёт эксклюзивные qcow2 overlay и seed ISO.
Базовый image не изменяется. Guest получает только выбранные Python fixture files,
два template и текст неизменённого production gate. NoCloud seed передаётся на RO
диске; нет shared host filesystem, SSH-соединения/проброса портов, Docker socket,
API env или DB sockets.
Механизм seed описан в [cloud-init NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html).

QEMU работает в непривилегированном контейнере: cap-drop ALL, no-new-privileges,
readonly root, network=none, 3 GiB RAM/swap=0, 2 CPU, 128 tasks, tmpfs ≤64 MiB.
У guest 2 GiB RAM, 2 vCPU, диск максимум 6 GiB; нет сетевой карты. Ограничение
QEMU — 1200 s и serial log ≤8 MiB. В новой VM пропускается только bootstrap waiter
network-online через systemd credential/drop-in condition; runner units/guards не меняются.
Это механизм [systemd generator](https://github.com/systemd/systemd/blob/main/man/systemd-debug-generator.xml),
не разрешение apply и не attestation. Первые попытки с ожиданием сети не дали
acceptance результата и не учитываются как passed.

В [acceptance.py](../../deploy/image-runner/acceptance.py) каждый skip означает
неуспешный acceptance. Неподходящий preflight даёт NOT VERIFIED/exit 78.
Положительный report требует ноль failures/errors/skips; wrapper также проверяет
единственный финальный guest report и нормальный выход VM. Report содержит
Ubuntu digest и SHA-256 каждого переданного source. CI получает red result
при NOT VERIFIED, а не успешный job с пропущенными проверками.

Cleanup касается только точных UUID fixture containers/volume, после подтверждённого
отсутствия containers и экспорта serial log. Ошибка диагностики не доказывает
quiescence. Неизвестные pipeline locks не чистятся; при небезопасном состоянии
unit/fence сохраняются до уничтожения всей disposable VM.

## Границы проверок

[test_namespace.py](../../deploy/image-runner/test_namespace.py) создаёт отдельный
минимальный Python rootfs из доверенного гостевого runtime, без копирования /etc,
home или application env. Копия service template получает только новые physical
fixture paths и unit names `image-namespace-fixture-*` в `/run/systemd/system`.
Неотрендеренный production path/instance вызывает отказ. Параметры sandbox,
capabilities, memory/CPU/tasks и общего storage mount сохраняются. Для fixtures
сроки короче production: filesystem unit 60 s, stop 2 s; lifecycle tests имеют
собственные короткие deadlines. Production 600/30 s template не меняется.

Синтетические originals и inventory — файлы 0600, private roots — 0700,
fixture identity UID/GID 55000. Реального пользователя shop и данных магазина нет.
[fs_payload.py](../../deploy/image-runner/fs_payload.py) вызывает существующие
process/mount/cgroup/storage validators, затем сбрасывает UID/GID/groups и env.

Положительный case проверяет RO root/originals/inventory, отказ write/truncate/
unlink/rename/chmod/hardlink originals, parent DAC, RW variants/state, отдельные
mount/PID/net/IPC namespaces, запрет AF_INET, foreign proc/ptrace, недоступность
manager socket и синтетических API/DB/Telegram secrets. SHA-256/size/dev/inode/
mtime/uid/gid/mode/nlink originals и inventory сравниваются до/после.

Native state/work→variants link, EEXIST, 0600, readback, file/directory fsync
проверяются внутри фактического namespace. Отдельный case создаёт два bind mounts
одного device, требует admission refusal и реальный EXDEV, без copy fallback.
Ещё один case требует отказ WRITABLE_ALIAS. Unknown lock с фиктивными PID/возрастом
остаётся BUSY и сохраняет bytes/inode/mtime. Это filesystem probes, не второй publisher.

В данной Ubuntu VM `tempfile` создаёт fixture roots в `/tmp`, который является
tmpfs. Это фактические Linux syscalls/mount IDs и native no-clobber/EXDEV/fsync
на RAM filesystem; они не подтверждают persistent target storage, I/O budgets
или power-loss durability. Полный mountinfo сохраняется в serial log.

Lifecycle suite создаёт только новые `korzina-image-sandbox-fixture-*` units и
собственный root-owned deploy-style fence. Существующий deploy body не запускается.
Проверяются kernel cgroup files, whole-tree процессы/threads, memory hog в parent
и child, CPU/tasks pressure, graceful/ignored SIGTERM, SIGKILL, runtime, group OOM,
FDSTORE/pin/reload/reexec и NRestarts=0. Fixture fence освобождается только после
проверки точной identity и пустой cgroup; production recovery этим не реализован.

## Фактические результаты

Последний real-systemd прогон завершён: **FAILED**. Failfast остановил suite на
positive namespace case; незапущенные проверки остаются **NOT VERIFIED**.
Parser tests и offline unit verify не заменяют lifecycle/namespace acceptance.

| Проверка | Результат текущего этапа |
| --- | --- |
| Windows portable Python | После восстановления: 35 passed, 23 skipped (9 native + 3 namespace + 11 lifecycle), 58 cases, 0 failures/errors. |
| Linux Docker native Python | Сохранённый промежуточный run: 41 passed, 14 systemd/namespace skipped, 55 cases; не systemd acceptance и не проверка последней версии template. |
| Existing image suites Windows | Первый run: 252 passed, 13 Linux-only skipped, 4 test timeouts 5 s. Ровно эти четыре tests повторно прошли с прежним timeout, без code/limit changes; 78 остальных в recheck не выбирались. |
| Root typecheck/lint | API, web, telegram-gateway passed. |
| Build | API/gateway passed; web passed при повторе после sandbox EPERM на штатный readlink родителя workspace. |
| Python lint/format | Ruff 0.14.0: check и format --check passed, все 12 Python files. Проверено 2026-10-16. |
| CI workflow syntax | Actionlint 1.7.12: exit 0. Внешние shellcheck/pyflakes не запускались. |
| Linux systemd VM | FAILED: 3 passed, 1 failure, 0 errors/skips, 4 cases; остальные 54 из 58 не запускались из-за failfast. |
| PrivateUsers=full | Native uid_map/gid_map покрывают полный диапазон, setgroups=allow; worker credential transition по-прежнему EPERM. Это не успешный namespace acceptance. |
| Final diff / protected sources | git diff --check passed; production gate, deploy.sh и ImageStorage совпадают с сохранёнными SHA-256. |

## Восстановление после разрыва, 2026-10-15

До повторных тестов проверены Windows processes, WSL и локальный Docker endpoint.
Прежнего acceptance_host.py/Python/QEMU процесса нет; Docker Desktop/WSL работает.
В Docker остался только существующий `shop-db`, без fixture containers. Последняя
Ubuntu VM `image-acceptance-e31d43fca4b544149a64a88d24c4edda` завершила poweroff
в 22:35 МСК, serial/result/cleanup logs сохранены. Её source hashes точно совпали
с исходниками на момент восстановления. Report: FAILED, 4 tests, 1 failure,
0 errors/skips; failfast остановился на positive namespace case с STACKED_MOUNT.
Этот результат не считается успешным acceptance.

Снимок всех 18 незакоммиченных source files, tracked/staged diff и SHA-256
60 прежних evidence files сохранён отдельно в ignored
`work/image-sandbox-5b2b-resume-20261015T193856Z/`. Старые логи не перезаписаны,
сохранённые fixture volumes не очищались. Уже завершённые application,
TypeScript/lint/build проверки не запускались заново: application source не менялся.
Новый VM run нужен для изменённого template; это новая отдельная VM, не повторный
запуск старой VM. Ruff 0.14.0 check/format всех 12 Python files прошёл из прежнего
локального tool cache, без установки зависимостей приложения.

## Восстановление после лимита, 2026-10-16

Ветка `feat/product-image-production-runner`, исходный HEAD `549c016`: 18
незакоммиченных файлов, index пуст. До новых тестов проверены Windows processes,
WSL/Docker, все сохранённые VM reports и source hashes. Активных acceptance
containers/Python/QEMU нет. Последний прежний run
`image-acceptance-ad648f0237304e0990b574e3af293232` штатно выключился и экспортировал
serial/cleanup; FAILED, 4 cases, 1 failure. Восемь source files изменены после него,
включая `PrivateUsers=full`; отчёт этого изменения не проверял. Две сохранённые
fixture volumes оставлены без изменений, существующий `shop-db` не использовался.

В ignored `work/image-sandbox-5b2b-resume-20261016/` сохранены снимок 18 source
files, tracked/staged diff, SHA-256 всех 202 прежних evidence files и protected
source hashes. Завершённые application/typecheck/lint/build проверки не повторялись:
application source, lockfile и deploy.sh не менялись. Ruff check/format прошли
из прежнего локального cache; новый workflow отдельно проверен actionlint.

Недостающая проверка текущих исходников выполнена в одной новой VM:
`work/image-acceptance-8dca51fed5894760bd0659e0af68dafe/`. Ubuntu image digest
совпал с pin; PID 1 — systemd 259.5-0ubuntu3.4, kernel 7.0.0-34-generic,
cgroup v2/controllers и реальное создание namespaces подтверждены. Guest binfmt
units masked/inactive, mounts absent. Единственный финальный guest report и
host result совпадают; все 15 переданных source SHA-256 совпали с checkout.

Три portable acceptance policy tests прошли. Positive namespace case завершился
`PermissionError: [Errno 1] Operation not permitted` внутри `subprocess.Popen`
при запуске непривилегированного worker. Перед отказом native identity evidence:
uid_map и gid_map содержат `0 0 1` и `1 1 4294967294`, `setgroups=allow`.
Следовательно, `PrivateUsers=full` проверен в реальном unit, но сам по себе не
устранил отказ. Точный запрещённый syscall не установлен; расширение capability
или syscall allowlist без отдельной диагностики не выполнялось.

Финал: FAILED, 4 tests за 34.461 s, 1 failure, 0 errors/skips. Failfast оставил
54 проверки незапущенными, включая два отрицательных namespace cases и все 11
lifecycle cases. Они **NOT VERIFIED**, а не passed/skipped. VM штатно выключилась,
wrapper завершился exit 78; serial экспортирован до удаления только нового
fixture volume. Обе прежние fixture volumes сохранены. Serial: 116896 bytes,
SHA-256 `26c4c59dcaf08ef503d10a6c53450df78de78fc828414a6a54ddfec0deded7f6`.
Полный result с source hashes, serial, cleanup и отдельный analysis JSON сохранены
в указанных ignored каталогах; прежние логи не перезаписаны.

## NOT VERIFIED и production blockers

Даже успешный fixture suite не закрывает следующие требования:

- Текущий positive namespace case не проходит credential transition worker:
  EPERM сохраняется при full UID/GID maps и setgroups=allow. Нужна отдельная
  диагностика точного отказа внутри disposable unit и завершённый suite без
  failures/errors/skips. Остальные 54 текущие VM проверки пока NOT VERIFIED.
- Полная цепочка immutable production Node/Sharp/libvips artifact, package/native
  hashes, реальные shop UID/GID/ACL и exact launcher FragmentPaths/request/approval.
  Template-derived Python fixture unit не выдаётся за готовый Node production rootfs.
- API RO variants/state/control и обратный доступ same-UID host API к dumpable
  worker через proc/ptrace. Нынешний API unit имеет широкий RW uploads; runner
  PrivatePIDs не решает обратное направление. Нужен отдельный reviewed boundary.
- Boot/start/cgroup ownership provenance, crash-point publication/journal/checkpoint,
  reboot/manual recovery/quarantine и D-state. Неизвестный lock всегда BUSY;
  автоматического release/restart/resume нет. Reexec не эквивалентен reboot.
- Target storage/mount topology и native link на утверждённом scratch в exact
  future unit, реальные disk/inode/quota/retained/I/O и VPS headroom budgets.
  В частности, host с активными binfmt/autofs mounts остаётся неподдержанным:
  нынешний template/validator отказал на default Ubuntu, несмотря на маскирование
  пути внутри unit. Подготовка fixture guest не доказывает безопасность или
  допустимость такой настройки на production host.
  Нет утверждения power-loss durability, особенно для ext4 nobarrier.
- Linux native application regression suites нового head, independent GitHub CI,
  G2–G9: deploy без migrations и rollback, backup/restore, inventory approval,
  HTTPS/cache/fallback, API latency/flags и отдельные operational approvals.

## Действия для CI acceptance

[Отдельный workflow](../../.github/workflows/image-sandbox-acceptance.yml) имеет
только workflow_dispatch, contents:read, checkout без сохранения credentials,
job timeout 35 min и bounded VM step. Нет secrets, services DB, VPS, timer,
push-trigger или deployment. Текущий этап workflow в GitHub не запускает.

После отдельного разрешения опубликовать reviewed commit и вручную выбрать exact
ref этого workflow на disposable hosted runner. Проверить actual guest preflight,
полный report с нулём skips/failures/errors, source/image digests и serial evidence.
Если host Docker/resources либо guest systemd/controllers/namespaces непригодны,
результат NOT VERIFIED; не применять privileged Docker/host cgroup mounts для обхода.
Оригинальный image-pipeline workflow с Linux application tests остаётся отдельным.

Далее нужен отдельный review blockers, а не автоматическое provisioning/deploy,
production backfill или включение WebP. SANDBOX_UNVERIFIED не снимается этим harness
даже при зелёном acceptance. Production, БД, originals и flags остаются неизменными.
