import { ConflictException, NotFoundException } from '@nestjs/common';

export function dbError(error: unknown): never {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null;
  const meta = typeof error === 'object' && error !== null && 'meta' in error &&
    typeof error.meta === 'object' && error.meta !== null ? error.meta : null;
  const adapter = meta && 'driverAdapterError' in meta && typeof meta.driverAdapterError === 'object' &&
    meta.driverAdapterError !== null ? meta.driverAdapterError : null;
  const cause = adapter && 'cause' in adapter && typeof adapter.cause === 'object' && adapter.cause !== null
    ? adapter.cause : null;
  const sqlCode = cause && 'originalCode' in cause ? cause.originalCode : meta && 'code' in meta ? meta.code : code;
  if (['55P03', '40P01', '40001'].includes(String(sqlCode)))
    throw new ConflictException('Каталог или настройки сейчас заняты. Повторите действие.');
  if (code === 'P2002') throw new ConflictException('Этот slug уже занят');
  if (code === 'P2025') throw new NotFoundException('Запись не найдена');
  if (code === 'P2003')
    throw new ConflictException(
      'Запись связана с другими данными или выбранная категория не существует',
    );
  if (code === 'P2034')
    throw new ConflictException('Данные изменились. Повторите действие');
  throw error;
}
