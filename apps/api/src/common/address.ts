export interface AddressParts {
  city?: string | null;
  street?: string | null;
  house?: string | null;
  buildingPart?: string | null;
  flat?: string | null;
}

export function formatAddress(address: AddressParts, includeFlat = true) {
  return [address.city, address.street, address.house ? `д. ${address.house}` : null,
    address.buildingPart, includeFlat && address.flat ? `кв. ${address.flat}` : null]
    .filter(part => typeof part === 'string' && part.trim()).join(', ');
}
