// The single pickup point is in Moscow (UTC+03:00).
export function pickupDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const date = new Date(`${value}+03:00`)
  if (!Number.isFinite(date.getTime())) return null
  const local = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  return local.toISOString().slice(0, 16) === value ? date : null
}

export function pickupTime(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow',
  })
}
