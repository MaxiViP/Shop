# Проверка production image runner, 2026-10-17

Рабочая ветка `feat/product-image-production-runner`, исходный HEAD `7c5871a`;
pipeline PR #8 (`c30f150`) сохранён. Начальные незакоммиченные исправления
admission/launcher сохранены в реализации и отдельно в локальном
`work/image-production/pre-existing.patch`. Совместимая политика PR #6
(`09fdbb8`) перенесена в общий ProductImage: 4 eager/high изображения в первом
grid/group, lazy/async остальные, IntersectionObserver margin 3000px с cleanup
и сбросом при замене фото. Геометрия, srcset/sizes и original fallback сохранены.

## Реализация

- `requireProductionSandbox(options)` проверяет root-only inherited FD, inode,
  uid/euid/gid/egid, пустые kernel supplementary groups, NNP/seccomp/capabilities,
  request kind, batch/approval SHA, фиксированные roots и точный service cgroup.
  Переменная окружения с числом FD сама по себе ничего не разрешает.
- Launcher проверяет namespace/mounts, RO originals, resource limits, manager
  через существующий read-only pidfd broker, request/input/unit digests и retained
  deployment flock. Только `image-production-apply` запускает существующий
  coordinator → supervised encoder → ImageStorage. Успех возвращает 0; отказы
  сохраняют fence и nonzero. Inspection по-прежнему возвращает 78.
- В template явно задан `Slice=system.slice`. Иначе systemd создаёт per-template
  subslice и строгий `CGROUP_PATH` корректно отказывал. Проверка пути не ослаблена;
  Slice также проверяется через manager. Это согласуется с
  [документацией systemd](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
- `manage.py batch` делает отдельный read-only discovery/proposal, затем
  замораживает inventory/approval/request. <=200 inspected originals, <=1/5/20/50
  выбранных; cursor циклический, поэтому новые upload/import подбираются вне HTTP.
  Небольшие источники не увеличиваются, одинаковые размеры дедуплицируются.
  Inventory/approval имеют root:shop 0640 для чтения worker; полномочие запуска
  request остаётся root:root 0600 и доступно Node только через inherited FD.
- Rootfs/Node/Sharp/libvips остаются immutable и проверяются по manifest.
  Успешные пустые проходы удаляют только собственные временные placeholders/unit;
  apply approvals, журналы и image/run locks сохраняются. Release требует пустую
  cgroup и никогда не снимает неизвестный image/run lock.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| Общий pnpm typecheck/lint; повторный web typecheck/lint после PR #6 | PASS |
| API, telegram-gateway, Nuxt production build | PASS |
| Native Linux image/API/business compatibility suite, без БД | 541 PASS, 0 skips, 23 files |
| Linux operator lifecycle + policy + broker | 40 PASS |
| Реальный production CLI в disposable Linux/systemd VM | PASS: canary, новое фото, повтор, RO originals, quiescent release |
| Windows coordinator/backfill/API suite | 130 PASS, 7 Linux-only skips; эти случаи выполнены в Linux |
| Frontend unit suite | 399 PASS, 0 skips |
| Production browser smoke, отдельный Edge + local mock API | 31 PASS, 0 hydration errors, 0 external requests |
| Bash-синтаксис блоков deploy runbook | PASS, команды деплоя не выполнялись |
| Native tmpfiles recipe / CLI admin-lock entrypoint | PASS: inode не меняется; symlink отклоняется; новый root:0600 lock |

Браузер: 390/1440px с DPR 1/2/3, 639px и coarse landscape 844×390,
каталог/виртуализированная прокрутка/главная/избранное/галерея. На 390px и 1440px
DPR 1/2/3 выбираются 192/384/640 WebP соответственно. Tiny source остаётся
оригиналом. Проверены сбои до hydration и во время неё, original retry,
placeholder, отсутствие retry loop и поздняя ошибка предыдущего фото галереи.
API integration проверяет отсутствие Sharp в HTTP-serving/enrichment, сохранение
пагинации/цен/URL/alt и штатного AuthGuard. Upload endpoint по-прежнему сохраняет
только оригинал; decoder и publisher не добавлены в HTTP request.

Первый Windows параллельный прогон дал таймауты; source-fingerprint тест также
поймал правку исходника во время исполнения. Повтор на зафиксированных исходниках
последовательно прошёл. Первый sandboxed Nuxt build отказал на доступе Nitro
к родительскому Windows пути (`EPERM readlink`); сборка вне этого ограничения
завершилась. Первому Linux suite не хватило repository photo/dataset fixtures в
минимальном build context; повтор с readonly fixtures прошёл все 541 тест.
Эти неуспешные запуски не считаются положительными проверками.

Полный VM-прогон выявил ещё два реальных integration дефекта: автоматическую
per-template slice и недоступные worker файлы inventory/approval root:0600.
Исправлены декларация Slice и права только этих двух входов. Добавлена регрессия,
которая отдельно требует 0600 для admission request. Защиты и лимиты не отключались.

Локальные подробные логи: `work/image-production/`,
`work/product-image-frontend/report.json`. Они исключены из Git.

## Полный Linux production запуск

`image-application-8e4ac9cb76614f7e87e6e6ca6e130985`: PASSED, 1 test,
591,085 s, 0 failures/errors/skips. Ubuntu 26.04.1, kernel 7.0.0-34,
systemd 259.5, networkless QEMU/TCG. UID 997 / GID 55001; иной primary GID
проверяет отсутствие привязки к VPS GID. Node 24.20.0 / Sharp 0.35.4 /
libvips 8.18.6. Оба apply возвратили 0, READY по одному фото; третий проход —
0 processed. Проверены widths 192/384/640, сохранность originals, отсутствие
повторных public writes, immutable artifact и свободный fence после quiescence.
Пик unit memory: 136,4 MiB при MemoryMax=768 MiB. Лимиты CPU 50%, swap 0,
TasksMax=64 и worker timeout 30 s не менялись ради теста.

Проверенный worker rootfs SHA-256:
`6b351813a57f32c9a2a07a7803d4d89c10ccfbc5d146f43ac7ca869881bb238f`;
manifest SHA-256:
`4c2a99fd8a2c1301af5c1133d033f5ade8d8c964356449ba94a716c432d843eb`.
Локальные artifact/serial logs находятся в соответствующих каталогах `work/`.
При деплое собирать runtime из фиксированного коммита по runbook и сохранять
полученные SHA; production approval всегда связывается с реально запущенным
artifact, а не с произвольной строкой ревизии.

## Задержка HTTP

Воспроизводимый `node apps/web/test/product-image.latency.mjs`: loopback Express
и настоящий ImageRegistry, 24 позиции / 3 разных фото, по 100 запросов. В Linux
container: 2 CPU, 768 MiB, без сети, источники readonly. Это измерение стоимости
image enrichment, без PostgreSQL/Nginx/реальной клиентской сети.

| Linux fixture | p50, ms | p95, ms |
| --- | ---: | ---: |
| Variants off | 2,59 | 3,70 |
| Variants on, warm | 9,21 | 12,51 |
| Variants on + отдельный encoder process | 10,77 | 31,33 |

Первый lookup: 46,52 ms; event-loop p95: 10,93 ms. Encoder не вызывается из HTTP.
Рост warm p95 составляет 8,81 ms; при фоновом процессе ещё 18,82 ms. Лимит задач
benchmark учитывает предварительную генерацию fixtures; он не меняет production
`TasksMax=64`, CPU 50% и memory.max 768 MiB runner. Windows-повтор дал
16,76/41,89/107,59 ms p95, поэтому его нельзя переносить на Linux VPS.
Нужны отдельные cold/warm измерения на целевом диске и рабочей БД при canary.

## Деплой

[Точные Bash-команды rollout и отката](product-image-deploy.md): фиксированный
SHA, backup БД/uploads/env/units, отдельный checkout без migrations, immutable
runtime, один выбранный original, партии, API flag первым, frontend flag вторым,
stop/release и откат. На VPS ничего не устанавливалось и не запускалось.
Авторизация, цены, заказы, Prisma schema и migrations не менялись.
