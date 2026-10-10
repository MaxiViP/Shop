import type { HitMode, SeasonGroup } from '../types/badges';

export const hitModes: { label: string; value: HitMode }[] = [
  { label: 'AUTO · по завершённым продажам', value: 'AUTO' },
  { label: 'MANUAL · включить ХИТ', value: 'MANUAL' },
  { label: 'OFF · выключить ХИТ', value: 'OFF' },
];
export const seasonGroups: { label: string; value: SeasonGroup }[] = [
  { label: 'Овощи', value: 'VEGETABLES' },
  { label: 'Фрукты и бахчевые', value: 'FRUITS' },
  { label: 'Ягоды', value: 'BERRIES' },
];
export function seasonGroupLabel(group: SeasonGroup | null) {
  return seasonGroups.find(item => item.value === group)?.label ?? 'Другие шаблоны';
}
