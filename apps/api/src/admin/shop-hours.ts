import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';

type Calendar = {
  weekly: { weekday: number; enabled: boolean; openMinutes: number; closeMinutes: number }[];
  exceptions: { date: Date; closed: boolean; openMinutes: number | null; closeMinutes: number | null }[];
};
const zone = 'Europe/Moscow';
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function parts(at: Date) {
  const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}
function addDays(day: string, count: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function localInstant(day: string, minute: number) {
  const [year, month, date] = day.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, date, Math.floor(minute / 60), minute % 60);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const wall = parts(new Date(guess));
    const [y, m, d] = wall.date.split('-').map(Number);
    guess += desired - Date.UTC(y, m - 1, d, Math.floor(wall.minute / 60), wall.minute % 60);
  }
  return new Date(guess);
}
function hours(day: string, calendar: Calendar) {
  const exception = calendar.exceptions.find(row => row.date.toISOString().slice(0, 10) === day);
  if (exception) return exception.closed ? null : {
    openMinutes: exception.openMinutes!, closeMinutes: exception.closeMinutes!,
  };
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay() || 7;
  const weekly = calendar.weekly.find(row => row.weekday === weekday);
  return weekly?.enabled ? { openMinutes: weekly.openMinutes, closeMinutes: weekly.closeMinutes } : null;
}
function clock(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
export async function loadCalendar(db: Prisma.TransactionClient) {
  const [weekly, exceptions] = await Promise.all([
    db.shopHours.findMany(), db.shopHoursException.findMany(),
  ]);
  return { weekly, exceptions };
}
export function isMarketOpenAt(calendar: Calendar, at: Date) {
  const wall = parts(at);
  const today = hours(wall.date, calendar);
  return Boolean(today && wall.minute >= today.openMinutes && wall.minute < today.closeMinutes);
}
export function marketStatusAt(calendar: Calendar, at: Date) {
  const wall = parts(at);
  const today = hours(wall.date, calendar);
  const isOpen = Boolean(today && wall.minute >= today.openMinutes && wall.minute < today.closeMinutes);
  let nextOpenAt: string | null = null;
  if (!isOpen) {
    for (let i = 0; i <= 366; i++) {
      const day = addDays(wall.date, i);
      const range = hours(day, calendar);
      if (range && (i > 0 || wall.minute < range.openMinutes)) {
        nextOpenAt = localInstant(day, range.openMinutes).toISOString();
        break;
      }
    }
  }
  return {
    isOpen, timezone: zone, today: wall.date,
    openTime: today ? clock(today.openMinutes) : null,
    closeTime: today ? clock(today.closeMinutes) : null,
    nextOpenAt,
  };
}
export async function assertMarketTime(db: Prisma.TransactionClient, at: Date, requested?: Date) {
  const calendar = await loadCalendar(db);
  const target = parts(requested ?? at);
  const range = hours(target.date, calendar);
  if (range && target.minute >= range.openMinutes && target.minute < range.closeMinutes) return;
  const status = marketStatusAt(calendar, at);
  throw new ConflictException({
    code: requested ? 'SHOP_HOURS_INVALID' : 'SHOP_CLOSED',
    message: requested ? 'Выбранное время вне графика работы рынка.' : 'Рынок сейчас закрыт.',
    nextOpenAt: status.nextOpenAt,
  });
}
export function moscowDay(at: Date) { return parts(at).date; }
export function moscowMinute(at: Date) { return parts(at).minute; }
export { addDays };
