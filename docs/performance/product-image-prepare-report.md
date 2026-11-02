# Prepare / CONTROL_LIMIT: локальный отчёт

Дата: 2026-11-02. Ветка: `dev/next-20261102`, основа `8b1062c`.
Production `b676aed` не изменялся и не использовался для тестирования.

## Причина

Discovery передавало имя любого элемента products в `productImageId()`.
Каталог `telegram` вызывал ImageManifestError до выбора товарных изображений.
Независимая storage policy launcher также отвергала его перед apply.

Manager заранее создавал placeholder из трёх файлов `{}` + LF, а удалял его
и временный unit только после полного успеха. Поэтому повторные ошибки
подготовки накапливали заявки и failed units. 982 пустые + 19 заполненных
заявок дали 1001 элемент и CONTROL_LIMIT. Это объясняет механизм накопления,
но одинаковая ошибка всех 981 units не доказана: журнал исследован для трёх.
Разницу 981/982 нужно классифицировать отдельно, без предположения о соответствии
каждого unit каждой заявке.

## Исправление

- Python prepare/apply и Node discovery разрешают ровно соседний каталог
  `telegram/`: root:root 0755, без ACL/xattrs, symlink и вложенных mounts,
  на файловой системе источников. Image runner не обходит его содержимое.
- Остальные элементы обязаны быть каноническими обычными UUID.webp с одной
  ссылкой. Неизвестные файлы и каталоги, symlink, hardlink и небезопасные mounts
  вызывают отказ. Проверки снапшотов при encode/publish сохранены.
- Prepare не монтирует файлы apply или broker, поэтому placeholder больше
  не нужен и не создаётся. FD store отключён только у prepare.
- Перед очисткой своего quiescent unit manager сохраняет точные байты unit,
  manager state до/после остановки, JSON journal и SHA256; выполняет fsync
  файлов и каталогов evidence. Без доказательств или при подмене unit очистка
  запрещена. Reset выполняется только для failed unit: успешный inactive unit
  мог уже выгрузиться из systemd. После удаления своего unit выполняется reload.
- CONTROL_LIMIT сохранён, включая отказ при 1000 существующих заявках для
  резервирования места под настоящую apply-заявку. Ранние ошибки закрывают
  локальный дескриптор fence. Чужие locks, retained FDSTORE и pins не очищаются.
- Старые заявки автоматически не удаляются и не возобновляются. Отдельный
  [runbook](product-image-prepare-recovery.md) требует снимки, классификацию
  владельцев, quiescence, согласованные allowlists, карантин и квитанции.

## Telegram и границы расследования

Точное происхождение production-каталога по локальному Git и предоставленным
stat-фактам не установлено. Отсутствие строк в Git не доказывает отсутствие
потребителей. HTTP static handler в `8b1062c` и `b676aed` допускает вложенный URL
`/uploads/products/telegram/<basename>.jpg`. Регрессия проверяет JPEG GET/HEAD
и соседний товарный WebP. Текущие Telegram JPEG derivatives создаются в памяти,
chat media лежат отдельно. Это не исключает старые сообщения, DB/JSON-поля,
незакоммиченные scripts, прежние releases, proxy aliases и внешних клиентов.
Их read-only аудит указан в runbook. Удаление или перенос Telegram не предлагается.

## Проверки

| Проверка | Результат |
| --- | --- |
| Python portable `test_*.py`, Windows | 67: 39 passed, 28 native/VM skipped |
| Python `*_test.py`, Linux container, final | 29: 21 passed, 8 VM-only skipped |
| Vitest runner + HTTP + Telegram photo/catalog, Windows | 124 passed, 7 Linux-only skipped |
| Discovery Vitest, Windows | 3 passed, 2 Linux-only skipped |
| Linux artifact Vitest: discovery, HTTP, registry, upload | 77 passed, 0 skipped |
| Telegram gateway Vitest | 87 passed |
| Node Telegram command scripts | 6 passed, mock transport |
| `pnpm typecheck`, все пакеты | passed |
| `pnpm lint`, все пакеты | passed |
| `pnpm build`, все пакеты | passed, exit 0 |
| Linux-native systemd acceptance, disposable VM | 20 passed, 0 skipped, 0 errors/failures |

Первый Windows-прогон runner имел один timeout 15 секунд при параллельной сборке.
Повторный прогон без изменения timeout прошёл полностью. Первый VM acceptance
выявил ошибку reset уже успешного выгруженного unit после успешного apply.
Она исправлена условным reset только failed unit и отдельной регрессией;
финальный acceptance прошёл в новой VM. Исходный failed log сохранён.

Финальный `PRODUCTION_RESULT`: canary, newUploadDiscovery, realWebpDecoded,
telegramPreserved, originalsUnchanged, repeatNoWrites, immutableArtifact,
prepareFailureRecovery и fenceReleasedAfterQuiescence — все `true`.
Реально декодированы WebP шириной 192/384/640. Среда: systemd 259.5,
kernel 7.0.0-34-generic, cgroup v2. Проверено совпадение всех исходников с обоими
source manifests: Linux artifact и финальной VM. Wrapper завершился с exit 0,
выгрузил serial log и удалил только собственные VM container/volume.

Linux Python проверки владельцев используют CHOWN/DAC_OVERRIDE только внутри
временного контейнера, с read-only checkout, без сети и host cgroups. Настоящий
systemd запускается исключительно в новой networkless QEMU VM.

Регрессии покрывают allowlist Telegram, права/владельца/ACL, symlink, hardlink,
неизвестные элементы, вложенные ro/rw mounts, 1001 и ровно 1000 старых заявок,
сохранность 19 заполненных заявок и fence inode/bytes, повторные ошибки,
отсутствие новых placeholders, checksum evidence и отказ от удаления при ошибке
evidence или подмене unit. Модель восстановления переносит только заранее
известные fixture placeholders в карантин и проверяет повторное чтение checksum;
это не утилита очистки production. VM отдельно проверяет systemd lifecycle,
восстановление после отказов и Sharp decode реального WebP.

## Доказательства и воспроизведение

Локальные логи в игнорируемом `work/` содержат synthetic fixture данные.
Production evidence в Git не добавлено.

- `work/regression-vitest.log` — повторный прогон 124 tests.
- `work/python-portable.log` — portable Python.
- `work/build-check-final.log` — monorepo build с exit 0.
- `work/linux-artifact-6d2e2b08a0754a4fa0b1ffe0e26a6fc6/` — source manifest,
  build.log, receipt, immutable rootfs и JSON Vitest report.
- `work/image-application-84a00963b2ab46129322f86652ee7be6/` — финальный snapshot
  Python/units, runtime isolation inspection, acceptance result и serial log.
- `work/image-application-989ed7a2dbd04aac8eea3b4be293d85f/` — предыдущий failed
  acceptance, выявивший GC/reset race. Linux unit tests повторены после исправления.

Rootfs SHA256:
`5ef2c68d911b3183ec350d754eddc06144010aa94a5ba5a0add7d23c729a1feb`.
Manifest SHA256:
`7b0911d0b4de32699fe4b01586529fc0a2bdc6ca9540700a53613af8c7181f0f`.
Runtime: Linux amd64, Node 24.20.0, Sharp 0.35.4, libvips 8.18.6.

SHA256 финального VM `result.log`:
`a6160f156078a87c88d0db086d777298720db3f5712f13c003799064fc5cd41b`.
SHA256 финального VM `serial.log`:
`a0a3797c1675a7d67de03e0ef4ec114738e34b94a157ee9f7c3bf1c711773bdd`.
SHA256 финального VM `source.json`:
`8e31dd3bc9ef5ca67fcd95771cfceea8155eac69d4174d9880dffa2db1cac64e`.
Остальные checksum логов записаны в `work/image-prepare-checksums.json`.

Из корня checkout:

```powershell
python -B -m unittest discover -s deploy/image-runner -p 'test_*.py' -v
pnpm.cmd --filter api exec vitest run data/product-image-production/discovery.spec.ts data/product-image-production/runner.spec.ts src/product/image-static.spec.ts src/telegram/photo.spec.ts src/telegram/catalog-photo.spec.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build
python -B deploy/image-runner/artifact_host.py --build
python -B deploy/image-runner/application_host.py --artifact work/<new-linux-artifact>/artifact --production-only
```

Для Linux Python lifecycle tests использовать `python -B -m unittest discover
-s <readonly-checkout>/deploy/image-runner -p '*_test.py' -v` в disposable Linux
контейнере либо соответствующий acceptance. Discovery и HTTP tests включены в
Dockerfile.artifact. Новые source-файлы перед упаковкой должны быть в Git index:
упаковщик намеренно использует whitelist из `git ls-files`.

Полный исторический OOM/security/API/DB acceptance в этой задаче не заявляется;
выбранный scope фиксируется JSON отчётом VM. Живые production DB, Telegram API
и журналы не использовались. Merge, push, deploy и production recovery не
выполняются. Изменение предназначено для отдельного локального commit и review.
