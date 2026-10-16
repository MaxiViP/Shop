# WebP: production security review — 5Б-3

Исходный HEAD `0e9258a`, ветка `feat/product-image-production-runner`.
5Б-2Б принят в synthetic scope: [64/64 cases](product-image-runner-acceptance-review.md).
Этот отчёт начинает отдельный security review. **SANDBOX_UNVERIFIED сохраняется.**
Production, VPS, БД и originals не используются для проверки.

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
Следующий безопасный шаг — доказать текущую границу дополнительными disposable
exec probes с положительными controls, не расширяя production allowlist.

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
