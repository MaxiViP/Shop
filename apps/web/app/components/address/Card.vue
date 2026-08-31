<template>
  <article class="address">
    <div class="address__head">
      <div class="address__title">
        <strong>
          {{ address.label }}
        </strong>

        <UBadge
          v-if="address.isDefault"
          color="success"
          variant="soft"
        >
          Основной
        </UBadge>
      </div>

      <div class="address__actions">
        <UButton
          icon="i-lucide-pencil"
          variant="ghost"
          color="neutral"
          aria-label="Изменить адрес"
          @click="$emit('edit', address)"
        />

        <UButton
          icon="i-lucide-trash-2"
          variant="ghost"
          color="neutral"
          aria-label="Удалить адрес"
          @click="$emit('remove', address)"
        />
      </div>
    </div>

    <p class="address__text">
      {{ fullAddress }}
    </p>

    <p
      v-if="details"
      class="address__details"
    >
      {{ details }}
    </p>

    <p
      v-if="address.comment"
      class="address__comment"
    >
      {{ address.comment }}
    </p>

    <UButton
      v-if="!address.isDefault"
      variant="link"
      class="address__default"
      @click="$emit('default', address)"
    >
      Сделать основным
    </UButton>
  </article>
</template>

<script setup lang="ts">
import type { Address } from '~/types/address'

const { address } = defineProps<{
  address: Address
}>()

defineEmits<{
  edit: [address: Address]
  remove: [address: Address]
  default: [address: Address]
}>()

const fullAddress = computed(() =>
  [
    address.city,
    address.street,
    `д. ${address.house}`,
    address.flat
      ? `кв. ${address.flat}`
      : null,
  ]
    .filter(Boolean)
    .join(', '),
)

const details = computed(() =>
  [
    address.entrance
      ? `подъезд ${address.entrance}`
      : null,

    address.floor
      ? `этаж ${address.floor}`
      : null,

    address.intercom
      ? `домофон ${address.intercom}`
      : null,
  ]
    .filter(Boolean)
    .join(' · '),
)
</script>

<style scoped>
.address {
  padding: 1.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.address__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.address__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 1.125rem;
}

.address__actions {
  display: flex;
}

.address__text {
  margin-top: 1rem;
}

.address__details,
.address__comment {
  margin-top: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.address__default {
  margin-top: 1rem;
  padding: 0;
}
</style>
