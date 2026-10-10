import type { Prisma, SeasonGroup } from '../db/gen/client.js';

const description = 'Ориентировочный сезон свежего урожая на московских рынках. Уточняйте регион и происхождение партии: для тепличной и импортной продукции сроки могут отличаться.';
const groups: { group: SeasonGroup; rows: readonly (readonly [string, string, number, number])[] }[] = [
  { group: 'VEGETABLES', rows: [
    ['radish', 'Редис', 5, 6], ['cucumbers', 'Огурцы', 6, 9], ['tomatoes', 'Помидоры', 7, 9],
    ['courgettes', 'Кабачки', 6, 9], ['aubergines', 'Баклажаны', 7, 9], ['peppers', 'Болгарский перец', 7, 9],
    ['new-potatoes', 'Молодой картофель', 6, 8], ['carrots', 'Морковь', 8, 10], ['beetroot', 'Свёкла', 8, 10],
    ['cabbage', 'Капуста', 7, 10], ['sweetcorn', 'Кукуруза', 8, 9], ['pumpkins', 'Тыква', 9, 11],
  ] },
  { group: 'FRUITS', rows: [
    ['sweet-cherries', 'Черешня', 6, 7], ['sour-cherries', 'Вишня', 7, 8], ['apricots', 'Абрикосы', 6, 8],
    ['peaches', 'Персики', 7, 9], ['nectarines', 'Нектарины', 7, 9], ['plums', 'Сливы', 8, 9],
    ['apples', 'Яблоки', 8, 10], ['pears', 'Груши', 8, 10], ['watermelons', 'Арбузы', 8, 9],
    ['melons', 'Дыни', 7, 9], ['grapes', 'Виноград', 9, 10], ['persimmons', 'Хурма', 10, 12],
    ['mandarins', 'Мандарины', 11, 1],
  ] },
  { group: 'BERRIES', rows: [
    ['local-strawberries', 'Клубника подмосковная', 6, 7], ['wild-strawberries', 'Земляника', 6, 7],
    ['raspberries', 'Малина', 7, 8], ['currants', 'Смородина', 7, 8], ['gooseberries', 'Крыжовник', 7, 8],
    ['bilberries', 'Черника', 7, 8], ['blueberries', 'Голубика', 7, 9], ['blackberries', 'Ежевика', 8, 9],
    ['sea-buckthorn', 'Облепиха', 8, 9], ['lingonberries', 'Брусника', 8, 9], ['cranberries', 'Клюква', 9, 11],
  ] },
];
export const seasonPresets = groups.flatMap(({ group, rows }) => rows.map(([key, name, startMonth, endMonth]) =>
  ({ key: 'moscow-' + key, name, description, group, startMonth, endMonth, active: true })));

const normalize = (name: string) => name.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

// Caller holds the same advisory lock as ADMIN template creation/editing.
export async function fillSeasonPresets(db: Prisma.TransactionClient) {
  const existing = await db.seasonTemplate.findMany({ orderBy: { id: 'asc' } });
  const keys = new Set(existing.map(template => template.key));
  const missing: typeof seasonPresets = [];
  let matched = 0;
  for (const preset of seasonPresets) {
    if (keys.has(preset.key)) continue;
    const current = existing.find(template => normalize(template.name) === normalize(preset.name));
    if (current) {
      if (current.key === null) {
        // Adopt only the stable key; preserve all ADMIN content, timestamps and product IDs.
        await db.seasonTemplate.update({ where: { id: current.id }, data: { key: preset.key, updatedAt: current.updatedAt } });
        matched++;
      }
      continue;
    }
    missing.push(preset);
  }
  const created = missing.length ? (await db.seasonTemplate.createMany({ data: missing, skipDuplicates: true })).count : 0;
  return { created, matched, skipped: seasonPresets.length - created, total: seasonPresets.length };
}
