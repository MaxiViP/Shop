import type { DeliveryAddress } from '../types/delivery-estimate';

export function estimateAddress(address: DeliveryAddress) {
  return {
    city: address.city.trim(), street: address.street.trim(), house: address.house.trim(),
    buildingPart: address.buildingPart?.trim() || undefined,
    ...(address.lat != null && address.lng != null ? { lat: address.lat, lng: address.lng } : {}),
  };
}

export function deliveryAddressKey(address: DeliveryAddress | null) {
  return address ? JSON.stringify(estimateAddress(address)) : '';
}
