import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Address } from '~/types/address';
import type { DeliveryAddress, DeliveryEstimate } from '~/types/delivery-estimate';
import { deliveryAddressKey, estimateAddress } from '../utils/delivery-estimate.ts';

export const useDeliveryStore = defineStore('delivery', () => {
  const api = useApiClient();
  const selected = ref<DeliveryAddress | null>(null);
  const addresses = ref<Address[]>([]);
  const quote = ref<DeliveryEstimate | null>(null);
  const pending = ref(false);
  const error = ref('');
  const addressError = ref('');
  const now = ref(Date.now());
  const stale = computed(() => !!quote.value && Date.parse(quote.value.expiresAt) <= now.value);
  let owner: number | null = null;
  let revision = 0;
  let addressRevision = 0;
  let retryAt = 0;
  let abort: AbortController | undefined;
  let requestedKey = '';

  async function refresh(force = false) {
    now.value = Date.now();
    if (!selected.value) return;
    const key = deliveryAddressKey(selected.value);
    if (pending.value && requestedKey === key) return;
    if (!force && (retryAt > now.value || (quote.value && !stale.value))) return;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const version = ++revision;
    requestedKey = key;
    pending.value = true;
    error.value = '';
    try {
      const result = await api<DeliveryEstimate>('/delivery/estimate', {
        method: 'POST', body: estimateAddress(selected.value),
        signal: controller.signal, retry: 0,
      });
      if (version !== revision) return;
      quote.value = result;
      retryAt = 0;
    } catch {
      if (version !== revision) return;
      error.value = 'Не удалось обновить стоимость. Проверьте адрес или повторите позже.';
      retryAt = Date.now() + 60_000;
    } finally {
      if (version === revision) pending.value = false;
    }
  }

  function select(address: DeliveryAddress | null, remember = true) {
    const changed = deliveryAddressKey(selected.value) !== deliveryAddressKey(address);
    selected.value = address;
    if (remember && owner !== null && import.meta.client) {
      try {
        if (address?.id) localStorage.setItem(`delivery-address:${owner}`, String(address.id));
        else localStorage.removeItem(`delivery-address:${owner}`);
      } catch { /* Selecting an address also works without browser storage. */ }
    }
    if (changed) {
      ++revision;
      abort?.abort();
      quote.value = null;
      pending.value = false;
      error.value = '';
      retryAt = 0;
    }
    void refresh();
  }

  async function loadAddresses(preferDefault = false) {
    if (owner === null) return;
    const version = ++addressRevision;
    addressError.value = '';
    try {
      const result = await api<Address[]>('/addresses', { retry: 0 });
      if (version !== addressRevision) return;
      addresses.value = result;
      let savedId: number | undefined;
      if (!selected.value && import.meta.client) {
        try { savedId = Number(localStorage.getItem(`delivery-address:${owner}`)) || undefined; } catch { /* Optional. */ }
      }
      if (preferDefault || !selected.value || selected.value.id) {
        const currentId = preferDefault ? undefined : selected.value?.id ?? savedId;
        select(result.find(address => address.id === currentId)
          ?? result.find(address => address.isDefault) ?? result[0] ?? null);
      }
    } catch {
      if (version === addressRevision) addressError.value = 'Не удалось загрузить сохранённые адреса.';
    }
  }

  async function initialize(userId: number | null) {
    ++addressRevision;
    owner = userId;
    addresses.value = [];
    addressError.value = '';
    // Never carry an account's private address or quote into another session.
    select(null, false);
    await loadAddresses();
  }

  function stop() {
    ++revision;
    ++addressRevision;
    abort?.abort();
    pending.value = false;
  }

  return { selected, addresses, quote, pending, error, addressError, now, stale,
    select, refresh, loadAddresses, initialize, stop };
});
