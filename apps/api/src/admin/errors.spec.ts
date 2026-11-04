import { ConflictException } from '@nestjs/common';
import { dbError } from './errors.js';

it.each(['55P03', '40P01', '40001'])('translates Prisma adapter SQLSTATE %s to a conflict', originalCode => {
  expect(() => dbError({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode } } } }))
    .toThrow(ConflictException);
});
it('preserves unrecognized errors', () => {
  const error = new Error('Synthetic failure');
  expect(() => dbError(error)).toThrow(error);
});
