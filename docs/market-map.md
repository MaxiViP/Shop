# Карта рынка

## Маршруты и данные

- Публичная карта: /market-map; точка: /market-map/[slug].
- Возврат к выделенной точке: /market-map?point=[slug].
- ADMIN: /admin/market-map, существующие admin middleware и AdminGuard; SELLER не редактирует карту.
- GET /api/market-map?floor=2 отдаёт только опубликованные точки (один запрос, до 500 точек на этаж); GET /api/market-map/[slug] возвращает 404 для скрытой точки.
- ADMIN CRUD: /api/admin/market-map/points; отдельные POST/DELETE /:id/photo.

MarketPoint: id, slug, name, optional unitNumber, kind, description, sampleAssortment, photoUrl, floor, mapX/mapY, isPublished, sortOrder, createdAt/updatedAt.
Координаты — проценты относительно всей схемы 1200 × 1460; ноль — слева сверху.
Публикация новой точки по умолчанию выключена. Фото нормализуется в WebP через существующий normalizeImage; используется имеющийся UPLOAD_DIR и /uploads/products/, без нового env/nginx/storage.

## Схема и первичное заполнение

Собственная SVG-геометрия: apps/web/public/images/market/floor2.svg. Яндекс iframe, интерфейс и растровые reference-файлы на сайт не встроены.
Основная геометрия и расположение точек взяты из floor2-overview.png; верхняя линия Чайняо, Panasian и Plovbox — из дополнительного reference.
Annotated reference с красными стрелками локально отсутствует. По уточнению владельца заведены ровно два входа ENTRY: рядом с ButterBrot / Белорусскими колбасами (x=41.25%, y=52.0548%) и в лестничной / эскалаторной зоне между Дары Грузии / Горница / Соленья (x=33.9167%, y=78.5616%). Серые стрелки по периметру не считаются входами. Позиции и публикация обоих входов редактируются ADMIN.
References находятся только локально и исключены через .gitignore; production asset — собственная SVG-схема.
Поле floor сохраняет возможность расширения. Для другого этажа позже понадобится отдельная SVG-геометрия и переключатель в UI; схема второго этажа не переиспользуется как схема другого этажа.

Миграция 20261006120000_market_map создаёт независимую таблицу и первичные данные один раз; не меняет существующие таблицы и не перезаписывает последующие правки ADMIN.
Проверена на временной локальной PostgreSQL-схеме. В рабочую или production БД не применялась.
У всех первичных точек номер и фото пустые. Ассортимент — примерный ориентир по названию, не подтверждение наличия товара.

## ADMIN

1. Выберите точку в списке или на preview, либо нажмите «Добавить точку».
2. Измените название, номер, тип, slug, описание, ассортимент, порядок и публикацию.
3. Введите x/y либо нажмите «Указать место на карте» и выберите место кликом. Сохраните форму.
4. После создания добавьте или замените фото; фото сохраняется отдельно, не сбрасывая несохранённые тексты.
5. При переходе к другой точке несохранённые изменения требуют подтверждения в существующем AdminConfirm.

Карта масштабируется до 500%; увеличенная схема перемещается стандартной прокруткой/свайпом. Маркеры остаются на своих координатах, подписи избегают пересечений с помощью коротких соединительных линий. Полный список точек доступен отдельно, включая поиск по названию, номеру и ассортименту.

## Точки

58 точек и 2 входа ENTRY (всего 60 записей):

| Название | Тип | Страница |
| --- | --- | --- |
| Чайняо | Магазин | /market-map/chainyao |
| Фонари, батарейки, игрушки | Магазин | /market-map/lights-batteries-toys |
| Батуми | Фудкорт | /market-map/batumi |
| Panasian | Фудкорт | /market-map/panasian |
| Голден Манки | Фудкорт | /market-map/golden-monkey |
| Дагестанская лавка | Фудкорт | /market-map/dagestan-stall |
| Plovbox | Фудкорт | /market-map/plovbox |
| Бабка | Фудкорт | /market-map/babka |
| Мамина пекарня | Фудкорт | /market-map/mamina-bakery |
| Bở | Фудкорт | /market-map/bo |
| Shop Beerimport | Магазин | /market-map/beerimport |
| Tobacco Premium | Магазин | /market-map/tobacco-premium |
| Dolce Coffee | Фудкорт | /market-map/dolce-coffee |
| Мангал хаус | Фудкорт | /market-map/mangal-house |
| Dolce Tea & Bubbles | Фудкорт | /market-map/dolce-tea-bubbles |
| Вкусные сезоны | Лавка | /market-map/vkusnye-sezony |
| ButterBrot | Фудкорт | /market-map/butterbrot |
| Стейк’Хэм Бургерс | Фудкорт | /market-map/steak-ham-burgers |
| Специи | Лавка | /market-map/spices |
| Грузинские сыры | Лавка | /market-map/georgian-cheese |
| Белорусские колбасы | Лавка | /market-map/belarusian-sausages |
| Тамбовское домашнее сало | Лавка | /market-map/tambov-salo |
| Соленья от Светланы | Лавка | /market-map/svetlana-pickles |
| 4 Брата | Магазин | /market-map/four-brothers |
| Мясо халяль | Лавка | /market-map/halal-meat |
| Гранд Базар | Магазин | /market-map/grand-bazar |
| Чай кофе | Лавка | /market-map/tea-coffee |
| Cezoni Market | Магазин | /market-map/cezoni-market |
| Mister Wine | Магазин | /market-map/mister-wine |
| Вкусная лавка | Лавка | /market-map/vkusnaya-stall |
| Бытовая химия | Магазин | /market-map/household |
| Каравай-СВ | Фудкорт | /market-map/karavai-sv |
| Золотая рыбка | Лавка | /market-map/goldfish |
| Дары Армении | Лавка | /market-map/gifts-armenia |
| Мясной рай | Лавка | /market-map/meat-paradise |
| Рыба | Лавка | /market-map/fish |
| Мясо охлажденное | Лавка | /market-map/chilled-meat |
| Птица домашняя | Лавка | /market-map/poultry |
| Красная икра | Лавка | /market-map/red-caviar |
| Овощи и фрукты — левый ряд | Лавка | /market-map/vegetables-fruits-west |
| Овощи и фрукты — правый ряд | Лавка | /market-map/vegetables-fruits-east |
| Фрукты, сухофрукты | Лавка | /market-map/fruits-dried |
| Дары Грузии | Лавка | /market-map/gifts-georgia |
| Горница | Магазин | /market-map/gornitsa |
| Соленья, восточные сладости | Лавка | /market-map/pickles-sweets |
| Сухофрукты, орехи | Лавка | /market-map/dried-fruits-nuts |
| Fresh Bar | Фудкорт | /market-map/fresh-bar |
| Мангалы, печи | Магазин | /market-map/grills-stoves |
| Продукты из Белоруссии | Лавка | /market-map/belarus-products |
| Ремесленные сыры | Лавка | /market-map/artisan-cheese |
| Итальянская лавка | Лавка | /market-map/italian-stall |
| Рязанская молочная продукция | Лавка | /market-map/ryazan-dairy |
| Кулинария | Лавка | /market-map/cookery |
| Русские традиции | Лавка | /market-map/russian-traditions |
| Posto Preferito | Фудкорт | /market-map/posto-preferito |
| Мёд Черноземья | Лавка | /market-map/chernozem-honey |
| VendGame | Сервис | /market-map/vendgame |
| Бери заряд | Сервис | /market-map/beri-zaryad |
| Вход на 2 этаж · у ButterBrot | Вход ENTRY | /market-map/entry-butterbrot |
| Вход на 2 этаж · у Горницы | Вход ENTRY | /market-map/entry-stairs |
