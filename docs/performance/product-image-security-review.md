# WebP: production security review — 5Б-3

Исходный HEAD `0e9258a`, ветка `feat/product-image-production-runner`.
5Б-2Б принят в synthetic scope: [64/64 cases](product-image-runner-acceptance-review.md).
Этот отчёт начинает отдельный security review. **SANDBOX_UNVERIFIED сохраняется.**
Production, VPS, БД и originals не используются для проверки.

Локальные native probes завершены в коммите `394fa35`: **3 PASS / 0 FAILED /
0 skipped**. Production security acceptance остаётся открытым: API candidate
ещё не согласован, Linux Node/Sharp artifact и target topology не приняты.

## Исходный аудит

| ID | Проверка | Наблюдение по коду | Статус до новых fixtures |
| --- | --- | --- | --- |
| S1 | Capabilities worker | E/P/I/A=0, Bnd=0xe4, NNP=1, seccomp=2, все UID/GID сброшены, supplementary groups пусты. `test_credentials.py` проверяет setuid(0) и capset(CAP_SETUID). | Exec setuid/file-capability helpers и ambient raise ещё не проверены. Нулевой Bnd не заявляется. |
| S2 | API → storage | `shop-api.service` разрешает RW всего uploads при общем UID shop; variants/state 0600/0700 принадлежат тому же UID. | API ещё может быть вторым writer; exclusive runner не обеспечен. |
| S3 | API ↔ runner processes | Runner имеет PrivatePIDs и PrivateUsers=full. Старый probe проверяет только worker → чужой host PID. | Обратные proc/root, ptrace и signals не проверены. Один PID namespace runner не доказывает обратную изоляцию. |
| S4 | Namespace под нагрузкой | Один full run получил worker timeout 20 s, отдельный повтор прошёл без изменения worker/deadline. | Нет повторяемого bounded stress evidence. Увеличение deadline не считается исправлением. |
| S5 | Node/Sharp artifact | `artifact.ts` хеширует source modules/package/lockfile и версии Node/Sharp/vips. Rootfs ещё не собран; запуск фиксированного Node/tsx dry-run описан template. | Нет immutable Linux runtime closure, hashes ELF/.node/.so и проверенного packaging manifest. |
| S6 | ACL/storage topology | Launcher требует root-owned общий parent, private owner UID/GID roots, отсутствие xattrs, RO originals/input и общий mount ID state/work/variants. | Actual target UID/GID/ancestors/ACL/aliases/FS/quota/I/O/durability не проверены. Synthetic tmpfs не принимает production storage. |

Сохранён baseline `work/image-security-20261016T093922Z/baseline.json`:
48 source files и 518 прежних evidence files, без локальных uv caches.
SHA-256 baseline:
`534ec69bf957893e3221be9de5b6130230ee4bfb5a78d395d913b3186660af9a`.
Исходный Git был чистым. Старые evidence и snapshots не перезаписываются.

## CapBnd: что означает текущий профиль

0xe4 — CAP_DAC_READ_SEARCH, CAP_KILL, CAP_SETGID и CAP_SETUID в bounding set.
Это не effective/permitted privileges. Нулевые E/P/I/A вместе с необратимым NNP
нужны для исключения повторного получения прав через exec. Kernel описывает
наследование NNP и подавление setuid/setgid/file capabilities при exec в
[no_new_privs documentation](https://docs.kernel.org/userspace-api/no_new_privs.html).
NNP сам по себе не отменяет уже имеющиеся privileges; поэтому проверки полного
UID/GID и всех capability sets остаются обязательными.

Обнулить Bnd через PR_CAPBSET_DROP при нынешнем профиле нельзя: нужен CAP_SETPCAP,
которого в allowlist нет. Добавление CAP_SETPCAP расширило бы privileges root
supervisor и требует отдельного согласования; автоматически оно не предлагается.
Семантика Bnd, UID drop и CAP_SETPCAP — в
[Linux capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html).
Текущая граница дополнительно проверена disposable exec probes с положительными
controls, без расширения production allowlist; результаты приведены ниже.

## API и общий UID

RO views worker защищают originals от runner; они не запрещают API изменять
state/variants через собственный RW uploads. Обычные 0600/0700 и ACL не разделяют
два процесса с одним owner UID. Для API нужен отдельно принятый read-only view
variants/state с сохранением штатной записи originals/chat.

PrivateUsers=full влияет на kernel ptrace checks. В
[Linux v7.0 commoncap.c](https://github.com/torvalds/linux/blob/v7.0/security/commoncap.c)
проверяется user namespace и capabilities вызывающего процесса. Поэтому возможность
обратного proc/ptrace не выводится только из совпадения UID или наличия PrivatePIDs;
её нужно проверить отдельно. Signals также требуют отдельной проверки.

Конкретный кандидат для review, пока не production configuration:

```ini
[Service]
PrivatePIDs=yes
ReadOnlyPaths=/var/lib/korzinamarket/uploads/product-variants
ReadOnlyPaths=/var/lib/korzinamarket/uploads/.product-image-state
InaccessiblePaths=/var/lib/korzinamarket-image-runner
```

Это дополнение к существующему API unit, а не его замена. Paths должны существовать
до старта. Нужны positive controls RW originals/chat, API reads 0600/0700,
отказ state/variants write/chmod/unlink/link и проверка aliases/proc/ptrace/signals.
После fixture proof потребуется согласование изменения production API policy,
application startup/shutdown/health tests и проверка actual target topology.
Текущий `shop-api.service` не меняется и candidate не устанавливается.

## Artifact и storage: необходимые evidence

До packaging acceptance нужен выделенный Linux Node 24 artifact с точной версией
и digest Node ELF, JS loader/dependency closure, Sharp .node, libvips и его .so
dependencies, Python/systemctl/runtime libraries, account records и source/lockfile
provenance. В manifest фиксировать regular files/symlinks, modes/owners и digests;
проверять отсутствие secrets, setuid/setgid и file capabilities, writable ancestors
и неизвестных runtime files. Версии библиотек и source SHA этого не заменяют.
Build приложения и Windows Sharp не принимают Linux native artifact.

Rootfs должен быть immutable для API/worker, без bind всего checkout, host /etc,
home или credentials. Его создание на target, выбор release/base, account changes,
provisioning и запуск production unit требуют отдельного согласования.

Для storage нужны actual mountinfo/IDs/options, trusted ancestor/root owners и ACL,
полный список writers/aliases, API RO/worker RW scopes и отдельный scratch native
link/fsync/EEXIST test. Метаданные originals не менять ради нового UID/ACL.
Disk/inode/quota/retained/I/O/headroom budgets и power-loss durability, включая
исторический `nobarrier` вопрос, остаются частью
[production plan](product-image-production-plan.md), а не synthetic FS tests.

## Порядок локальных изменений

1. Зафиксировать аудит без повторного запуска принятой матрицы 64.
2. Добавить отдельные fixed-selector security fixtures: privilege regain через
   exec, API/runner boundary с текущим unit и неустановленным candidate.
3. Проверить namespace под ограниченной нагрузкой с прежними security assertions
   и deadlines. Сохранять каждый failed attempt, не выбирать только успешные.
4. Отдельными локальными коммитами фиксировать code/evidence conclusions.
5. Остановиться перед изменением production policy, расширением privileges,
   target reads/writes, deployment или разрешением apply и запросить согласование.

Каждый новый native test работает только в новой bounded networkless QEMU VM.
Старые passed tests повторяются только при изменении проверяемой реализации.
Нет push/merge/deploy/backfill, migrations, изменений VPS/БД/originals.

## Новые native evidence

Принятый прогон:
`work/image-acceptance-856d04eb2a384bdbb03a83e41a9cb1a5/`.
Три cases за 263.777 s, 0 failures/errors/skips. Guest: systemd
259.5-0ubuntu3.4, kernel 7.0.0-34-generic, cgroup v2, реальный namespace preflight.
Ubuntu base SHA-256:
`8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2`.

Driver использует новый overlay/seed, сеть отключена, guest 2 GiB/2 CPU;
внешний Docker ограничен 3 GiB без swap, 2 CPU, 128 tasks, RO root/source,
cap-drop ALL и NNP, без host namespaces/socket/KVM/SSH. Сохранённый base
используется только read-only. Экспорт serial и удаление своего нового volume
подтверждены `cleanup.log`. Другие Docker resources не менялись.

Source hashes всех 20 файлов из guest report совпали с
`work/image-security-20261016T093922Z/candidate-5-sha256.json` и staged content
`394fa35` после нормализации Git CRLF→LF. Structured reports, полный report и
serial SHA сохранены в `accepted-security.json` в этой же evidence-директории.

### S1 — worker capabilities

Все real/effective/saved UID/GID = 55000, groups пусты, E/P/I/A=0,
Bnd=0xe4, NNP=1, seccomp=2. Отказ EPERM получен для capset(0xe4),
setresuid/setresgid(0), setgroups([0]), ambient raise и PR_CAPBSET_DROP без
CAP_SETPCAP. Попытка очистить NNP возвращает EINVAL; identity не меняется.

Exec plain, setuid-root и file-capability Python ELF внутри template-derived
unit сохраняет тот же unprivileged профиль. Helpers — новые root-owned copies
бинарника guest, вне originals; их SHA совпадает с исходным Python ELF.
На suid-capable guest scratch FS positive controls с NNP=0 реально получили
euid=0 либо E/P=0xe4. Отдельные controls на том же FS с одним NNP=1 сохранили
UID 55000 и E/P/I/A=0 без systemd/seccomp/nosuid. Поэтому результат не объясняется
неработающим setuid/file-capability fixture или только nosuid mount.

Вывод ограничен проверенной комбинацией UID/GID drop + E/P/I/A=0 + NNP.
Нулевой Bnd не заявляется. Production Node ELF и target kernel требуют
собственного packaging acceptance. CAP_SETPCAP не добавлялся.

### S2/S3 — API boundary и кандидат

API probe использует текущий `shop-api.service`, сохраняет PrivateTmp и
ProtectSystem, заменяет только identity/exec/paths на disposable fixtures,
исключает env file и зависимости Docker. Это Python kernel/DAC probe, а не
запуск Nest API. Новая nologin identity создаётся только в гостевой VM.

| Операция | Текущий API profile | Candidate |
| --- | --- | --- |
| Чтение state/variants 0600 в roots 0700 | PASS | PASS |
| write/chmod/unlink/rename state/variants | Разрешены | EROFS |
| hard link state/variants → chat | Разрешён | EXDEV |
| Запись synthetic products/chat | PASS | PASS |
| signal permission probe к живому worker (`kill(pid, 0)`) | Разрешён | ESRCH |
| `/proc/<worker>/root`, чтение через proc alias | EACCES | ENOENT |
| PTRACE_SEIZE без записи/interrupt | EPERM | ESRCH |
| runner runtime/control | EACCES | EACCES |

Обратный proc/ptrace доступ уже запрещён текущей комбинацией namespace/kernel
policy в этом guest; уязвимость ptrace по одному совпадению UID не заявляется.
Подтверждены второй writer и signal permission в baseline. Candidate устраняет
эти две возможности в fixtures. API Bnd остаётся штатным, E/P/I/A=0 и NNP=1;
новый API seccomp profile этим изменением не вводится.

ReadOnlyPaths задаёт mount view, не меняет ACL. Linux блокирует изменение
унаследованных RO flags в менее привилегированном mount namespace:
[mount_namespaces(7)](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html).
Это не заменяет аудит alternate mounts/aliases, inherited FDs, mount propagation
и всех writers на target. Производственная policy пока не менялась.

### S4 — bounded namespace stress

Три последовательных запуска существующего positive namespace case прошли под
одновременным guest load: CPUQuota=25% одного CPU, MemoryMax=64 MiB, swap=0,
TasksMax=4. Реальные cpu.max/memory.max/pids.max проверены. Load оставался active
и потребил 35,848,389 µs CPU. Время полных итераций: 48.854 / 47.294 / 45.465 s.

Worker timeout **20 s**, unit RuntimeMaxSec **60 s**, CPUQuota=50%,
MemoryHigh=512 MiB / MemoryMax=768 MiB, TasksMax=64 и security assertions
не менялись. Каждая итерация проверила mount policy, credentials,
native link/fsync/no-clobber, retained fence и неизменность своих synthetic
input/original/unknown-lock fingerprints. Эти три повтора нужны для нового
load scenario; полная старая матрица 64 не перезапускалась. Heavy app builds
одновременно с VM не выполнялись.

Это bounded synthetic evidence, не гарантия произвольной нагрузки или
стабильности production Node/Sharp. Причина прежнего единичного namespace timeout
не объявляется установленной этим успешным прогоном.

### Проверки harness и сохранность

Ruff check/format шести изменённых Python files — PASS. Изменённый portable
selector regression — PASS: security выбирает ровно 3 cases, missing mandatory
child OOM по-прежнему даёт отказ. Нативный прогон также проверяет новый selector.
Frontend/backend/lockfile не менялись; ранее принятые app checks не повторялись.

Прежние 64 accepted cases сохранены; добавлены 3 новых. **67 unique cases —
совокупное evidence, не полный запуск на одном boot или production acceptance.**
Portable selector входит в прежние 64, отдельным новым case не считается.
Все 518 прежних evidence files и 43 защищённых baseline sources сохранили SHA;
результат — `work/image-security-20261016T093922Z/preservation.json`.

Все failed attempts сохранены вместе с соответствующими source snapshots:

| Run | Результат и исправление нового harness |
| --- | --- |
| `0095ccb4bf154aa7868f5522df3aa1b9` | Worker exit 1 до API probe; child stderr потерян. Добавлена bounded диагностика. Причина этого запуска отдельно не установлена. |
| `0364ecd5d50044ec8ee358a452b34cc3` | Ошибочное требование PID=2; фактически PID=3, PPID=1, credentials верны. Проверяются PID=1 supervisor и видимость только supervisor/worker. |
| `47de61dbbf8a467e8f2234c2e57ff441` | API 217/USER: нет guest NSS record UID 55000; cleanup пытался чистить ненастроенный fdstore. Добавлены guest identity и conditional fdstore clean после quiescence. |
| `e0f0c87676b54cbe9e06ebd2f70b5ecd` | API assertions прошли; cleanup вызвал reset-failed у уже GC'd successful units. Reset выполняется только для failed units. |

Первые четыре прогона целиком FAILED и не учитываются как принятые cases;
caps/stress до них не дошли. Полный `--security` принят только в пятом прогоне.
Их prefixes — `work/image-acceptance-`; записи —
`work/image-security-20261016T093922Z/failed-attempt-{1..4}.json`.
Также явно заданы ожидаемые modes новых fixture ancestors, чтобы umask не
делал их недоступными worker. Production permissions при этом не менялись.

## Остановка перед production policy

Проверенный [API candidate](../../deploy/image-runner/api-isolation.conf.example)
не устанавливается deploy.sh и не добавлен в `shop-api.service`.
Следующий локальный шаг — согласовать его перенос в production unit в репозитории.
Установка/restart на target остаются отдельным будущим решением. До этого нужны
existing roots, actual topology/ACL и startup/health/shutdown реального Node/Nest
API; fixture не доказывает его работу как PID 1.

S5/S6 остаются NOT VERIFIED: immutable Linux Node/Sharp/libvips closure и
manifest; actual UID/GID/ACL/ancestors/mounts/aliases/writers; native target storage,
bytes/inodes/quota/I/O budgets, backup/restore и `nobarrier` durability. Также
остаются operational recovery/CI и G2–G9 approvals из production plan.
Этап 5Б-3 полностью не закрыт. **SANDBOX_UNVERIFIED сохраняется.**
