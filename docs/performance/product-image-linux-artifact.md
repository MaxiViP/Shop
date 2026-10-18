# Linux Node/Sharp artifact и application lifecycle

Продолжение после `34eea63`, ветка `feat/product-image-production-runner`.
**SANDBOX_UNVERIFIED сохраняется.** Работа ограничена локальной сборкой и новыми
disposable fixtures. VPS, production, БД и originals не используются; push,
merge, deploy, reset, stash и clean не выполняются.

Локальный artifact и native application smoke приняты: 71 Linux app tests,
4 verifier tests и один integrated VM case прошли без skips. Код зафиксирован
локально в `4bfba368e1d3953d888fa7925f99416bc6a2dadd`. Это результат fixtures;
production acceptance и throughput для больших supervised inputs остаются открыты.

## Восстановленное состояние

При продолжении Git был чистым. Последний сохранённый receipt —
`work/api-isolation-20261016T110253Z/verified-commit-34eea63.json`, 14:20 MSK 16 октября.
Native API boundary и Windows app regressions завершены; artifact этого этапа
до продолжения не существовал. Активных acceptance/QEMU containers не было.
Docker показывал только существующий `shop-db`; к нему не подключались.
Три старых fixture volumes сохранены, включая cache с проверенным base image.

Baseline: `work/linux-artifact-recovery-20261016/baseline.json`, 782 прежних
evidence files и 78 source files. SHA-256:
`acaeefd9fb39d623b006db1b79ab5cea4f23630ea5d0d05224a36f19bce0a351`.
Матрица 64 и прежние caps/stress/API Python probes не перезапускались.

После остановки по лимиту повторно проверены Git, локальные процессы и evidence.
Последний вызов `application_host.py` для `c62a6cda...` не исполнялся: approval
review завершился ошибкой usage limit до запуска команды. VM/новых логов не было.
Receipt `resume-20261016T140923Z.json` подтверждает сохранность всех 782 прежних
evidence files, совпадение 302 artifact sources и 27 guest sources; защищённые
production files не изменены. Только после этой проверки команда была исполнена.

## Локальный artifact

`Dockerfile.artifact` закрепляет официальный Linux amd64 Node image
`24.20.0-bookworm-slim` по manifest digest
`6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa`.
Публичный CA bundle берётся из pinned Python image существующего VM tooling.
Debian packages загружаются через HTTPS и перечисляются с точными версиями
в manifest. Это фиксирует полученный artifact, без обещания идентичной пересборки
из изменяемого apt repository.

`artifact_host.py --build` принимает только фиксированный локальный сценарий.
Он создаёт новую evidence directory, копирует allowlist исходников без `.env`,
Git metadata, uploads, фотографий и credentials, записывает raw source hashes и
исходный HEAD. Docker client использует пустой временный config и явный локальный
named pipe. Package manager закреплён: pnpm 11.24.0, frozen исходный lockfile,
автоматические install scripts выключены. Schema engine загружается как build
dependency командой `prisma --version`; последующие generate/typecheck/lint/build/
tests/packaging работают с `--network=none`. Generate использует заведомо закрытый
loopback port 1; migrations/queries и изменение schema не выполняются.

В runtime включены production dependencies API и tsx с их runtime closure,
скомпилированный API, фиксированные image runner sources, Node ELF, Python,
systemctl и библиотеки, найденные через ldd. Optional build peers Prisma CLI,
TypeScript и Studio исключены. Manifest перечисляет regular files, directories,
relative symlinks, UID/GID, modes, sizes и SHA-256. Verifier требует root ownership,
отсутствие setuid/setgid, group/world write, xattrs/file capabilities, escaping
symlinks, hard links, special files и credential-like filenames. Каждый runtime
file имеет запись; неизвестный/изменённый file или mode приводит к отказу.
Все созданные directories 0555, files 0444/0555; host `/etc`/home не копируются.
Account records создаются явно: root и synthetic imagefixture UID/GID 55000.

Самопроверка запускает Node и настоящий Sharp внутри chroot с собственным
loader/library closure. /usr merge aliases `/lib`, `/lib64`, `/bin` сохранены.
Версии: **Node 24.20.0, Sharp 0.35.4, libvips 8.18.6, linux/x64**.
Prebuilt Sharp выбирается для Linux, согласно
[официальной документации](https://sharp.pixelplumbing.com/install/).

Последний candidate с исправленными fixture paths и замерами:
`work/linux-artifact-4a7a4141fcaa4759a3d266f99e25b6ab/artifact/`.
7 536 manifest entries; rootfs tar около 310 MB. SHA-256:

- rootfs.tar: `03a848f6365b6c543ed50a57c5b396a4b35d6e6b7d685895ca8b8c65ebb5f607`;
- manifest.json: `b88768853b9384e8ec7df931603214bb9aa0dc06eed7553a04b56075bb387381`.

Receipt `candidate-5db03d99-components.json` сравнивает manifest с `c62a6cda...`:
изменились только `/opt/image-runner/application.py` и `application.mjs`.
Остальные runtime entries, включая compiled API и dependencies, идентичны;
все 302 source hashes совпадают с текущими файлами. Исходный `c62a6cda...`
и его rootfs/manifest сохранены вместе со всеми failed attempts.

`candidate-e38bfcbb-components.json` сравнивает final candidate с `5db03d99...`:
добавлены 17 entries для bind destinations и API PrivateTmp, изменён только
`/opt/image-runner/artifact.py` (diagnostics). Все app/Node/native dependency
entries и receipt 71 tests идентичны. Пустые placeholders имеют обычные root-owned
0444/0555 modes, входят в manifest и не исключаются из последующей проверки.
Промежуточная сборка `7e40787e...` (7533 entries) сохранена; VM на ней не запускалась:
перед запуском добавлен обязательный API mountpoint `/var/tmp`.

`candidate-4a7a4141-components.json` подтверждает единственный новый entry
относительно `e38bfcbb...`: пустой `/root`, UID/GID 0, mode 0555. Изменён только
packager/verifier source; app и native runtime hashes снова идентичны. История
сборок сохранена, ни одна предыдущая evidence directory не заменяется.

## Проверки приложения и verifier

Linux TypeScript для API, API lint и Nest build прошли без сети.
Три выбранных DB-free suites — **71 PASS / 0 failures / 0 skipped**, включая
пять прежних Linux-only source/variant/manifest symlink cases и три upload cases.
JSON receipt — `artifact/linux-tests.json`. Последующие packaging iterations
использовали эти app layers из cache при неизменных app sources.

Четыре Linux verifier tests — PASS: content/unknown file, symlink target/escape,
writable/setuid/setgid/xattr, сохранение SANDBOX_UNVERIFIED marker. Они вынесены
из старого discovery, как и новый application case. Изменённый portable selector
regression прошёл на Windows; missing child OOM по-прежнему приводит к отказу.

В `main.ts` добавлен стандартный `enableShutdownHooks(['SIGTERM', 'SIGINT'])`:
Nest должен вызывать уже существующие lifecycle cleanup hooks при штатной
остановке, в том числе при работе Node как PID 1. Других app изменений нет.

## Native application acceptance

Итоговый run: `work/image-application-36419e84a24644a8be4f33232ecc327a/` —
**PASSED: 1 test, 0 failures, 0 errors, 0 skips, 283.690 s** без времени boot VM.
Receipt: `work/linux-artifact-recovery-20261016/image-application-36419e84a24644a8be4f33232ecc327a.json`.
Serial SHA-256:
`4eadd4352442681ee29240d8800cd12527cf0a50dde6805e43ee015af683a0cc`.

| Проверка | Подтверждённый результат |
| --- | --- |
| Node/Sharp/libvips | Linux/x64 24.20.0 / 0.35.4 / 8.18.6; 11 actual mapped native file hashes совпали с manifest |
| Encode | Direct synthetic 800×600 → 192/384/640; supervised 96×64 → один shared output, те же hashes, что при direct encode того же input |
| Default encoder budget | 17.480 s / 30 s; 27 usage samples; child peak RSS 103030784 bytes; RSS budget 512 MiB сохранён |
| Worker unit | 53.165 CPU s / 106.377 wall s; peak 222.2 MiB; UID/GID 55000, пустые kernel groups, E/P/I/A=0, Bnd=0xe4, NNP=1, seccomp=2 |
| API start | Настоящие compiled main.js/AppModule, production env, PID 1 под UID 55000; health `{ok:true}`, readiness 503 `{ok:false,database:false}` с DB provider double |
| API stop | Настоящий systemctl SIGTERM; module destroy и application shutdown hooks вызваны; 0.832 s; MainPID=0, inactive/success, exit 0, process отсутствует, cgroup пуст |
| Immutable state | Все 7536 entries совпали до запуска, после worker и после API; synthetic storage fingerprint не изменился; CLI apply отказал SANDBOX_UNVERIFIED |

После экспорта serial обе fixture units и VM quiescent, собственные container и
volume удалены. `final-docker-20261016T145856Z.json` подтверждает сохранение трёх
прежних fixture volumes и `shop_db`, отсутствие application containers/volumes;
из containers остался только прежний `shop-db`, без подключения к БД.

Фиксированные scopes `application`, `application-api`, `application-worker`
позволяют продолжать только неподтверждённый этап без старой матрицы.
Новый host driver использует
проверенный read-only base, новый overlay/seed и read-only artifact ISO. Гость
не имеет NIC/KVM/shared host directory; SSH-доступ и forwarding не используются.
Внешний container: network none,
RO root и sources, NNP, cap-drop ALL, 3 GiB без swap, 2 CPU, 128 tasks;
actual Docker inspect проверяется до boot. Guest: 2 GiB, 2 CPU, TCG.

Worker fixture сохраняет sandbox/resource directives runner unit, меняя только
synthetic paths/entrypoint и fixture runtime/stop deadlines. Общий compound probe
ограничен 180 s, unit — 200 s (строже исходных 600 s), ожидание — 215 s.
Настоящие encoder 30 s / 512 MiB и CLI 45 s не увеличены. Настоящий
Node работает под UID/GID 55000 с пустыми kernel supplementary groups. Node API
`getgroups()` дополнительно включает effective GID; kernel evidence читается
из `/proc/self/status`. Проверяются E/P/I/A=0, NNP=1, seccomp=2, прямой encode,
supervised child encode, actual mapped `.node`/`.so` hashes, immutable artifact,
RO synthetic original и неизменный production apply gate.

API запускает скомпилированные `main.js` и AppModule через текущий API unit с
synthetic paths/identity. Fixture scaffolding добавляет RootDirectory/MountAPIVFS
и единственный preload. Preload заменяет ровно compiled DbService module через
Node load hook; PrismaPg/real DbService не создаются. Нет app env/test bypass.
Сохраняются PrivatePIDs, PrivateTmp, ProtectSystem, NNP, UMask, RO state/variants
и inaccessible runner. Restart выключен только в fixture, чтобы не скрывать
ошибки повторным стартом. Проверяются PID 1, health, недоступная DB readiness,
настоящий SIGTERM через systemctl stop и вызов Nest shutdown hooks.

## Сохранённые попытки и пределы результата

Все build attempts и snapshots сохранены отдельно. Первые три завершились
ошибками подготовки: HTTP 503 Debian mirror; schema engine не был заранее
скачан для offline generate; отсутствовали /usr merge loader aliases в rootfs.
Первая успешная сборка `521804...` содержала лишние optional build peers и была
сужена в `df1ef...`. Candidate `83b252...` уточняет fixture extraction/group
assertions; app build/tests повторно не запускались.

Native attempt `work/image-application-8441997635fa4e6d936f7a8a5462a781/` —
FAILED, 1 failure, 0 errors/skips, 171.785 s. Полная проверка распакованного
manifest прошла; Python worker завершился с status 127 из-за отсутствующего
`libz.so.1`, до запуска Node/API. Сборщик пропускал symlink `/usr/bin/python3`
при ldd, поэтому не учёл зависимости основного Python ELF. В `9c02...` ldd
получает resolved ELF; дополнительно chroot-проверяются импорты Python fixture
и `systemctl --version`. Security/resource directives не изменены. Все sources
guest совпали со snapshot, serial экспортирован, новый volume удалён только
после quiescence. Receipt находится в recovery directory; serial SHA-256:
`fbe53f75cd06eb0a6f1e50dcc2056eb1498ea689e695f7d1d900d205eaec5532`.

Native attempt `work/image-application-affeac72842d442fad31c07a96df8a8a/` —
FAILED, 1 failure, 0 errors/skips, 215.998 s. Artifact и kernel limits прошли;
fixture ожидал EROFS при записи в root-owned file 0444 от UID 55000, но DAC
законно возвращает EACCES раньше проверки mount. Исправлено только ожидание;
RO artifact mount отдельно проверяется по mountinfo, RO original — через EROFS.
Serial SHA-256:
`4b08482c58824ef39450cae812661a7f0c3dd1bc9816094cf8ee4c199b5bcbc2`.

Native attempt `work/image-application-f8f587246221481684c685f57aeaf5a9/` —
FAILED, 1 failure, 0 errors/skips, 178.238 s. Весь artifact проверен. Direct encode
800×600 завершился, supervised encode того же input остановлен штатным TIMEOUT
30 s. Worker: 40.357 CPU s / 80.753 wall s, peak RSS 134 MiB, MainPID=0 после
ошибки. API не запускался. При TCG и CPUQuota=50% это не доказывает пригодность
production budget; ошибка сохранена, лимит не повышен. Добавлены usage/wall-time
замеры и отдельный smoke input 96×64 для supervised child; direct case продолжает
проверять все размеры 192/384/640. Serial SHA-256:
`97f28e41e5ce07f8fe1799d532495a9cdcd7989818f68a00a70cdb2cb46b68e8`.

API-only attempt `work/image-application-79c81694894f490588c6f406f0483f20/` —
FAILED, 1 failure, 0 errors/skips, 96.524 s. Preload остановился до AppModule:
synthetic variant write оказался разрешён. Fixture добавлял RootDirectory, но
перенесённые API ReadOnlyPaths/ReadWritePaths/InaccessiblePaths не имели `+`.
Исправлены только fixture paths: `+/storage/...` и `+/runner`. Смысл префикса
подтверждён [документацией systemd 259](https://github.com/systemd/systemd/blob/v259/man/systemd.exec.xml):
он относит path к unit root; исходный API unit без RootDirectory не менялся.
Serial SHA-256:
`93fdd04431e0e1cc80ea795da08c6324636b03d0ab6edfeb1c05141ee75b610f`.

Attempt `work/image-application-92c40bc4960a4a1aa406a804890a28ff/` — FAILED,
0 failures / 1 error / 0 skips, 223.111 s. Encode прошёл: direct 800×600 дал
192/384/640; supervised smoke 96×64 завершился за 17.616 s при default 30 s,
23 usage samples, child peak RSS 102916096 bytes. Хеши результатов совпали;
CLI apply вернул SANDBOX_UNVERIFIED; 11 mapped native files совпали с manifest.
UID/GID 55000, пустые kernel groups, E/P/I/A=0, Bnd=0xe4, NNP=1/seccomp=2 прошли.
Ошибка возникла на post-stop rootfs verification: tree/metadata mismatch до API.
В packaging добавлены явные пустые bind destinations и mountpoints, чтобы
systemd не дополнял runtime при настройке namespace. Verifier сохраняет полное
сравнение, теперь выводя до 16 конкретных отличий; неизвестные paths не разрешены.
Serial SHA-256:
`41c713d19ea20fecf6b44c825d3f7413196554c44cf5612fae6ff77dce55f666`.

Attempt `work/image-application-531dca442bfd416184f9354872e55338/` — FAILED,
0 failures / 1 error / 0 skips, 228.370 s. Node probe прошёл; supervised smoke
18.907 s / default 30 s, unit 54.609 CPU s / 109.220 wall s, peak 223.7 MiB.
Точная post-stop диагностика показала единственное отличие: новый directory
`root`, UID/GID 0, mode 0750. Остальное дерево совпало. В следующей сборке `/root`
создан заранее с более строгим mode 0555; verifier не исключает его из manifest.
До API этот прогон не дошёл. Serial SHA-256:
`cbdd8d2059ac90035516da16b12968c96518e9c1d3e3027ceed7d89d9b181d86`.

Это локальный candidate, не установленный production rootfs. Synthetic UID/GID,
Debian systemctl client и DB provider replacement не принимают actual target
identity/topology, real DB/pool lifecycle, release/base choice или provisioning.
Supervised 800×600 в TCG упёрся в 30 s и не принят: успешный 96×64 smoke
подтверждает runtime closure/IPC/containment, но не capacity production workload.
Полный launcher request/approval/deploy fence с этим artifact отдельно не
запускался. Actual storage/ACL/aliases/writers, quota/capacity/I/O/durability,
operational recovery/CI и approvals G2–G9 остаются открытыми по production plan.
Ни этот artifact, ни новый selector не снимают **SANDBOX_UNVERIFIED**.

## Привязка к локальному коммиту

Artifact сохранён со своим исходным HEAD `34eea63` и 302 raw source SHA-256;
он собран до локального коммита, поэтому SHA внутри provenance не переписывался.
`final-committed-20261016T145932Z.json` связывает candidate `4a7a4141...`, run
`36419e84...` и commit `4bfba36`: 302 artifact sources + 27 guest sources дают
323 уникальных Git files. Их текст совпал; 105 файлов отличаются только CRLF/LF,
для каждого сохранены raw snapshot SHA-256 и Git blob ID. Пересборка ради SHA
не запускалась. Все 782 прежних evidence files сохранили hashes; production
units, launcher policy, lockfile, Prisma schema и apply gate не изменены.
