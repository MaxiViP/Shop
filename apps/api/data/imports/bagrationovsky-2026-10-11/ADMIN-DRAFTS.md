# Багратионовский рынок: отдельные черновики в админке

Черновики хранятся в `ResearchStoreDraft` (16 записей) и `ResearchProductDraft` (168 записей).
Они **не** являются записями `MarketPoint` и `Product` и не участвуют в каталоге или заказах.

Перед миграцией production обязательно сохранить актуальную PostgreSQL и uploads.
После миграции и обновления приложения выполнить проверку и импорт:

```bash
cd /opt/korzinamarket
sudo -u shop /usr/bin/node --env-file=/etc/korzinamarket/api.env apps/api/node_modules/tsx/dist/cli.mjs apps/api/data/bagrationovsky/db-run.ts --dry-run
sudo -u shop /usr/bin/node --env-file=/etc/korzinamarket/api.env apps/api/node_modules/tsx/dist/cli.mjs apps/api/data/bagrationovsky/db-run.ts --apply
```

Страница для администратора: `/admin/research-drafts`.

Исходная очередь `prepared/import-queue.json` содержит справочные, а не подтверждённые цены продавца.
CLI проверяет входную схему и точные размеры набора, запрещает внешнюю БД, не меняет существующие записи и повторно не создаёт черновики.
Изменение исходных сведений при том же ключе останавливает импорт и требует отдельного решения.
Статусы и заметки редактируются только через защищённую административную страницу.
Подтверждение статуса **не публикует** точку или товар: цену продажи, поставщика, наличие, SKU, единицы и возможные дубли необходимо проверить отдельно.
