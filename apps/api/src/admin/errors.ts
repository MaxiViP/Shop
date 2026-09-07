import { ConflictException, NotFoundException } from '@nestjs/common';

export function dbError(error: unknown): never {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null;
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
