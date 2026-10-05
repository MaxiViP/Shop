import { formatAddress } from './address.js';
import { addressSchema, addressUpdateSchema } from '../address/schema.js';
import { addressSchema as checkoutAddress } from '../order/schema.js';

const address = { label: 'Дом', city: 'Москва', street: 'Рыночная', house: '7', flat: '3' };
describe('optional building part', () => {
  it.each(['к. 2', 'корпус 3', 'стр. 1'])('retains free text %s in saved and checkout addresses', buildingPart => {
    for (const schema of [addressSchema, checkoutAddress])
      expect(schema.parse({ ...address, buildingPart: ` ${buildingPart} ` }).buildingPart).toBe(buildingPart);
    expect(formatAddress({ ...address, buildingPart })).toBe(`Москва, Рыночная, д. 7, ${buildingPart}, кв. 3`);
    expect(formatAddress({ ...address, buildingPart }, false)).toBe(`Москва, Рыночная, д. 7, ${buildingPart}`);
  });
  it('supports legacy missing/nullable parts, clearing and length limits', () => {
    expect(addressSchema.parse(address).buildingPart).toBeUndefined();
    expect(checkoutAddress.parse(address).buildingPart).toBeUndefined();
    expect(formatAddress({ ...address, buildingPart: null })).toBe('Москва, Рыночная, д. 7, кв. 3');
    expect(formatAddress({ ...address, buildingPart: '' })).toBe('Москва, Рыночная, д. 7, кв. 3');
    expect(addressUpdateSchema.parse({ buildingPart: ' ' })).toEqual({ buildingPart: '' });
    expect(addressUpdateSchema.safeParse({ buildingPart: 'x'.repeat(51) }).success).toBe(false);
    expect(formatAddress({})).toBe('');
  });
});
