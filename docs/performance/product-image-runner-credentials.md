# Image runner: supervisor credentials — 5Б-2Б

Основа: `0d26100`, ветка `feat/product-image-production-runner`.
**SANDBOX_UNVERIFIED сохраняется.** VPS, production, БД, originals, deploy и
backfill не используются. Наблюдения владельца на VPS — входные данные;
проверка исправления выполняется только в новой disposable VM.

## Причина EPERM

Наблюдения владельца на VPS (не повторялись на VPS этим этапом):

| Профиль с User=root, PrivateUsers=full и NNP | Seccomp | P/E/B | setgroups → setgid → setuid |
| --- | --- | --- | --- |
| Без seccomp-backed директив | 0 | e4/e4/e4 | PASS / PASS / PASS |
| Любая из RestrictSUIDSGID, RestrictNamespaces, SystemCallArchitectures=native, указанного SystemCallFilter | 2 | 64/64/e4 | PASS / PASS / EPERM |

В [systemd 259.5 exec-invoke.c](https://github.com/systemd/systemd/blob/v259.5/src/core/exec-invoke.c#L5533-L5618)
явный `User=root` задаёт конкретный UID. При наличии seccomp и возможности позднего
сброса привилегий выбирается `keep_seccomp_privileges`: systemd временно сохраняет
CAP_SYS_ADMIN/CAP_SETPCAP для установки фильтров и после enforce_user удаляет
CAP_SETUID, если её нет в AmbientCapabilities. Это выполняется и для uid 0.
После фильтров временные privileges удаляются, bounding set возвращается к
настроенному значению. [drop_capability](https://github.com/systemd/systemd/blob/v259/src/basic/capability-util.c#L334-L357)
удаляет бит из permitted/effective/inheritable, а не из bounding set.

При execve [kernel commoncap](https://github.com/torvalds/linux/blob/v7.0/security/commoncap.c#L878-L922)
с NoNewPrivileges ограничивает новые permitted прежними permitted. Поэтому
оставшийся в bounding set CAP_SETUID не восстанавливается: P/E `0xe4 → 0x64`,
B `0xe4`. [setuid](https://github.com/torvalds/linux/blob/v7.0/kernel/sys.c#L621-L668)
проверяет CAP_SETUID в user namespace для произвольного нового UID; без него
переход с root на shop завершается EPERM. UID/GID maps и setgroups=allow этого
не заменяют. NoNewPrivileges сохраняется и не запрещает корректный setuid при
наличии нужной capability; см. [kernel NNP](https://docs.kernel.org/userspace-api/no_new_privs.html).

Это объясняет одинаковый эффект разных seccomp-backed директив. В launcher
дополнительно обнаружен пробел проверки: верхняя граница capabilities принимала
`0x64`, хотя supervisor затем требовал CAP_SETUID для запуска worker.

## Альтернативы и security contract

| Вариант | Последствия / решение |
| --- | --- |
| Наследовать UID 0 от system manager, убрать только явный User=root | Выбран для fixture-проверки. Нет systemd UID transition и ветки удаления CAP_SETUID. Group=root, PrivateUsers=full, NNP, все seccomp-backed защиты и прежний bounding set сохраняются. Runtime требует UID 0 и точные P/E/B `0xe4`, I/A=0. |
| AmbientCapabilities=CAP_SETUID | Меняет запрет ambient/inheritable capabilities и их наследование helper/worker. Не применяется. |
| Добавить CAP_SETPCAP или расширить bounding set | Меняет capability allowlist и доверенную поверхность supervisor. Не применяется. |
| Отдельные supervisor/worker systemd units | Меняет cgroup/namespace/FDSTORE/fence lifetime и протокол допуска. Нужен отдельный review; не реализуется здесь. |
| Отключить NNP/seccomp/PrivateUsers, root-worker, привилегированный ExecStart prefix | Нарушает ограничения задачи. Не применяется. |
| Исправить/обновить systemd на target host | Отдельное изменение host; этот этап его не выполняет. |

Выбранный вариант сохраняет существующую архитектуру system-level root supervisor
→ фиксированный child с UID/GID shop и `extra_groups=[]`. User= намеренно
отсутствует; non-root/user manager запуск отказывает по runtime identity. Exact
manager properties и capability guards должны отвергать возврат User=root,
потерю необходимых capabilities, новые capabilities и непустые I/A.

Supervisor выполняет прежние inspection/control операции и один credential drop.
Worker получает все real/effective/saved UID/GID shop, пустые supplementary groups
и нулевые permitted/effective/inheritable/ambient capabilities. Bounding set —
потолок, не доступные privileges: он наследует `0xe4`, как в прежнем контракте;
NNP запрещает получение capabilities через exec. Нулевой **bounding** set потребовал
бы CAP_SETPCAP либо отдельного manager-launched worker — оба варианта выше меняют
contract и здесь не внедряются. Утверждение о пяти нулевых наборах не делается.

## Регрессия и проверка

В [test_credentials.py](../../deploy/image-runner/test_credentials.py) два новых
ограниченных fixture units с
одинаковыми NNP, PrivateUsers=full, четырьмя seccomp-backed директивами и allowlist
`0xe4`. Один задаёт User=root и воспроизводит P/E `0x64`/setuid EPERM; другой
наследует UID 0 и требует P/E/B `0xe4`, успешный credential drop и непривилегированный
worker через тот же subprocess API. Отдельно записываются setgroups/setgid/setuid,
worker credentials и невозможность возврата UID 0. Нет arbitrary command/UID input.
Проверяется также отказ capset при попытке вернуть CAP_SETUID из пустого permitted
set и ранний отказ launcher policy для `0x64` до acquisition deploy fence.

Старый результат `image-acceptance-8dca51fed5894760bd0659e0af68dafe` остаётся FAILED:
3 passed, 1 failure, 54 не запускались. Он сохранён без изменений.

## Фактические результаты 2026-10-16

Новый run: `work/image-acceptance-7e8724242b4f4b64b27150b3ed1d7c94/`.
Прежние VM завершены до запуска; создана одна новая bounded networkless VM.
PID 1 — systemd 259.5-0ubuntu3.4, kernel 7.0.0-34-generic, cgroup v2,
memory/cpu/pids controllers и создание namespaces подтверждены. Ubuntu SHA-256
совпал с pin `8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2`.
Все 16 переданных source SHA-256 совпали с checkout; final guest и host reports
однозначны и согласованы.

| Проверка | Результат |
| --- | --- |
| Старая конфигурация с User=root | PASSED как отрицательная регрессия: P/E=64, B=e4, I/A=0; setgroups и setgid проходят, setuid и subprocess worker получают EPERM. Новый process guard отказывает. |
| Наследование UID 0 без User= | PASSED: supervisor UID/GID 0, P/E/B=e4, I/A=0, NNP=1, Seccomp=2; все три credential syscalls и subprocess worker проходят. |
| Worker | PASSED: real/effective/saved UID/GID=55000, groups=[], P/E/I/A=0, B=e4, NNP=1, Seccomp=2. Возврат UID 0 и capset для CAP_SETUID отвергнуты, credentials не изменились. UID/GID 55000 — только fixture identity; production launcher по-прежнему использует shop/997 и GID из passwd. |
| Template-derived namespace | PASSED: все три cases, включая positive RO originals/inventory, denied mutations, parent DAC, secrets/proc/ptrace, unknown lock preservation, native link/fsync/no-clobber, negative EXDEV и writable alias admission refusal. |
| Native primitives / portable policies на Linux | PASSED: 9 native и 35 portable policy cases. |
| Полный Linux/systemd suite | FAILED: 49 passed, 1 failure, 0 errors/skips, 50 из 60 tests за 242.113 s. Оставшиеся 10 не запускались из-за failfast. |
| Child group OOM | FAILED: фактический Result=timeout вместо oom-kill. Это не успешная OOM acceptance; причина timeout отдельно не установлена. MemoryHigh=512M, MemoryMax=768M, Swap=0, RuntimeMaxSec=60 не менялись. |
| Остальные lifecycle cases | NOT VERIFIED: parent OOM, CPU/tasks pressure, kill/stop/runtime, orphan containment, FDSTORE/reexec. Ни один полный lifecycle case этого прогона не отмечен passed. |
| Windows portable suite | 35 passed, 25 Linux-only skipped, 60 cases, 0 failures/errors. Не выдаётся за systemd acceptance. |
| Python lint/format | Ruff 0.14.0 check и format --check passed, все 13 Python files. |
| Сохранность предыдущего evidence и application | Все 244 прежних evidence files неизменны; production gate, deploy.sh и ImageStorage совпадают с исходными SHA-256. Application/package/lockfile diff пуст; прежние typecheck/lint/build не повторялись. |

VM штатно выключилась; wrapper exit 78 корректно отражает failed suite. Serial,
result и cleanup сохранены; удалён только новый fixture volume после экспорта и
подтверждённого отсутствия containers. Две прежние fixture volumes сохранены.
Serial: 118732 bytes,
SHA-256 `61a3ea7c261fc7e91a6bfd19faaf54a2fbc7932edc0d1925e964043bfef271c7`.
Отдельные analysis/verification и portable/lint logs находятся в ignored
`work/image-credentials-20261016/`. Старые логи не перезаписаны.

## Оставшиеся блокеры

- EPERM credentials устранён в изолированных fixtures, но общий acceptance
  остаётся FAILED из-за child OOM timeout и десяти незапущенных lifecycle cases.
  Подмена ожидаемого oom-kill на timeout, ослабление memory limits и увеличение
  deadline ради зелёного результата не выполнялись.
- Нулевой worker bounding set не заявляется: для этого нужен отдельный review
  изменения contract. Новые ambient/capabilities и root-worker не добавлялись.
- Immutable Node/Sharp/libvips rootfs, actual shop ACL/UID/GID, API RO и обратная
  same-UID proc/ptrace изоляция, target storage/durability/budgets, reboot/manual
  recovery, independent GitHub CI и operational gates остаются NOT VERIFIED;
  см. [production blockers](product-image-production-acceptance.md#not-verified-и-production-blockers).

SANDBOX_UNVERIFIED не снимается. Нет изменений VPS, production, БД, originals,
push/merge/deploy/backfill; нет git reset/stash/clean/force push.
