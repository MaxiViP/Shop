# API isolation: согласованный локальный перенос policy

Исходный HEAD `f642ac1`, ветка `feat/product-image-production-runner`.
Пользователь разрешил перенос проверенного candidate только в репозиторий.
`SANDBOX_UNVERIFIED` сохранён. VPS, production services, БД и originals не менялись.

## Конфигурация и пути

В `deploy/shop-api.service` добавлены PrivatePIDs=yes, ReadOnlyPaths двух roots
и InaccessiblePaths runner. User/Group=shop, ExecStart, UMask=0027,
NoNewPrivileges, PrivateTmp, ProtectSystem=strict, ProtectHome и родительский
ReadWritePaths uploads сохранены. Новых capabilities, write scopes или optional
`-` prefixes нет. Example остаётся reference, отдельный drop-in не устанавливается.

| Назначение | Путь в репозитории/плане | API |
| --- | --- | --- |
| Originals, включая hero | `/var/lib/korzinamarket/uploads/products` | RW; чтение и существующий upload contract сохраняются |
| Chat и `.incoming` | `/var/lib/korzinamarket/uploads/chat` | RW |
| WebP variants | `/var/lib/korzinamarket/uploads/product-variants` | RO |
| Runner state | `/var/lib/korzinamarket/uploads/.product-image-state` | RO |
| Runner control/rootfs | `/var/lib/korzinamarket-image-runner` | Inaccessible |

`common/image.ts` читает UPLOAD_DIR; `deploy.sh` требует точный products path.
Admin ImagesService создаёт файл через `wx`, при ошибке транзакции удаляет новый
файл. Slides используют products/hero. ImageRegistry и image-static читают
originals/variants/state; registry не пишет. Production chat path закреплён в
chat-images.service.ts. Для variants/state до активации нужны явные env paths из
таблицы: старый default publicRoot=sourceRoot не соответствует новому layout.
Реальные env/paths/UID/GID/ACL VPS в этой задаче не читались и не считаются принятыми.

PrivatePIDs появился в systemd 257, делает service process PID 1 и монтирует
соответствующий proc; при отсутствии поддержки kernel может игнорироваться.
Поэтому нужен реальный namespace preflight, а не только версия/директива:
[systemd.exec v259](https://github.com/systemd/systemd/blob/v259/man/systemd.exec.xml).
Тот же источник описывает RO/RW mount scopes и пределы mount propagation.

## Native fixture: настоящий API unit

Прогон `work/image-acceptance-9c951e41a73c458b80e65ddc664ad8ad/`:
**1 PASS / 0 failures / 0 errors / 0 skipped**, 43.912 s.
Выбран только `--security-api`; прежние caps/stress/64 cases не повторялись.
Selector доступен через `python -B deploy/image-runner/acceptance_host.py --security-api`.
Guest entrypoints напрямую на обычном host/VPS не запускаются.

Новая bounded networkless QEMU VM, systemd 259.5-0ubuntu3.4,
kernel 7.0.0-34-generic, cgroup v2 и namespace preflight.
SHA-pinned base `8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2`
использован RO, overlay/seed новые. Docker: RO root/source, NNP, cap-drop ALL,
3 GiB без swap, 2 CPU, 128 tasks; guest 2 GiB/2 CPU без NIC/KVM/SSH/host namespaces.
Свой volume удалён после quiescence и экспорта serial; cleanup.log подтверждён.

Fixture заменяет только identity/exec/paths на новые synthetic данные, исключает
env file/Docker dependencies. Политика берётся из shop-api.service; дополнительный
candidate не добавляется. Manager properties PrivatePIDs/PrivateTmp/ProtectSystem/
NNP/User/Group/ReadOnlyPaths/ReadWritePaths/InaccessiblePaths проверены.

| Проверка внутри API namespace | Результат |
| --- | --- |
| Общий uploads: root:root 0755, mount 438 | RW; запись API в сам parent запрещена EACCES |
| Products/chat: UID/GID 55000, 0750 | Общий RW mount 438 |
| Variants/state: UID/GID 55000, 0700 | RO mounts 447/446; private files 0600 читаются |
| create/mkdir/write/chmod/unlink/rename в обоих private roots | 12 отказов EROFS |
| hard link private file → chat | 2 отказа EXDEV |
| Создание original через O_EXCL и чтение | PASS, mode 0640 при UMask=0027 |
| Повторный O_EXCL, rollback unlink, nested hero upload | EEXIST / PASS / PASS |
| Существующий synthetic original | Bytes/inode/dev/owner/mode/mtime/ctime сохранены |
| API PID/proc | PID 1, виден только PID 1 |
| Foreign worker proc/root/alias, ptrace, signal permission | ENOENT / ESRCH |
| Runner runtime/control | EACCES |

В fixture все real/effective/saved UID/GID=55000, supplementary group=55000,
E/P/I/A=0 и NNP=1. Это эквивалентная числовая identity для нового guest,
не подтверждение target UID 997/GID. Owners/modes originals на target не менялись.
Root-owned parent запрещает переименование sibling roots общему worker/API UID;
actual trusted ancestors/aliases требуют будущего read-only target review.

## Проверки приложения без БД

- API: **144 PASS, 5 skipped** в 8 связанных files. DB providers — test doubles;
  dotenv направлен в пустой fixture file, реальный DbService не создаётся.
- Новые 3 upload cases: настоящий PNG→WebP, managed URL, GET/HEAD через
  configureProductImageHttp; rollback удаляет только новый upload; invalid input
  не пишет файл и не начинает транзакцию. Existing fixture original и отдельные
  variants/state деревья остаются неизменными.
- Также проверены admin image ordering/visibility, admin services, catalogue/
  favorites HTTP, registry/static HTTP и chat images. Пять skipped — существующие
  Linux-only symlink cases: 3 registry и 2 static. На Windows они не заявляются PASS.
- Frontend: **48 PASS / 0 skipped** — admin operations, catalogue/card/gallery,
  SSR, original URLs и fallback при ошибке изображения.
- Новый upload fixture прошёл strict TypeScript check; API lint и API build — PASS.
  Python Ruff check/format и изменённый portable selector regression — PASS.

Native Python probe доказывает kernel/DAC/mount boundary. App regressions выполнены
на Windows Node 24.20.0 и не заменяют реальный Linux Node/Nest lifecycle в unit.
Application source, Prisma schema, lockfile, flags и runner policy не менялись.

## Evidence и оставшиеся gates

Baseline: `work/api-isolation-20261016T110253Z/baseline.json`,
33 source files и 702 прежних evidence files; SHA-256
`e5f99761f7465e62e23169958bebfd46484dc8e15e77dca93633056eea7a7a06`.
Source snapshot из 20 files — candidate-1; guest hashes совпали с snapshot.
`native-api.json`, app logs и check receipts находятся в той же директории.

До любой будущей установки обязательны existing variants/state/control roots,
actual shop UID/GID/ACL, canonical env paths и effective mount/namespace proof.
Без требуемых roots unit должен отказать в старте; префиксы `-` для обхода
не добавляются. Текущий deploy.sh создаёт только products/chat и выполняет
migrations; его запуск не согласован. Сервисы не устанавливались и не перезапускались.

Открыты immutable Linux Node/Sharp/libvips artifact/manifest и app startup/health/
shutdown как PID 1, пять Linux app symlink cases, target storage/aliases/mount
propagation/FDs, capacity/quota/I/O и `nobarrier` durability, recovery/CI и G2–G9
из [production plan](product-image-production-plan.md). SANDBOX_UNVERIFIED остаётся
в силе; локальный коммит не разрешает deploy или production apply.
