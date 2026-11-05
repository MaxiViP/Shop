// Yandex getPremiseNumber() includes корпус/строение in the house number.
// Split only recognisable numbered suffixes; leave ambiguous numbers untouched.
export function splitYandexHouse(raw: string): { house: string; buildingPart: string } {
  const value = raw.trim().replace(/\s+/g, ' ');
  const parts = /^(\d+(?:[/-]\d+)?[a-zа-я]?)[, ]*((?:к(?:орп(?:ус)?)?\.?|стр(?:оение)?\.?|с\.?)\s*\d+[\da-zа-я./ -]*)$/iu.exec(value);
  const house = parts?.[1];
  const buildingPart = parts?.[2];
  if (!house || !buildingPart) return { house: value, buildingPart: '' };
  return { house, buildingPart: buildingPart.trim() };
}
