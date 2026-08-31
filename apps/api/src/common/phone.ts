import { BadRequestException } from '@nestjs/common';

export function phone(value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException('Некорректный номер телефона');
  }

  let digits = value.replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    digits = `7${digits}`;
  }

  if (digits.length !== 11 || !digits.startsWith('7')) {
    throw new BadRequestException('Некорректный номер телефона');
  }

  return `+${digits}`;
}
