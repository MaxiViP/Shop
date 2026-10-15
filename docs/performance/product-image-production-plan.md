# KorzinaMarket: production image backfill и безопасное внедрение — этап 5А

Дата: 2026-10-15. Статус: технический план для отдельного согласования; production
backfill пока **NO-GO**. Этот документ не является разрешением выполнить описанные
операции. В этапе 5А изменяется только документация: runner, units, env, Nginx,
Prisma, БД и production storage не изменяются; команды на VPS не выполняются.

## 1. Исходные данные и границы проверки

Изучены корневой [AGENTS.md](../../AGENTS.md),
[PR #8](https://github.com/MaxiViP/Shop/pull/8),
[deploy.sh](../../deploy/deploy.sh), [deploy README](../../deploy/README.md),
[API unit](../../deploy/shop-api.service), [web unit](../../deploy/shop-web.service),
[chat cleanup unit](../../deploy/shop-chat-cleanup.service) и timer,
[Nginx template](../../deploy/nginx.conf), исходники и документы
[storage](product-image-storage.md), [тестового CLI](product-image-backfill.md),
[API](product-image-api.md), [frontend](product-image-frontend.md),
[A/B](product-image-performance.md), [ревью/Linux CI](product-image-review.md).

| Факт | Основание и предел достоверности |
| --- | --- |
| PR #8 head `c30f15086b2f43b4ad656196ddba992b63d90f48`; локальный HEAD совпадает | Локальный Git и read-only GitHub API. Последующий runner потребует отдельного review/commit; CI этого head не проверяет ещё не написанный runner. |
| Linux image CI, Checks и Checkout E2E успешны на PR #8 | Проверены GitHub check results: [image](https://github.com/MaxiViP/Shop/actions/runs/38745367316/job/116457485173), [Checks](https://github.com/MaxiViP/Shop/actions/runs/38746869994/job/116462693717), [Checkout E2E](https://github.com/MaxiViP/Shop/actions/runs/38746870222/job/116462696158). Старые незавершённые gates из документа ревью не описывают текущий head. |
| Production checkout — `main` `238710e`; PR #8 не развёрнут | Сообщено владельцем. Удалённый checkout в этапе 5А не проверялся. |
| Ubuntu, API `shop`, UID 997, ext4; native hard links/no-clobber, rename, file/directory fsync, O_NOFOLLOW, чтение 0600 прошли | Сообщённые результаты VPS. Они подтверждают эти примитивы, но не cgroup containment, recovery runner или сохранность при потере питания. |
| ext4 использует `nobarrier` | Сообщено владельцем. Flush/FUA, volatile caches гипервизора/носителя и power-loss guarantees не подтверждены. |
| Настоящие systemd drop-ins, HTTPS locations и наследуемые cache directives | Не проверялись на VPS. Файлы репозитория — ожидаемая основа, не доказательство effective configuration. |

Повторные Lighthouse, A/B, браузерные серии и Linux-тесты в этом этапе не нужны.
Успешный Checkout E2E не означает production заказов или разрешения менять БД.
Деньги, цены, скидки, авторизация, заказы, доставка и business settings вне scope.

## 2. Обязательные блокирующие условия

Перед production apply должны быть закрыты G1–G7, G9 и предварительная HTTP
часть G8; latency часть G8 закрывается в отдельно одобренном API canary перед
frontend rollout. У каждого решения нужны владелец, дата и ссылка на evidence.
Отсутствие обязательных для стадии данных означает NO-GO, а не default allow.

| Gate | Что блокирует переход | Требуемое подтверждение |
| --- | --- | --- |
| G1 — реализация | Production runner ещё не существует; тестовый CLI не подходит | Отдельно согласованные реализация/review и Linux CI на точном новом head, включая fault injection и cgroup/crash checks из раздела 10. |
| G2 — deploy без БД | `deploy.sh` безусловно вызывает `prisma migrate deploy`, обновляет main до текущего remote head, заменяет units и делает in-place build | Отдельно рассмотренная процедура с зафиксированным SHA, выключенными флагами, без migrations/seed/DB writes и с проверенным возвратом старых build artifacts. Запуск нынешнего скрипта целиком для этого rollout запрещён. |
| G3 — исходники и backup | Нет принятого inventory/hash baseline и проверенного восстановления originals | Подтверждённая защищённая копия originals вне VPS и restore на изолированном стенде; frozen inventory выбранной партии. Не создавать/восстанавливать production backup по этому документу автоматически. |
| G4 — пути и доступ | Не подтверждены effective roots, UID/GID, ACL, ancestors и mount namespaces | Read-only audit; затем отдельно разрешённые scratch проверки от UID 997 в будущих sandbox profiles. API читает 0600/0700, runner не может писать originals, Nginx не видит private state. |
| G5 — ресурсы | Нет проверенных hard limits всего дерева и бюджета свободного диска/памяти | cgroup v2 containment, конечные runtime/stop limits, kill всех descendants, budget с запасом API/SSR/БД, byte/inode admission и наблюдаемые stop thresholds. При недостатке ресурсов не повышать лимиты автоматически. |
| G6 — writers и recovery | Не согласованы единый admission fence, запрет concurrent deploy и восстановление locks | Инвентаризация всех publishers; доказательство quiescence; протестированная процедура lock quarantine под fence. Неизвестные locks остаются BUSY. |
| G7 — питание/ext4 | `nobarrier`; успешный fsync не доказывает power-loss durability | Документированное решение по storage guarantees/барьерам из раздела 9 и проверенный backup/restore. Без него production apply блокируется. |
| G8 — HTTP/latency | Не проверены effective HTTPS cache/fallback и стоимость registry на целевом storage | Контрактные проверки на стенде; до включения frontend — ограниченный production canary API с принятыми latency/error thresholds. Gate закрывается поэтапно: backfill при обоих флагах off не требует включать API заранее. |
| G9 — полномочия и откат | Нет отдельного разрешения на конкретное изменение production | Утверждённые SHA, inventory digest, batch/limits, окно, ответственный, stop/rollback procedure. Разрешения на deploy, apply, flags и recovery независимы. |

Ни один gate не требует менять бизнес-логику или schema. Общая зелёная CI не
закрывает эксплуатационные gates. G7 нельзя закрыть ещё одним успешным `fsync`.

## 3. Классы операций и требуемое согласование

В этой задаче разрешены только локальное чтение, GitHub read-only, запись этого
документа и один локальный documentation commit. **Ни одна строка ниже не означает
выполненную или разрешённую сейчас операцию на VPS.**

| Класс | Будущие операции | Ограничения и отдельное разрешение |
| --- | --- | --- |
| R — read-only | Проверить SHA/status checkout, версии Node/Sharp/libvips/systemd/kernel, `systemctl cat/show`, mount options, `stat`/`namei`/ACL, доступные bytes/inodes, cgroup controllers; изучить effective `nginx -T`, headers и существующие метрики | Отдельно согласовать read-only VPS сеанс; ограничить частоту/объём. Не выводить secrets, raw env или неотредактированный Nginx config в отчёт. Чтение может дать I/O нагрузку и atime. |
| R — inventory/dry-run | Прочитать заранее экспортированный inventory и originals/READY, вычислить SHA-256, вывести отчёт в stdout без создания state, locks и cache | Предварительно согласовать нагрузку. Если operator сохраняет stdout в файл на VPS, это уже запись класса T/P по месту назначения. Не называть сохранение inventory полностью беззаписной операцией. |
| R — необязательный DB export | Только отдельно одобренный bounded SELECT из product/image records, без пользователей/заказов, в read-only transaction/роль с statement timeout | Сам runner не получает DB credentials. Можно передать готовый экспорт с известным происхождением; никакого Prisma CLI, migrations, seed или изменения ролей в этой задаче. Создание роли/export file — отдельные изменения. |
| T — тестовые записи | Изолированный стенд/clone; отдельно одобренный новый scratch subtree на том же ext4; копии фото, mode/link/fsync/fault/kill tests; bounded private tmp | Никаких hard links к originals: только обычные копии. Scratch вне трёх live roots, вне public routing; UID 997, лимиты и явный список путей. Даже scratch на VPS требует разрешения, потому что расходует общий диск/CPU. Не делать reboot/power-cut live VPS. |
| P — provisioning/deploy | Создать variants/state/control roots; установить runner artifact/unit/drop-ins; поменять routing/env; merge, deploy/restart/reload, установить/изменить quota или mount options | Отдельное подтверждение конкретного diff/процедуры перед каждым видом изменения. Не менять owners/modes существующих originals рекурсивно. |
| P — backfill/recovery | Записать scope/journal/checkpoint/variants/READY; resume; остановить/kill production unit; изолировать lock; удалить любой retained file | Apply, resume и ремонт требуют отдельного разрешения на run/batch. Безопасный stop должен входить в это разрешение заранее; он не разрешает unlock/GC. Удаление originals исключено. |

Логи systemd/journald и HTTP access logs тоже создают записи инфраструктуры.
«Read-only» здесь означает отсутствие мутаций данных pipeline/БД; при требовании
нулевых физических записей нужен изолированный snapshot, не работающий магазин.

## 4. Директории, UID и effective systemd configuration

| Назначение | Предлагаемый абсолютный путь | Доступ и layout |
| --- | --- | --- |
| Originals | `/var/lib/korzinamarket/uploads/products` | Существующие файлы, владелец и режимы сохраняются. `UPLOAD_DIR` остаётся этим путём. Runner видит root read-only; ничего не переименовывает, не линкует, не chmod/chown. |
| Variants | `/var/lib/korzinamarket/uploads/product-variants` | Новый root `shop:shop`, UID 997, 0700; производные файлы 0600. Физический layout: `variants/v1/<uuid>/<sourceSha256>/<bound>[-<outputSha256>].webp`. |
| Private state | `/var/lib/korzinamarket/uploads/.product-image-state` | Новый root/подкаталоги 0700, файлы 0600, UID 997. `locks/`, `work/`, `ready/`, `runs/`; не public/static root. |
| Inventory/control | Отдельный утверждённый private root вне всех трёх image roots, например `/var/lib/korzinamarket/image-backfill-control` | Предлагается заранее выделить operator-owned immutable inputs и отдельные private outputs. Inventory/checksummed approval доступны runner только для чтения; dynamic outcomes находятся в state. Права и parent trust проверяются отдельно. |

Общий parent `uploads` не означает overlap трёх sibling roots. Требуются
absolute/canonical paths без symlinks в **каждом** компоненте, trusted ancestors,
проверенные ACL и отсутствие посторонних writers/неожиданных mounts. Сохранить
root dev/inode при открытии и перепроверять перед операциями. State и variants
обязаны иметь одинаковый `st_dev` для native hard-link publication; одинаковый
текстовый prefix этого не доказывает. Inventory не размещать внутри state.

**Отдельный blocker sandbox:** одинаковый `st_dev` недостаточен, если systemd
создал разные bind mounts для state и variants. Linux `linkat` отклоняет разные
mount objects с EXDEV, даже на одном device: это видно в
[kernel v6.8 `do_linkat`](https://github.com/torvalds/linux/blob/v6.8/fs/namei.c).
Успешный shell hard-link probe снаружи unit этого не исключает. Не проектировать
две независимые `ReadWritePaths`/bind mounts как доказанно совместимые с publisher.

Предпочтительный вариант для проверки — один общий RW mount `uploads` в runner
namespace, с RO original subtree и закрытыми/RO chat и всеми остальными sibling
subtrees. Сам common parent должен быть trusted и **не writable для UID 997**
по DAC/ACL, без возможности создавать/переименовывать соседние roots; effective
write scope тогда только variants/state. Это требование к будущему sandbox,
не утверждение о текущих owner/mode `uploads`. Если такая схема невозможна без
изменения production permissions, нужен отдельный reviewed вариант и approval;
не исправлять доступ широким chmod. Проверить link из фактического `state/work`
в variants внутри точного unit namespace, mount IDs и отсутствие writable aliases.
EXDEV — stop, не повод включить copy/overwrite fallback.

Текущий `shop-api.service` запускает Node как `shop:shop`, использует
`ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `UMask=0027` и
`ReadWritePaths=/var/lib/korzinamarket/uploads`. Поэтому предлагаемые roots
попадают в существующее RW исключение, если DAC/ACL/parents разрешают доступ.
`UMask=0027` сам по себе не обеспечивает 0700/0600; новые roots provision отдельно.
Hard-linked outputs сохраняют mode 0600: API с тем же UID 997 сможет их читать;
другой UID — только после отдельно рассмотренной модели доступа, не через 0644.

API registry не пишет по коду, но текущий unit и общий UID **не запрещают** ему
запись в variants/state. Перед rollout спроектировать и проверить в scratch
узкие read-only mounts этих двух roots в API namespace при сохранении штатной
записи originals/chat для существующих upload endpoints. Проверить effective
пересечение с родительским `ReadWritePaths`, отсутствие writable aliases и
невозможность записи из API. Для runner, наоборот, разрешить RW только
variants/state, originals и inventory примонтировать RO; закрыть chat, secrets,
DB sockets и возможность обхода через другой путь к тому же storage. Mount
sandbox не защищает от другого доверенного процесса с тем же UID вне namespace.
Механизм unit-specific mounts описан в
[systemd.exec v255](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml).

Проверить числовой UID и фактический GID, не предполагать GID 997 из UID.
Не менять владельца существующего `products`, permissions родителей или ACL
ради нового pipeline. Несовместимость доступа — stop и отдельный design review.
API должен читать именно live source root: READY с inode/device/mtime fingerprint
копии originals не подходит. Простые bind mounts надо проверить на сохранение
этих identities; overlay/copy/id mapping не считать прозрачными автоматически.

Web unit не имеет RW uploads и не должен получать filesystem-доступ к state:
SSR получает metadata через API. Nginx проксирует `/uploads/` в API и потому
не должен читать файлы 0600 напрямую. Chat cleanup имеет DB/env и другой write
scope; не использовать его service/timer/credentials для backfill.

Будущие параметры API/web (значения для согласования, сейчас не устанавливать):

| Переменная | Deploy/backfill | API canary | Frontend rollout |
| --- | --- | --- | --- |
| `UPLOAD_DIR` | Существующий `/var/lib/korzinamarket/uploads/products` | То же | То же |
| `PRODUCT_IMAGE_VARIANTS_DIR` | Явно `/var/lib/korzinamarket/uploads/product-variants` | То же | То же |
| `PRODUCT_IMAGE_STATE_DIR` | Явно `/var/lib/korzinamarket/uploads/.product-image-state` | То же | То же |
| `PRODUCT_IMAGE_VARIANTS_ENABLED` | `false` | `true` | `true` |
| `NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS` | `false` | `false` | `true` |

Не оставлять variant root по default: default API равен originals и предназначен
для старого двухкорневого layout. API включается только точной строкой `true`;
frontend — boolean/string `true`. Проверять effective flags по поведению API/SSR,
без вывода полного env. Настройка читается при запуске: нужен отдельно одобренный
restart соответствующего сервиса. Не подменять `NODE_ENV=production`.

## 5. Отдельный production runner: контракт будущей реализации

### 5.1. Разделение с тестовым CLI

Сохранить ограничения `images:backfill`: apply только в одном
`OS-temp/korzina-image-backfill-*`, отказ при `NODE_ENV=production`, максимум
50 источников. Не добавлять bypass/force, не подменять TMPDIR/NODE_ENV ради
production, не вызывать внутренний coordinator в обход валидации CLI.

Production entrypoint — отдельный будущий executable/artifact с отдельными
tests и operator approval. Переиспользовать `ImageStorage` и существующий
генератор через их контракты; не создавать второй publisher. Извлечение общей
нейтральной логики возможно только в отдельном reviewed изменении с сохранением
регрессий тестового CLI. В этапе 5А этот entrypoint не создаётся.

Runner не импортирует bootstrap Nest, не обращается к HTTP/БД, не получает
`api.env`, admin/auth/DB secrets и не запускает Prisma, package install или tsx
с writable transform cache. Предпочтителен заранее собранный immutable artifact
с pinned code SHA, lockfile и Node/Sharp/libvips versions; разместить его вне
in-place build tree. Не исполнять загруженные файлы/произвольные shell hooks.

### 5.2. Inventory и dry-run

1. Inventory готовит отдельный read-only exporter или operator из существующего
   подтверждённого экспорта. Сопоставить DB-referenced URLs и файловое наличие,
   выделить missing, external, legacy/noncanonical, duplicates и unreferenced
   originals. Не обходить весь uploads recursive scan с автоматической обработкой
   найденного; orphan файлы не удалять. IDs нужны для аудита, не для DB mutations.
2. Строгий versioned JSONL, newline/UTF-8 validation, ограниченные file/line sizes.
   Для первой версии сохранить верхние bounds тестового формата: 32 MiB файл,
   4 KiB строка. При большем каталоге заранее экспортировать независимые shards
   со списком SHA-256, количеством/байтами; не ослаблять bounds во время apply.
3. Допустимы только canonical lowercase UUID v4/v8 original URLs
   `/uploads/products/<uuid>.webp`. Никаких внешних загрузок, queries, traversal,
   encoded separators, произвольных fs paths. Структурно плохой inventory отклонить;
   негодные URL отдельно посчитать как skipped, никогда не разрешать в path.
4. Bounded read-only snapshot каждого выбранного source: SHA-256, bytes,
   dev/inode/mtimeNs, dimensions/format через существующий verifier. До/после
   чтения сверить fd/path identities и размеры. В inventory/approval фиксировать
   root identities, exact ordered scope, profile, inventory digest и tool SHA.
5. Dry-run — default, без encoder, mkdir, locks, journal, checkpoint, READY и
   восстановления state. Full inspect выполняется в supervised child с теми же
   общими resource limits. Выводит eligible/ready/changed/missing/invalid/busy,
   worst-case disk/inodes и ограничения оценки, без обещания будущей экономии.
6. Operator утверждает **digest конкретного inventory и scope**, batch size,
   roots, artifact SHA и budgets. Apply повторно проверяет digest всего shard,
   включая записи за пределом limit. Расхождения — отказ, не «актуализация» scope.

Не загружать все source buffers в память. Deduplicate точные URL, не добирать
новые записи вместо ready/skipped/failed. Фиксированная первая партия — 1 фото;
после приёмки отдельно 5, затем до 20 и максимум 50 за один approved run.
Concurrency первоначально 1; полный каталог — серия явно выбранных партий,
без daemon/watch, cron и автоматического бесконечного продолжения.

### 5.3. Apply, исходные SHA и строгая публикация

1. Проверить approved roots/owners/mounts/budgets, единый admission fence и
   отсутствие конкурирующего deploy/publisher. Взять owned run lock. Создать
   bounded frozen scope с exclusive create, fsync и private checkpoint.
2. Для каждого source повторно сверить утверждённые SHA/bytes/fingerprint.
   Передать frozen version в `ImageStorage.save()`: проверка под source lock
   обязательна. Изменённый source — `SKIPPED/SOURCE_CHANGED`, новая версия
   обрабатывается только отдельным inventory/run. Никакой записи или восстановления
   original «для совпадения»; никаких hard links от originals к staging/variants.
3. Весь job, включая source/full-decode validation, encode, staging и publication,
   выполнять в supervised job process. Сохранить bounds генератора: input 5 MiB,
   25 MP, edge 16384, до трёх outputs по 2 MiB, profile v1 192/384/640;
   один Sharp thread, ограниченный cache. Parent не делает неконтролируемый Sharp
   decode вне job deadline. Новые limits не означают поддержку новых форматов.
4. Существующий storage создаёт private exclusive 0600 staging, sync/readback,
   SHA/full decode, затем native `link(temp, final)`. При `EEXIST` проверить
   победившие bytes/dimensions/hash. Никогда не overwrite/truncate/unlink final,
   не использовать copy/rename-to-public fallback, не менять содержимое immutable
   URL. Конфликт canonical сохраняется; существующий checksum repair protocol
   допускает новый детерминированный URL. Конфликт repair URL останавливает job.
5. READY публикуется последним: только строгий полный manifest v1 с покрытием
   192/384/640, source SHA/fingerprint и проверенными dimensions/bytes/hashes всех
   физических outputs. Source и owned lock перепроверяются после финальных
   output decodes. Только private READY JSON заменяется atomic rename + dir fsync.
   `READY` на диске или успешный journal record сами по себе не доказывают готовность.
6. Независимый bounded verifier сверяет READY/source/outputs, затем coordinator
   записывает fsynced journal outcome и атомарный checkpoint. Reuse корректных
   outputs сохраняет bytes/inodes/mtime. Ошибки write/fsync/roots/ownership/fence
   прекращают scheduling; неизвестные locks не пропускаются ради throughput.

Проверить source SHA перед и после каждой партии; отличия разобрать как
подтверждённую внешнюю admin-upload mutation либо инцидент. Для первого canary
согласовать отсутствие редактирования выбранных фото на короткое окно. Штатный
upload не участвует в variant lock protocol: не считать его автоматически
остановленным fence runner. При обычном обновлении/удалении original API должен
перейти на безопасный fallback; runner не меняет admin endpoints/бизнес-логику.

### 5.4. Resume и логирование

Private `runs/<runId>/` хранит versioned scope, attempts, run ownership record,
bounded journal и checkpoint. Для первой реализации сохранить caps 256 KiB
scope, 64 MiB journal, 24 KiB record; cap на общее количество attempts/retained
bytes обязателен. Logs в journald — bounded summaries без source bytes, secrets,
пользовательских/заказных данных; primary recovery evidence — private fsynced state,
поскольку journald может rate-limit/drop сообщения.

Каждый outcome включает run/attempt/scope index, tool/profile/inventory digest,
source SHA/bytes, status/error code, output hashes/bytes, duration и ресурсные
счётчики. Завершение партии включает counts, input/output totals, retained bytes,
free bytes/inodes before/after, cgroup peak/OOM/exit/signal и source integrity summary.
Сырые абсолютные пути/host identities остаются в private audit, не API JSON.

Resume принимает только существующий strict run ID и исходный approved scope.
Проверяет artifact/profile/schema, inventory digest, roots dev/inode и journal
prefix offset/hash. Не расширяет limit и не подменяет inventory. Переход на другой
artifact — отдельный compatibility review; не молча продолжать после deploy.
Даже completed entries повторно сверяются с текущими source и READY/full outputs.

Journal/checkpoint updates сериализуются под owned run lock. Writable metadata
должна быть regular, no-follow, с ожидаемым owner и одним hard link; inode/token
перепроверяются. Старый checkpoint с дополнительными полными valid journal lines
восстанавливаем. Неполную **последнюю** JSONL line dry-run только диагностирует;
apply может отсечь её только после проверки ownership/fence/prefix и audit.
Corrupt complete line, чужой hard link или несовпадающий prefix — fail closed,
без truncate/rewrite. Пересоздание потерянного run state требует нового approval.

Предлагаемые exit semantics: 0 — партия завершена, отдельные skipped явно видны;
2 — частичный/остановленный run или source failures; 1 — отказ configuration/state.
OOM/kill остаются failed unit/terminated attempt, никогда green «успех по курсору».

## 6. Hard limits всего процесса и descendants

Реализация должна запускаться только как отдельный system-level service в
cgroup v2, не в SSH shell/nohup и не как child API. В одной ограниченной cgroup
находятся coordinator, все job/encoder children и native threads. Запретить
delegation, привилегии и доступ к writable cgroup/systemd management sockets;
child env — allowlist без app credentials. Double fork/setsid не должны выводить
работу из cgroup. Проверить фактическую принадлежность descendants и controllers,
а не только текст unit. Наследование cgroup и показатели `populated`, memory/OOM
описаны в [kernel cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Ниже **предлагаемый начальный профиль**, не оценка ёмкости конкретного VPS и не
готовый unit. До реализации подтвердить support на установленном systemd/kernel
и бюджет с учётом пиков API, SSR, PostgreSQL, Docker, page cache и других сервисов.
Если такой запас недоступен, использовать отдельный стенд/меньшую партию или
отказаться от apply; не резервировать память за счёт работающего магазина.

| Контроль | Предложение для первого approved запуска |
| --- | --- |
| Process lifecycle | `Type=exec`, direct foreground entrypoint, `Restart=no`, без timer/autostart/resume после reboot; startup timeout 15 s. |
| Hard memory всей cgroup | `MemoryAccounting=yes`, `MemoryHigh=512M`, `MemoryMax=768M`, `MemorySwapMax=0`; проверить реальные `memory.max`, `memory.swap.max`, ancestor limits. RSS sampler/Node heap cap — только дополнительные сигналы. |
| OOM | `OOMPolicy=kill`, проверить `memory.oom.group=1` и group termination; OOM прекращает весь run, оставляет recovery evidence. Не защищать процессы через `oom_score_adj=-1000`. |
| Whole-run wall time | `RuntimeMaxSec=600`, без randomized extra/timeout extension; `TimeoutStopSec=30`, `KillMode=control-group`, `KillSignal=SIGTERM`, `SendSIGKILL=yes`, `FinalKillSignal=SIGKILL`. |
| Per-job time | Deadline 45 s на весь job, включая fs/decode/publish; timeout — stop scheduling и terminate run, с независимым systemd deadline как последним пределом. Никакой Promise.race с продолжающим работу decoder. |
| Parallelism/CPU | Одна активная картинка; ширины последовательно, Sharp concurrency 1/cache 32 MiB. Предлагается `CPUQuota=50%`, `TasksMax=64`, `LimitNOFILE=256`, `LimitCORE=0`; подтвердить достаточность на стенде. |
| I/O и temp | Низкий IO weight, согласованный device-specific bandwidth/IOPS cap при поддержке controller; bounded tmp/staging. `PrivateTmp=true` само по себе не ограничивает объём /tmp или длительность работы. |
| Sandbox | `User=shop`, фактический Group, `UMask=0077`, `NoNewPrivileges`, strict system/home protection, без capabilities/network/DB sockets; RO originals/inventory/artifact, RW только утверждённым outputs/state и bounded temp. |

`RuntimeMaxSec` не ограничивает активацию `Type=oneshot`; поэтому для будущего
runner выбран `Type=exec`, в отличие от существующего chat cleanup. 600 s runtime
плюс до 30 s stop grace и startup — разные интервалы, не обещание «ровно 600 s от
start до отсутствия процессов». Семантика runtime/OOM приведена в
[systemd.service v255](https://github.com/systemd/systemd/blob/v255/man/systemd.service.xml),
memory/CPU limits — в
[systemd.resource-control v255](https://github.com/systemd/systemd/blob/v255/man/systemd.resource-control.xml).
Конечный срок stop и kill всей группы требуют проверки по
[systemd.kill v255](https://github.com/systemd/systemd/blob/v255/man/systemd.kill.xml).

Deadline завершает unit, даже если событие Node timer не обработано. Но SIGKILL
не обещает немедленного выхода процесса, застрявшего в uninterruptible kernel I/O:
до подтверждённой пустой cgroup locks/fence не освобождать и новый run не запускать.
Это storage incident, а не повод продлевать job или снимать lock. Значения лимитов
фиксируются в approved run; при timeout/OOM не повышать их и не retry автоматически.

Обычная остановка: coordinator прекращает scheduling, сигнализирует текущему
job, ждёт его close/отсутствия descendants, проверяет результат, пытается сохранить
journal/checkpoint и освобождает **только свои** locks с проверкой inode/token.
Grace не гарантирует завершение активного job; принудительный kill оставляет
частичные файлы для recovery. Нельзя выпускать source lock, пока child ещё пишет.
После неполной остановки следующий шаг — read-only диагностика раздела 8.

## 7. Нехватка диска, retained state и конкурирующие операции

### 7.1. Disk admission

До любых run-state writes, перед каждым job и перед публикацией/READY проверять
`statfs` на каждом фактическом device: доступные **UID 997** blocks (`bavail`),
inodes, quota headroom, ошибки FS/readonly. Не полагаться на root reserved blocks.
Предлагаемый начальный reserve — большее из 1 GiB и 10% usable filesystem capacity,
плюс согласованный запас для роста БД/WAL, uploads/chat, logs и deploy artifacts.
Резерв нужно посчитать для реального VPS; проценты не заменяют прогноз.

Admission учитывает worst case, а не среднюю экономию A/B: до 6 MiB новых outputs
на source, до 6 MiB private staging на активный job, inventory/journal/checkpoint,
directory metadata, retained прошлых attempts и temp. Консервативно не вычитать
staging bytes за счёт будущего hard link. Inode budget включает все directories,
3 candidates, lock/READY/metadata/temporaries; минимум 1024 свободных сверх
рассчитанного роста партии и операторского резерва. Для tiny shared outputs
оценку сверху не уменьшать без верификации.

Первая версия обязана иметь max batch bytes, max per-run/total retained bytes,
max attempts и cap temp; отказывать **до** исчерпания этих bounds. Добавить запас
на одновременные штатные записи магазина. `statfs` — моментальный снимок, не
reservation и не гарантия от другого writer. Для жёсткой byte/inode изоляции
предпочтительна отдельно одобренная quota только derived/state/scratch subtree
на том же FS; user quota UID 997 затронет также API и не подходит как незаметная
замена. Availability/включение ext4 project quotas не предполагается. Если quota
нет, явно принять остаточный race и уменьшить batch/bytes budget; это отдельное
решение владельца, не заявление абсолютной защиты общего диска.

При ENOSPC, EDQUOT, EIO, fsync failure, mount/root change или пересечении reserve:
stop new scheduling; прекратить публикацию READY, которая ещё не завершена;
сохранить доступную evidence в пределах stop budget, не удалять originals,
публичные candidates или неизвестные private attempts. Если запись отчёта тоже
не удалась, failed unit и повторная фактическая верификация важнее «успешного» log.
Recovery не использует GC как автоматическое освобождение места.

### 7.2. Fence deploy/backfill и trust boundary

Существующий deploy удерживает `/run/lock/korzinamarket-deploy.lock` через flock.
Будущая orchestration обязана исключить deploy и работу runner **на весь срок
живых descendants**, включая принудительную остановку. Нужен reviewed способ
удержания того же fence/передачи FD через trusted launcher с учётом текущих прав;
не менять root-owned lock permissions наугад. Все новые publisher entrypoints
обязаны участвовать в общем admission protocol. Отдельный run lock не заменяет
deployment fence, а flock сам по себе не останавливает неучаствующих writers.

Во время restore, ручного ремонта, chmod/chown, backup с переносом файлов и
смены mount/root runner не работает. Список всех сервисов/ручных publishers
должен быть известен оператору; неожиданное вмешательство — stop. API должен
иметь RO variants/state в своём namespace. Доверенные root/UID 997 процессы вне
него остаются частью trust boundary: portable Node `lstat`/realpath/O_NOFOLLOW
не дают openat2 sandbox против враждебной подмены ancestors. Обнаруженный symlink,
чужой владелец/ACL, подмена inode/dev или alias — отказ, без repair пути.

## 8. Recovery: SIGKILL, reboot, неполный READY и locks

### 8.1. Evidence владельца и запрет stale-lock эвристик

Сейчас image lock содержит random owner token, hostname и PID; run lock тестового
CLI также не доказывает boot/start identity. Production coordination должна
дополнительно иметь fsynced audit-связь run/attempt → systemd invocation ID,
cgroup, host/boot ID, PID + start time/namespace, exact lock inode/dev/token digest
и artifact/scope digest. PID/hostname/mtime по отдельности недостаточны: возможны
PID reuse, другой boot, неполная запись, другой host или действующий publisher.

`ImageStorage.save()` создаёт свой lock внутри. Будущая реализация должна отдельно
рассмотреть минимальную совместимую передачу ownership context/наблюдение acquisition
для audit; **сейчас такого интерфейса нет**. Не менять READY/public schema ради
supervisor. Crash между созданием lock и фиксацией связи оставляет UNKNOWN:
никакая попытка «догадаться» по PID/возрасту не разрешена. Та же политика для
пустого/повреждённого lock и legacy locks без достаточной provenance.

Нормальный owned release проверяет inode/dev и точный token/hash. Для оставшегося
lock после kill/reboot автоматического steal/unlink нет. Сначала read-only
диагностика; для отдельного operator recovery одновременно нужны:

1. Admission fence удерживается оператором; запуск любого publisher/deploy/repair
   заблокирован организационно и технически. Проверены все hosts/namespaces,
   имеющие доступ к storage, а не только один список PID.
2. Известный owner run сопоставлен с immutable audit. Его systemd invocation
   завершён, cgroup и descendants отсутствуют/`populated=0`, helper workers не живы.
   При reboot old boot ID — дополнительный факт, не единственное доказательство.
3. Exact lock path/inode/dev/token всё ещё совпадают; roots/ACL/mount trust intact.
   Собраны scope/journal/READY/staging hashes и установлено, что concurrent writer
   не мог повторно использовать этот path. Любое расхождение сохраняет BUSY.
4. Получено отдельное подтверждение на **конкретный** lock и процедуру. Предпочесть
   no-clobber quarantine в private audit subtree с сохранением bytes/identity,
   fsync затронутых directories и журналом действий вместо безвозвратного unlink.
   Карантин тоже изменение production; обычный runner его не выполняет.
5. Под fence заново проверить source/READY/candidates; только затем разрешить
   новый attempt/resume. Карантин не делает файлы автоматически корректными.

Если owner неизвестен и provenance не восстанавливается, lock остаётся BUSY.
Допустим только отдельный forensic recovery после доказанной полной quiescence
всех writers и нового согласования; этот план не содержит команды массового
unlock. Нельзя удалять locks по `kill -0`, отсутствию PID, времени жизни,
«старому boot», одному `systemctl is-active` или успешному reboot.

### 8.2. Состояние на диске и действие

| Обнаружено после остановки | Безопасное продолжение после закрытия lock/fence gate |
| --- | --- |
| Только scope / lock, outputs нет | Проверить весь approved scope и source versions. Новый attempt под owned lock; не переносить cursor без проверки. |
| Private staging и/или 1–2 public outputs, READY нет | Staging не публиковать вручную. Storage полностью проверяет source/outputs, переиспользует корректные public files и генерирует отсутствующие через тот же no-clobber protocol. |
| Все outputs есть, READY отсутствует/temporary | Наличие трёх имён не READY. Hash/full decode/source recheck, затем обычный storage publish READY последним. |
| READY повреждён/частичен/stale | Нельзя «дописать JSON» руками. Job verifier проверяет всё; storage rebuild под lock. Corrupt canonical outputs сохраняются, используются checksum repair URLs. |
| Строгий READY сохранился, один physical output пропал | Publisher считает полный набор неготовым. API может отдавать оставшиеся проверенные candidates из полного валидного manifest; отсутствующий URL даёт original fallback. Это не разрешение публиковать partial manifest. |
| READY опубликован, journal/checkpoint отстал | Reverify source и полный set. Записать UNCHANGED/verified outcome; не перезаписывать корректные variants/READY и не считать journal первичным источником истины. |
| Torn последняя journal line | Read-only report; отсечение только под доказанным owned run lock/fence после prefix/single-link checks. Corrupt complete record — stop, не «лечить» truncate всей истории. |
| Unknown locks, changed roots/permissions, EIO или filesystem remounted RO | Никакого resume. Инцидент и read-only forensic review; отдельное разрешение на recovery. |
| Original SHA/fingerprint изменился или original исчез | Не восстанавливать/перезаписывать original и не публиковать старый READY. SOURCE_CHANGED; новая версия — новый scope. Восстановление из backup — отдельная процедура. |
| SIGKILL/OOM/reboot/power failure | Никакого automatic restart/resume. Сначала inventory реального состояния, cgroup/lock evidence, source hashes, полный verifier и disk budget; runtime log может быть неполным. |

Не переносить READY с другого host/filesystem как готовый результат: fingerprint
может измениться при копировании/restore, даже при том же SHA. API при несовпадении
должен деградировать к original, а новый manifest создаётся только publisher.
Retained attempts и public orphan outputs не удаляются при rollback/resume.
GC, reconciliation с DB и migration manifests — отдельные будущие задачи.

## 9. ext4 `nobarrier`: предел гарантий и отдельное решение

Native hard links, rename, O_NOFOLLOW и успешные file/directory fsync подтверждают
поведение syscalls на данном окружении. SIGKILL проверяет process-crash recovery.
Reboot с корректным shutdown тоже не эквивалентен внезапной потере питания.
Ни одно из этих наблюдений не доказывает, что данные и metadata переживут power
loss в правильном порядке на VPS с `nobarrier` и неизвестным storage stack.

Kernel описывает barriers как обеспечение порядка journal commits при volatile
write cache; их отключение требует соответствующих свойств storage. См.
[ext4 mount options](https://cdn.kernel.org/doc/html/latest/admin-guide/ext4.html#options).
Нельзя обещать power-loss durability originals, READY, journal или hard-link
directory entries только по успешному `fsync`.

До production apply требуется одно документированное решение владельца:

- Подтверждены end-to-end guarantees провайдера/гипервизора/носителя: сохранность
  write cache при отказе питания, порядок записей и корректность flush/FUA.
  Ответ должен относиться к реальному volume, а не к ext4 вообще.
- Либо отдельно одобрено изменение mount/storage policy, затем проверены effective
  options, путь flush и восстановление на изолированном clone. Изменение fstab,
  remount/reboot и power-fault tests не выполняются по этапу 5А.
- Либо владелец явно принимает остаточный power-loss риск с проверенным внешним
  backup/restore и ограниченной партией. Это exception с ответственным и условиями
  остановки, **не** доказательство durability; такой запуск нельзя описывать как
  power-loss-safe. Без явного решения G7 остаётся блокером.

Производные файлы можно регенерировать, originals нельзя считать восстановимыми
без backup. RO mount runner защищает от его записей, но не от corruption общего
device при отказе питания. Внешний backup обязателен при любом варианте решения.

## 10. Проверки будущего runner перед разрешением production

Тесты ниже — требования к следующему отдельно согласованному implementation
этапу, **не задания запустить их сейчас на VPS**. Linux CI PR #8 и mount probes
не заменяют эти проверки. Fault injection, ENOSPC и power-fault сценарии проводить
на fixtures/clone, не на общем live device с originals/БД.

| Группа | Обязательные regression/acceptance cases |
| --- | --- |
| Guardrails | Тестовый CLI по-прежнему отвергает production/не-temp apply. Production executable отклоняет отсутствующий approval/digest, неверные roots/profile/artifact, unlimited batch, network/DB mode и неизвестные options. |
| Native Linux | Реальные O_NOFOLLOW после race lstat→open, symlinks у source/root/ancestors и writable metadata, no-clobber EEXIST, same-device hard links, directory fsync failure, permissions 0600/0700. На Linux ни одного skip/подмены платформы. |
| Защита originals | RO mount enforced; write/truncate/unlink/rename/hardlink attempts не могут изменить originals. До/после SHA/size/inode/mtime совпадают; учитываются особенности atime/ctime и запрещены aliases через другой mount/path. |
| Metadata hardlinks | Journal/checkpoint/scope/lock aliases, особенно link к original/чужому state, отклоняются до mutation. READY не может появиться от corrupt/partial source/output. |
| Crash ordering | Kill до/после каждого output link, READY rename, journal append, checkpoint rename; READY-before-journal; torn tail. Правильные public inodes/bytes сохраняются, а восстановление не доверяет cursor. |
| Ownership | PID reuse, different boot/host/start time, failed/empty lock write, missing provenance, token/inode replacement, живой child при умершем parent. Unknown owner всегда BUSY; expired timestamp ничего не разрешает. |
| Process tree | Child/grandchild/double-fork/setsid остаются в лимите; memory hog в parent и child, зависший job/decoder, игнорирование SIGTERM, timeout/OOM всей unit. Проверить фактическую пустую cgroup до release fence/locks, отсутствие auto restart. |
| Disk | Недостаток bytes/inodes/quota, external writer consuming reserve, retained/temp caps, EDQUOT/ENOSPC/EIO/fsync error. No READY на непроверенный set, прекращение scheduling, отсутствие cleanup originals/public winners. |
| Read-only режимы | Inventory/dry-run/resume-inspect не создают ни одного pipeline файла/lock, не чинят journal/READY и не генерируют. Hash tree до/после на fixtures, stdout отдельно. |
| Deployment isolation | Fence реально блокирует одновременный deploy/backfill/recovery; artifact не меняется от in-place build. RO originals/inventory и RO API variants/state проверены внутри unit namespaces под UID 997. Hard link state→variants работает в этом namespace; отдельный negative case с разными bind mounts даёт EXDEV без copy fallback. |
| API/frontend совместимость | Все четыре сочетания flags; invalid/missing state, stale source, отсутствующий output; canonical GET/HEAD/304, safe 307/no-store, 404/405; исходные цены/JSON/order contracts сохраняются. Browser checks — только необходимые короткие сценарии будущего изменения, без повторения длинной A/B серии. |

Проверить safe stop/resume и reboot на disposable clone с теми же mount/runtime
свойствами; actual power-fault tests — только согласованный отдельный стенд и
собственная методика. Не подменять такие результаты тестом exception в JS.
После реализации — targeted typecheck/lint/build и Linux regression suites с
жёстким timeout, fixture temp roots и без production secrets/DB. В этом docs-only
этапе достаточно проверить ссылки, содержание, scope diff и `git diff --check`.

## 11. Nginx, immutable URL и fallback

Публичный URL остаётся
`/uploads/products/variants/v1/<uuid>/<sourceSha256>/<bound>[-<outputSha256>].webp`,
хотя physical root теперь отдельный `product-variants`. В repo Nginx `/uploads/`
проксируется в API **с сохранением URI**, не через alias. Сохранить этот путь:
handler проверяет READY/source и перехватывает namespace до generic original static.
Не давать Nginx direct alias на variants или весь uploads parent и не добавлять
static route к `.product-image-state`, `runs`, staging или control inventory.

В template `/api/` имеет `proxy_cache off` и принудительный `no-store`; `/uploads/`
не имеет явной cache policy. До включения проверить active HTTPS server, regex
locations и наследуемые http/server directives. Upstream Cache-Control влияет
на caching, но `proxy_ignore_headers`, `proxy_cache_valid any`, stale/error handling
и header overrides способны изменить результат. Это требует проверки effective
config по [официальному proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
а не вывода из одного location в template.

Начальная rollout policy: без proxy/CDN cache для variant namespace, с сохранением
upstream HTTP cache headers для браузера; API JSON/SSR не должны возвращать stale
srcset. Любой необходимый точечный Nginx diff отдельно одобрить, проверить `nginx -t`
и сохранить действующий HTTPS/Certbot config. Template нельзя копировать поверх
live TLS configuration. Не включать одновременно новый edge cache и image rollout.

Короткий acceptance checklist на стенде и затем на одобренном canary:

- [ ] Успешные verified GET/HEAD дают image/webp, nosniff, strong SHA ETag,
  Last-Modified и `public, max-age=31536000, immutable`; корректные conditional
  requests дают 304 без body после проверки актуальных файлов.
- [ ] Stale/missing variant даёт `307 no-store` к **безопасному canonical original**,
  без ETag/Last-Modified/immutable; absent/unsafe original — `404 no-store`.
  Нет cache-hit/Age для redirect/error и нет отрицательного cache после появления READY.
- [ ] При API flag off namespace даёт `404 no-store`; canonical originals доступны
  по прежним URL/headers. Проверены реальный публичный HTTPS и loopback API.
- [ ] Traversal, encoded/case/normalized aliases и private filenames не достигают
  generic static. К fixture symlink/пропаже READY прибегать только на стенде,
  не портить live storage для проверки fallback.
- [ ] Browser error fallback сбрасывает srcset/sizes, один раз пробует original,
  затем placeholder; нет циклов запросов и ошибок hydration. Main gallery original
  и обычные uploads/chat routes сохраняют контракт.

Immutable URL никогда не получает новые bytes. При изменении encoding policy
нужен новый profile/version, а при конфликте — существующий checksum repair URL.
Не вычищать старые valid outputs при backfill/rollback: старые страницы и клиенты
могут продолжать запрашивать их. Отключение flags/серверный purge не отзывает уже
закэшированные браузером year-long responses. Если исходное фото нужно срочно
отозвать, это отдельная content/security процедура; image rollout не решает
retention cached copies. Не обещать мгновенную видимость новой фотографии у всех
клиентов: у страницы могут сохраняться старые metadata/URL и собственный cache.

## 12. Порядок отдельного согласования и внедрения

Каждая следующая стадия требует evidence предыдущей и соответствующего approval
класса R/T/P. Отдельно утвердить stop authority: ответственный может остановить
approved run при breach без ожидания нового разрешения; это не даёт права unlock,
GC, restore, исправлять env или повторно запускать apply.

| Этап | Действия после отдельного разрешения | Критерий перехода / остановки |
| --- | --- | --- |
| 5А — текущий, локальный | Только этот plan/checklist и documentation commit, без push | Никаких действий на VPS и implementation runner. |
| 5Б — implementation и стенд (T) | Отдельный runner/unit design, regression tests, cgroup/fence/recovery и bounded inventory; стенд с копиями, без production БД | G1, техническая часть G5/G6 закрыты на точном artifact SHA; все новые Linux checks зелёные. Не менять существующий CLI guard. |
| 5В — RO preflight (R) | Проверить actual production SHA, systemd/drop-ins, HTTPS routing, UID/ACL/mount/cgroup versions, storage guarantees, budget, backup/restore evidence; bounded export/hash inventory | G3/G4/G7 закрыты; приняты пороги/окно/ответственный. Без provisioning, env changes и apply. |
| 5Г — scratch acceptance (T) | Только отдельно выделенный private scratch на целевом FS; копии фото и будущий unit sandbox/limit profile | Целевые systemd access, limits, stop/fence и verify проходят. Не повторять уже подтверждённые mount probes без изменения условий; не тестировать ENOSPC/power loss на live общем диске. |
| 5Д — deploy flags off (P) | После отдельного решения о merge/deploy зафиксировать release SHA, dependency/runtime versions; подготовить новые roots, artifact/unit и rollback artifacts; API/frontend flags явно false; deployment без migrations | G2/G4/G5/G6/G9 закрыты. Старый API контракт, original URLs и health работают; в HTML нет variant srcset, namespace off. Runner не стартует автоматически. |
| 5Е — отдельный backfill canary (P) | Сначала read-only dry-run approved inventory в deployment sandbox; затем отдельное apply на 1 source, concurrency 1, hard budgets и fence | 1 полный verified READY, исходный SHA/size/inode/mtime без runner mutations, outputs/READY/headers на стенде корректны; журнал/peak/disk evidence сохранены. API/frontend остаются off. |
| 5Ж — ограниченные партии (P) | После review отчёта отдельно 5, затем 20 и максимум 50; resume только исходного scope по утверждённой процедуре | Нет source integrity/systemic/conflict-repair ошибок, неизвестных locks, OOM/deadline/disk breach. Покрытие и причины skipped известны. Ни autorun всего каталога, ни параллельный deploy. |
| 5З — API canary (P) | Включить только API flag, frontend оставить off; согласованный restart API. Проверить metadata на выбранных catalog/detail URLs, HTTP contracts и private denial, cold/warm latency | G8 закрыт по actual headers и latency; health и бизнес-контракты без регрессий. Default fail-to-original не считать доказательством, что metadata реально работают. |
| 5И — frontend (P) | Включить frontend flag после API приёмки, restart SSR; коротко проверить catalog/home/favorites/gallery, currentSrc, fallback, hydration, payload и error rates | Приняты latency/визуальные/клиентские показатели. Текущие flags глобальные: user/cohort canary отсутствует, не обещать его без отдельной реализации. При проблемах rollback. |
| 5К — наблюдение и дальнейшие партии (R/P) | Следить за API/SSR/storage/client metrics; при необходимости отдельно одобрять следующие bounded scopes | Нет автоматического GC/cleanup, cron, изменения originals или «добора» каталога. Новые uploads пока остаются original до следующего отдельно одобренного backfill. |

### 12.1. Deploy и подготовка отката

Нынешний `deploy.sh` нельзя считать подходящим flags-off deploy: он всегда делает
`prisma migrate deploy`, тянет актуальный main, устанавливает units и строит outputs
на месте с downtime. Его failure trap пытается запустить сервисы, но не возвращает
старые artifacts. Отсутствие image migrations в PR не отменяет этот риск, если в
main появятся другие migrations. Не запускать скрипт с комментированием строк
на лету/ручной подменой env — согласовать reviewable процедуру отдельным изменением.

До deploy иметь проверенную пару old/new API dist + Nuxt output + matching
dependencies/config schema и точные SHA. Не предполагать существование atomic
releases/symlink switch: в нынешнем deploy их нет. Выбранный способ rollback
проверить на стенде; учесть maintenance window. `prisma generate` — build-time
генерация, не migration, но runner её вообще не запускает; production Prisma CLI
в этом image rollout не требуется. DB schema, данные и migration history сохраняются.

### 12.2. Мониторинг и пороги остановки

До API canary получить baseline при flags off на тех же endpoints и похожей
нагрузке. Не устраивать длинную synthetic нагрузку на VPS: использовать существующие
метрики и заранее ограниченное число cold/warm requests. При недостатке мониторинга
сначала отдельно согласовать его, а не включать флаги вслепую.

| Сигналы | Предлагаемое правило до согласования конкретного production SLO |
| --- | --- |
| Integrity/safety | Любая неожиданная source mutation, unsafe path/UID/root change, private HTTP exposure, неизвестный lock, failed fsync/EIO или repair conflict: stop немедленно; security incident может требовать немедленного API off. |
| Backfill ресурсы | Любой OOM/deadline/EDQUOT/ENOSPC, reserve breach или незавершённые descendants: остановить run, не auto retry. Memory peak, CPU/IO pressure, retained bytes и free inodes собирать по каждой партии. |
| API/SSR | Следить за p50/p95/p99 catalog/detail/favorites и SSR TTFB, 5xx/502/timeouts, event-loop delay, RSS/IO. Предложение: не продолжать при p95 >20% baseline и росте >50 ms в двух последовательных 5-minute окнах или breach существующего SLO; при недостатке трафика — ручной review, не «зелёный» вывод. |
| Availability | Любая health failure или устойчивое ухудшение 5xx/timeout относительно baseline — rollback; числовой error budget и окно обязаны быть приняты до включения. Отсутствие запросов не означает ноль ошибок. |
| Image serving | Metadata coverage по approved scope, verified 200/304, частота 307/404 и placeholders, bytes, currentSrc; массовый fallback или отсутствие ожидаемой coverage — stop даже при HTTP 200 оригиналов. |
| Frontend | Hydration/runtime errors, request loops, layout/CLS, LCP/INP и payload size. Не подменять TBT полевым INP: TBT — лабораторная метрика; новое trace исследование — отдельное ограниченное задание. |

Registry добавляет ожидаемое controller enrichment после DB transaction. Cold
lookup читает manifest/source/до трёх outputs и считает hashes; hot entry делает
stat checks. Есть concurrency 4, bounded pending/LRU, TTL 30 s positive/5 s negative,
но **нет hard filesystem I/O deadline на HTTP lookup**. Whole-run cgroup runner
не ограничивает I/O registry в API. Поэтому отдельно сравнить cold/warm responses,
первые запросы после API restart, cache expiry и конкуренцию с variant GET/backfill.
Не запускать новый batch во время первичной оценки API latency. Не повышать
registry limits или отключать проверки hashes ради canary.

Сохранённый [Lighthouse отчёт](product-image-performance.md) подтверждает рост TBT
главной: медиана 496 → 643,2 ms, Performance 44 → 40 при улучшившемся LCP. JS/CSS
bytes одинаковы, HTML увеличился; n=3, последовательная A/B серия и меняющиеся
фотографии ограничивают выводы. Причина TBT **не установлена**. Возможные гипотезы:
дополнительные metadata/srcset/sizes и HTML parsing/hydration, сдвиг расписания
decode/long tasks, вариативность CPU/GC. Server registry I/O может менять SSR timing,
но само по себе не блокирует main thread браузера. Не утверждать общего ускорения
главной и не смешивать Lighthouse TBT с CDP scroll readiness. Повторных серий в
этапе 5А нет; перед широким frontend rollout принять этот риск либо отдельно
согласовать focused trace attribution.

### 12.3. Откат без изменений данных

1. Остановить scheduling backfill и наблюдать завершение unit/cgroup. Stop не
   разрешает удалять оставшиеся locks или файлы; forced stop ведёт к разделу 8.
2. При клиентской регрессии сначала frontend flag false и restart SSR; проверить
   original src без srcset/sizes. Сохранить API/variant serving на согласованное
   grace window для старых HTML/tabs/metadata. Positive TTL 30 s — не срок жизни
   всех клиентов; grace задаётся по поведению и принятой retention policy.
3. При API latency/security проблеме выключить API flag и restart API немедленно,
   если требуется; frontend также выключить. Variant namespace станет 404/no-store,
   старые клиенты используют предусмотренный original retry. Уже cached immutable
   images flags не отзовут; это отдельно учтённый предел rollback.
4. При необходимости вернуть заранее проверенные artifacts/config предыдущего
   release по согласованной процедуре. Не выполнять git reset/force push,
   DB down-migration, seed, restore DB или пересборку вслепую на работающих outputs.
5. Сохранить originals, variants, private state и audit без cleanup. Не менять
   содержимое old immutable URLs и не откатывать storage переименованием originals.
   Повторное включение/repair/resume требует нового решения после диагностики.

## 13. Оценка рисков

Вероятность до implementation/target canary оценивается качественно; критичность
отражает последствия для магазина. Успешные CI/native probes снижают риск ошибок
примитивов, но не отменяют operational failure modes.

| Риск | Вероятность / влияние | Снижение и остаточный риск |
| --- | --- | --- |
| Power loss при `nobarrier` | Неизвестна / критическое для общего storage | G7, внешние проверенные backups. Даже RO originals не изолируют от отказа device; durability без evidence не заявляется. |
| Мутация originals / path escape | Низкая при закрытых gates / критическое | RO namespace, trusted ancestors, native no-follow, SHA/fingerprint и no aliases. Root/неучаствующий UID 997 writer остаётся trust boundary. |
| Диск/inodes/IO мешают API/БД | Средняя / высокое | Worst-case admission, небольшой batch, quota при отдельном одобрении, reserve и limits. statfs без quota не резервирует capacity против других writers. |
| Native memory/зависший decoder | Средняя / высокое | Whole-tree cgroup, job/runtime/stop deadlines, concurrency 1 и испытания OOM/kill. Зависшее kernel I/O требует инцидента, не unlock. |
| Concurrent deploy / неверный rollback | Средняя до G2/G6 / высокое | Fence всей жизни descendants, immutable runner artifact, pinned deploy без migrations, сохранённые старые outputs/dependencies. Нынешний in-place script не даёт atomic rollback. |
| Bind mounts нарушили native publication | Средняя до G4 / высокое | Один совместимый mount для state/variants, реально узкий write scope и link test внутри unit. Shell probe и одинаковый st_dev недостаточны; EXDEV не обходится copy fallback. |
| Unknown lock после crash | Ожидаем при forced kill / среднее для доступности backfill | Fail-closed BUSY и доказанный operator recovery. Возможна ручная задержка, но PID/age unlock не допускается. |
| Private state exposure / Nginx bypass | Низкая после проверки / высокое | Только proxy к validated API, никакого alias parent/state, effective HTTPS audit и access tests. Не расширять permissions ради Nginx. |
| Stale/immutable cached URLs | Средняя / среднее | No-clobber/versioning, no-store errors/fallback, сохранение old outputs и staged flag rollback. Клиентский cache нельзя отозвать flags. |
| Registry latency / hidden fallback | Неизвестна до canary / высокое | Cold/warm p95/p99/coverage, поэтапные flags, stop thresholds; FS lookup deadline пока отсутствует. HTTP 200 оригинала может скрывать неработающий pipeline. |
| TBT главной и client regressions | Наблюдался рост на стенде / среднее | Отделить факт от гипотез, контролировать hydration/payload/client metrics, принять риск или согласовать attribution до широкого включения. |

## 14. Итоговый чек-лист согласования

Отметки ниже заполняет владелец внедрения по фактическому evidence. Их наличие
в документе не означает, что production действия согласованы или выполнены.

- [x] Исходники/deploy/systemd/Nginx/docs и head PR #8 изучены локально/read-only.
- [x] Три GitHub gates успешны на `c30f150`; native VPS probes учтены как сообщение
  владельца, без повторного запуска и без заявления power-loss durability.
- [ ] Согласована отдельная реализация production runner; тестовый CLI guards
  сохранены, новый exact head прошёл Linux/limit/crash acceptance (G1).
- [ ] Зафиксирован approved release SHA и deploy без migrations; old artifacts и
  конфигурация сохранены, rollback испытан на стенде (G2).
- [ ] Originals backup вне VPS проверен восстановлением; inventory/shards/scope
  SHA-256 приняты, original hashes и источник экспорта известны (G3).
- [ ] Actual UID/GID, ACL/ancestors/roots/devices, API read 0600/0700 и RO overlays,
  runner RO originals/inventory, private routing denial подтверждены (G4).
- [ ] Hard memory/time/tree limits фактически действуют; VPS headroom, disk/inode/
  retained/temp budgets и SLO/stop authority утверждены (G5).
- [ ] Все writers известны, deploy fence и recovery доказаны; UNKNOWN locks
  остаются BUSY, отдельная процедура quarantine рассмотрена (G6).
- [ ] По `nobarrier` есть документированное storage решение или явное исключение
  владельца; проверенный backup обязателен, claims ограничены evidence (G7).
- [ ] Effective HTTPS cache/fallback и cold/warm API latency/coverage приняты;
  отдельные решения для API flag и frontend flag зафиксированы (G8).
- [ ] Получены отдельные approvals на provisioning/deploy, конкретный apply scope,
  resume и при необходимости repair; нет общего разрешения «сделать всё» (G9).
- [ ] Canary 1 → 5 → 20 → до 50 прошёл при обоих flags off; источник не изменён,
  полный READY verified, journal/resources/retained state учтены.
- [ ] API включён отдельно и принят; только затем принято frontend включение,
  включая известный TBT риск главной и ограничения immutable-cache rollback.
- [ ] После наблюдения отдельно решено, нужны ли новые партии/автоматизация/GC.
  Production DB, schema, originals и бизнес-логика остаются вне backfill mutations.

Результат этапа 5А — план и локальный documentation commit. Реализация runner,
операции на VPS, merge/push/deploy/backfill, env/Prisma/DB изменения этим этапом
не выполняются и не разрешаются.
