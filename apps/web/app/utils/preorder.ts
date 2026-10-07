import type { QueueOffer } from '~/types/order';

export function preorderLabel(offer: Pick<QueueOffer, 'market' | 'preparationStartsAt'>) {
  if (!offer.preparationStartsAt) return 'Предзаказы принимаются. Выберите доступное время подготовки.';
  const at = new Date(offer.preparationStartsAt);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(at);
  const tomorrow = new Date(Date.parse(offer.market.today + 'T00:00:00.000Z') + 86400_000).toISOString().slice(0, 10);
  const when = day === offer.market.today ? 'сегодня' : day === tomorrow ? 'завтра'
    : new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' }).format(at);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(at);
  return (offer.market.isOpen ? 'Сегодня уже не успеем собрать заказ.' : 'Рынок сейчас закрыт.')
    + ' Заказ можно оформить сейчас. Сборка начнётся ' + when + ' после ' + time + '.';
}
