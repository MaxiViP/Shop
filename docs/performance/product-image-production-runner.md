# Production image runner: этап 5Б-1

Локальная реализация поверх `60f76d5` → `c30f150`, в отдельной ветке
`feat/product-image-production-runner`. Базовый контракт —
[production plan](product-image-production-plan.md), разделы 2, 4–10 и 12.
Этот этап проверяет coordinator на изолированных fixture-копиях.
**Production apply безусловно заблокирован.** Это не Linux sandbox acceptance
5Б-2, не разрешение на VPS/backfill/deploy и не свидетельство power-loss durability.

## Архитектура и граница записи

Новый код находится в `apps/api/data/product-image-production/`:

| Файл | Назначение |
| --- | --- |
| `run.ts`, `options.ts` | Отдельный CLI, default dry-run, строгие options, только batch 1/5/20/50, concurrency всегда 1. |
| `model.ts`, `input.ts` | Versioned inventory/approval/scope schemas, bounded input, hashes, roots/source identities, read-only preflight. |
| `artifact.ts` | SHA-256 allowlist исходных runtime modules и lockfile, с версиями Node/Sharp/libvips. CLI не принимает caller-supplied artifact revision вместо проверки файлов. |
| `runner.ts`, `state.ts` | Последовательный coordinator, journal/checkpoint replay, disk/retained admission, full revalidation и stop. |
| `environment.ts` | `requireProductionSandbox()` всегда выбрасывает `SANDBOX_UNVERIFIED`. Нет env/CLI/debug/test override для production apply. |
| `fixture.ts`, `harness.ts` | Только новые OS-temp fixture workspaces. Никакого выбора/adopt существующих roots. Private WeakMap capability привязана к объекту, путям и dev/inode созданного workspace. |
| `runner.spec.ts` | Unit/regression tests с настоящими temp files, hard links, decode и публикацией; fault injection и явно выделенные Linux-only проверки. |

Интеграция добавлена в [API scripts/lint](../../apps/api/package.json),
[CLI typecheck scope](../../apps/api/tsconfig.catalog.json) и
[существующий image workflow](../../.github/workflows/image-pipeline.yml).
Production plan содержит ссылку на этот документ; других runtime/deploy изменений нет.

CLI проверяет отказ apply **до открытия переданных путей**. Даже существующие
approval и утверждения `NODE_ENV`, `INVOCATION_ID` или `IMAGE_SANDBOX_VERIFIED`
не открывают production apply. Экспортируемый `dryRun()` также запрещает apply.
Нет экспортируемого coordinator apply для произвольных roots.

Писать может только `runFixture()` с capability, выданной `createFixture()` в том же
процессе. Factory сама создаёт новые roots, не принимает paths, не принимает
`NODE_ENV=production` и отвергает temp base в `/var/lib`, `/opt`, `/etc`.
Runtime проверяет capability и исходные dev/inode roots повторно. Plain object,
подмена paths/root, symlink/junction и иной approval path не дают полномочий записи.
Через этот механизм нельзя принять существующий production storage за fixture.
Ревью воспроизвело ошибку нового harness: symlink/junction temp base отклонялся
лишь после создания пустого workspace. Проверка всех компонентов temp base
перенесена перед `mkdtemp`; regression сначала упала на реальном junction, затем
прошла и подтвердила ноль созданных файлов через alias. Storage protocol не менялся.
Поддержка resume в coordinator не означает возможность harness adopt после reboot:
fixture capability не сериализуется; operational resume остаётся заблокированным.

Публикация выполняется только существующим `ImageStorage.save()` с frozen source
version. Генератор, WebP profile, manifests и storage protocol не менялись.
Переиспользованы bounded JSONL/private metadata helpers и supervised encoder
из тестового CLI; сам его coordinator, options/guards и executable не изменены.
Нет Nest bootstrap, БД/Prisma, HTTP fetch, API/admin/Telegram credentials.
Encoder child получает прежний allowlist env без app secrets.

## Inventory и approved scope

Inventory — строгие newline-terminated UTF-8 JSONL objects следующей формы:

```json
{"schemaVersion":1,"url":"/uploads/products/550e8400-e29b-41d4-a716-446655440001.webp","source":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":12345,"fingerprint":{"dev":"1","ino":"2","mtimeNs":"3"}}}
```

Значения иллюстративные. Нужны фактические SHA/bytes/fingerprint approved copies.
Максимум 32 MiB/shard и 4 KiB/line **включая LF**. Дополнительный bounded cap —
100 000 records/shard для ограничения dedup map. Любая malformed/schema/UTF-8/URL
строка отклоняет весь shard до публикации; URLs никогда не выбирают arbitrary
файловые пути. Принимаются только canonical lowercase UUID v4/v8 WebP URLs.
Никаких downloads, directory discovery или orphan cleanup.

Читается и хешируется весь shard, включая записи за пределами batch. Exact
duplicates учитываются отдельно и не заполняют scope повторно; конфликтующие
versions одного URL отклоняются даже за пределом выбранной партии. Scope — первые
ровно N unique URLs, где N явно 1/5/20/50; недостающие записи — отказ. Ready/failed
источник не заменяется следующим URL из inventory.

Read-only dry-run выводит proposal в stdout. Это предложение, не автоматически
данное разрешение apply. Approval — отдельный strict versioned JSON document:

- kind `product-image-backfill-approval`, lowercase UUID v4 run ID;
- artifact SHA-256 и точные Node/Sharp/libvips versions;
- fixed v1 profile с quality/alphaQuality/effort;
- три canonical root paths и их dev/inode;
- SHA-256/bytes **всего** inventory;
- exact batch size и ordered entries с source URL/SHA/bytes/fingerprint.

При проверке approval дополнительно нужен SHA-256 самих bytes approval-файла.
Approval/inventory лежат вне всех трёх image roots и не могут совпадать; input
metadata — bounded regular no-follow single-link files. Linux также проверяет
trusted owners и отсутствие group/other write у roots/ancestors/inputs, разрешая
sticky shared ancestor OS temp, но не writable fixture root. Windows POSIX privacy
не эмулируется: реальное ACL/mount подтверждение ещё отсутствует.

Сначала сверяются все параметры и версии **всех selected sources**, full decode,
READY и неизвестные source/run locks; до этого run state не создаётся. Inventory,
approval, artifact и root identities перепроверяются перед работой и metadata
checkpoints, а также после encode перед передачей outputs publisher. Source
перепроверяется existing storage под lock до публикации и перед READY.
Изменившийся/отсутствующий original не «чинится» и не принимается новой версией.

Artifact identity сейчас относится к source checkout: hash runtime modules,
`apps/api/package.json`, `pnpm-lock.yaml` и version strings. Это **не** attestation
собранного immutable Linux executable/native binaries. Packaging и подтверждение
dependency/native artifacts — обязательная часть следующего отдельного этапа.

## State, recovery и stopping

Fixture state имеет layout:

```text
state/
  locks/, work/, ready/                existing ImageStorage protocol
  production-runs/<approvedRunId>/     separate from test CLI runs/
    run.lock
    scope.json                        exact approval + approval byte digest
    journal.jsonl
    checkpoint.json
```

New run directory создаётся exclusively; повторный apply того же run ID требует
explicit resume. Новый run — новое approval, даже для тех же фотографий.
Scope cap 256 KiB, checkpoint 16 KiB, journal 64 MiB / 24 KiB record;
максимум 10 attempts и 50 outcomes/attempt. Cursor/attempt/prefix hash и семантика
record проверяются. Неизвестный SUCCESS вместо допустимого status не принимается.

Resume проверяет scope/inventory/artifact/profile/roots, journal prefix, checkpoint,
source SHA/fingerprint и реальные READY/full candidate files. Cursor и старый
успешный status не заменяют проверку. Correct files и READY сохраняют bytes,
inode и mtime при UNCHANGED. Partial/missing READY/outputs обрабатывает только
storage publisher. Corrupt canonical variant сохраняется, восстановление получает
checksum repair URL; второго механизма WebP publication нет.

READY-before-journal и complete records после старого checkpoint восстанавливаются.
Torn последняя JSONL line в dry-run не меняется; fixture apply может отсечь только
проверенный tail под своим run lock через существующий journal helper. Corrupt
complete record, scope, checkpoint или hard-linked writable metadata — fail-closed.
Никакого массового truncate/reset/GC.

Locks не снимаются по PID, времени, reboot или hostname. Unknown image/run lock
остаётся BUSY даже при intact READY. Нормально снимаются только собственные
locks с проверкой inode/token. Полной provenance boot/start/cgroup для crash
recovery пока нет; operator quarantine/unlock не реализован. Это blocker 5Б-2.

При signal через fixture API scheduler прекращает новые jobs, ждёт активную
операцию и flush/checkpoint, затем освобождает только owned lock. Любая ошибка
источника/IO/state прекращает всю партию, не расширяя scope. Если READY уже
опубликован, а journal write не завершён, отчёт всё равно stopped/failed;
дальнейшая проверка смотрит файлы. Production CLI пока вообще не запускает jobs.

## Реальные пределы этой реализации

Код обеспечивает caps входов/scope/journal/attempts, concurrency 1, strict approval,
source-version checking и no-clobber существующего storage. Read-only dry-run не
создаёт pipeline files/locks, не генерирует и не восстанавливает metadata.
Fixtures сравнивают SHA-256, size, dev/inode, mtimeNs, uid/gid, mode и nlink originals.
Originals не копируются/линкуются в staging: outputs генерируются из bounded buffer.

Disk admission использует реальные `bavail`/inodes, резерв max(1 GiB, 10% FS size),
worst-case output/staging growth и journal/scope reserve. Добавлены cap 512 MiB
retained bytes и 20 000 tree entries с запасом на партию; tree walk bounded,
не следует symlinks и не удаляет файлы. Проверки выполняются перед run state,
jobs, после encode и перед outcome writes. Это statfs/accounting, **не quota или
reservation**: посторонний writer может занять место между проверками.

Supervised encoder имеет прежние 30 s и sampled 512 MiB RSS, Sharp concurrency 1
и cache 32 MiB. Это **не** hard whole-tree memory limit. Parent выполняет bounded
source/output verification, пока без полного job deadline. Запуск всего job в
supervised process, cgroup memory/swap/runtime/kill enforcement, RO originals/input
mounts, deploy fence, actual mount-ID link checks и kill/reboot acceptance — 5Б-2.
Конкретно поэтому production gate пока не может выдать разрешение ни при каком env.
Unit fault injection не является cgroup OOM или настоящей power loss.

Наличие systemd directives/успешных примитивов PR #8 не закрывает эти blockers.
При `nobarrier` claims о power-loss durability по-прежнему запрещены без evidence
и принятого storage решения. Backup/restore, Nginx, API latency и staged flags
остаются gates исходного production plan; текущий этап их не меняет.

## Команды только для fixture harness

Из корня репозитория; harness сам создаёт свежий private OS-temp workspace,
копирует только фиксированные repository photographs и не принимает roots/URLs:

```powershell
pnpm.cmd --filter api images:production:fixture --dry-run --batch-size 5
pnpm.cmd --filter api images:production:fixture --batch-size 1
```

Первая команда проверяет read-only dry-run на пяти копиях. Вторая при достаточном
headroom делает fixture apply одного фото и explicit resume, сверяет originals,
READY/variant inodes/mtimes; workspace оставляет для диагностики. При нехватке
диска она обязана вернуть DISK_LIMIT, не уменьшать reserve и не менять TMPDIR
ради обхода. Это не команда production backfill.

Production CLI intentional apply refusal проверяется автоматическим тестом только
с fixture paths. Команд с live `/var/lib/korzinamarket` roots в этом документе нет.
Не запускать их даже для dry-run на этапе 5Б-1.

## Локальная проверка

Финальные локальные результаты на Windows, Node 24:

| Проверка | Результат |
| --- | --- |
| Новый `runner.spec.ts` | 77 passed, 5 явно Linux-only skipped, 0 failed (82 cases); включает настоящий supervised encoder child. |
| Existing generator/manifest/storage/test-CLI suites | 179 passed, 8 Linux-only skipped, 0 failed (187 cases). Ограничения прежнего CLI сохранены. |
| Всего уникальных cases двух групп | 256 passed, 13 Linux-only skipped; это не результат Linux acceptance. |
| Root `pnpm typecheck`, `pnpm lint`, `pnpm build` | API, web и telegram-gateway прошли. API typecheck/lint повторены после финальной правки harness. Build приложений не является упаковкой отдельного Linux runner artifact. |
| Workflow и docs | Prettier YAML check с сохранением существующего single-quote стиля; локальные Markdown links/UTF-8 и `git diff --check` прошли. |
| Standalone harness dry-run, batch 5 | Passed, 5 eligible, zero pipeline/tree changes, 5 originals verified. |
| Standalone harness apply, batch 1 | Ожидаемый `DISK_LIMIT` до создания run state; native capacity guard не обходился. |

Machine-readable unit reports находятся локально в ignored
`work/product-image-production-unit.json` (совместный прогон) и
`work/product-image-production-runner-unit.json` (финальный новый suite).
Counts выше учитывают финальный suite без суммирования повторных запусков.

Standalone dry-run на пяти копиях прошёл с zero tree changes/original mutations. На локальном
томе около 9,5% свободного места: это ниже настоящего 10% reserve. Позитивные unit
ветки используют явно синтетический total-capacity `statfs` при реальных available
bytes/inodes; все успешные files/links/decode/fsync операции остаются native.
Отдельный standalone harness capacity не подменяет. Это ограничивает утверждения
о результате: успешный mocked admission не является target mount acceptance.

Новый unit suite добавлен в существующий image workflow, но push/Linux CI в этом
этапе не выполняются. Native Linux permissions/symlink/directory-fsync cases явно
skip на Windows; они не выдаются за пройденные. Checks 5Б-2 не запускаются автоматически.

Существующие PR #5–8, main, deploy/systemd/Nginx/env, schema/DB и originals production
не меняются. Локальные unit/typecheck/lint/build не выполняют Prisma migrations
или production backfill. Новые изменения предназначены для одного локального
implementation commit без push.
