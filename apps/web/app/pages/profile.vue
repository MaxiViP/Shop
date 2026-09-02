<template>
  <UContainer class="profile">
    <header class="profile__head">
      <div>
        <p class="profile__label">Личный кабинет</p>

        <h1 class="profile__title">Профиль</h1>
      </div>

      <UButton
        variant="ghost"
        color="neutral"
        :loading="logoutLoading"
        @click="logout"
      >
        Выйти
      </UButton>
    </header>

    <section class="profile__user">
      <div class="profile__row">
        <span>Телефон</span>

        <strong>
          {{ auth.user?.phone }}
        </strong>
      </div>

      <div class="profile__row">
        <span>Статус</span>

        <UBadge color="success"> Подтверждён </UBadge>
      </div>

      <div class="profile__row">
        <span>Вход</span>

        <strong> Пароль не требуется </strong>
      </div>
    </section>

    <section class="profile__section">
      <header class="profile__section-head">
        <div>
          <h2 class="profile__section-title">Мои адреса</h2>

          <p class="profile__section-text">
            Используем их при оформлении доставки.
          </p>
        </div>

        <UButton class="profile__add" icon="i-lucide-plus" @click="create">
          Добавить адрес
        </UButton>
      </header>

      <div v-if="addresses?.length" class="profile__addresses">
        <AddressCard
          v-for="address in addresses"
          :key="address.id"
          :address="address"
          @edit="edit"
          @remove="askRemove"
          @default="setDefault"
        />
      </div>

      <div v-else class="profile__empty">
        <UIcon name="i-lucide-map-pin" class="profile__empty-icon" />

        <strong> Адресов пока нет </strong>

        <p>Добавьте адрес, чтобы быстрее оформлять заказы.</p>

        <UButton variant="soft" @click="create"> Добавить адрес </UButton>
      </div>
    </section>
    <section class="profile__section">
      <h2 class="profile__section-title">Заказы</h2>

      <p class="profile__section-text">Текущие заказы и история покупок.</p>

      <div class="profile__orders">
        <OrderList />
      </div>
    </section>
    <AddressModal
      v-model:open="addressOpen"
      :address="selected"
      @saved="refreshAddresses"
    />

    <UModal
      v-model:open="deleteOpen"
      title="Удалить адрес?"
      description="Это действие нельзя отменить."
      :ui="{ content: 'w-[calc(100%-2rem)] max-w-md' }"
    >
      <template #body>
        <div class="delete">
          <p v-if="selected">
            {{ selected.label }} — {{ selected.street }},
            {{ selected.house }}
          </p>

          <div class="delete__actions">
            <UButton
              variant="ghost"
              color="neutral"
              @click="deleteOpen = false"
            >
              Отмена
            </UButton>

            <UButton color="error" :loading="deleteLoading" @click="remove">
              Удалить
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import type { Address } from "~/types/address";
import { useAuthStore } from "~/stores/auth";

const auth = useAuthStore();
const api = useApiClient();
const toast = useToast();

const addressOpen = ref(false);
const deleteOpen = ref(false);

const selected = ref<Address | null>(null);

const logoutLoading = ref(false);
const deleteLoading = ref(false);
const defaultLoading = ref(false);

if (!auth.user) {
  await navigateTo("/");
}

const { data: addresses, refresh: refreshAddresses } = await useApi<Address[]>(
  "/addresses",
  {
    default: () => [],
  },
);

function create() {
  selected.value = null;
  addressOpen.value = true;
}

function edit(address: Address) {
  selected.value = address;
  addressOpen.value = true;
}

function askRemove(address: Address) {
  selected.value = address;
  deleteOpen.value = true;
}

async function setDefault(address: Address) {
  if (defaultLoading.value) return;

  defaultLoading.value = true;

  try {
    await api(`/addresses/${address.id}/default`, {
      method: "PATCH",
    });

    await refreshAddresses();

    toast.add({
      title: "Основной адрес изменён",
    });
  } finally {
    defaultLoading.value = false;
  }
}

async function remove() {
  if (!selected.value) return;

  deleteLoading.value = true;

  try {
    await api(`/addresses/${selected.value.id}`, {
      method: "DELETE",
    });

    deleteOpen.value = false;
    selected.value = null;

    await refreshAddresses();

    toast.add({
      title: "Адрес удалён",
    });
  } finally {
    deleteLoading.value = false;
  }
}

async function logout() {
  logoutLoading.value = true;

  try {
    await api("/auth/logout", {
      method: "POST",
    });

    auth.clear();

    await navigateTo("/");
  } finally {
    logoutLoading.value = false;
  }
}

useSeoMeta({
  title: "Профиль",
});
</script>

<style scoped>
.profile {
  max-width: 56.25rem;
  padding-block: var(--page-start) var(--page-end);
}

.profile :deep(button) {
  min-height: var(--touch-target);
}

.profile__head,
.profile__section-head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.profile__add {
  width: 100%;
  min-height: var(--touch-target);
  justify-content: center;
}

.profile__head {
  margin-bottom: 2rem;
}

.profile__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.profile__title {
  margin-top: 0.25rem;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}

.profile__orders {
  margin-top: 1.5rem;
}

.profile__user {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.profile__row {
  display: grid;
  min-height: 64px;
  grid-template-columns: minmax(5rem, auto) minmax(0, 1fr);
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
}

.profile__row + .profile__row {
  border-top: 1px solid var(--ui-border);
}

.profile__row > span:first-child {
  color: var(--ui-text-muted);
}

.profile__row > :last-child {
  min-width: 0;
  justify-self: end;
  text-align: right;
  overflow-wrap: anywhere;
}

.profile__section {
  margin-top: 3rem;
}

.profile__section-title {
  font-size: var(--section-title);
  font-weight: 700;
}

.profile__section-text {
  margin-top: 0.25rem;
  color: var(--ui-text-muted);
}

.profile__addresses {
  display: grid;
  gap: 1rem;
  margin-top: 1.5rem;
}

.profile__empty {
  display: grid;
  margin-top: 1.5rem;
  padding: clamp(2rem, 8vw, 3rem) 1rem;
  justify-items: center;
  gap: 0.75rem;
  border: 1px dashed var(--ui-border);
  border-radius: 1rem;
  text-align: center;
}

.profile__empty-icon {
  width: 2.5rem;
  height: 2.5rem;
  color: var(--ui-text-muted);
}

.profile__empty p {
  color: var(--ui-text-muted);
}

.delete {
  display: grid;
  gap: 1.5rem;
}

.delete__actions {
  display: flex;
  gap: 0.75rem;
}

.delete__actions > * {
  min-height: var(--touch-target);
  flex: 1;
  justify-content: center;
}

@media (min-width: 40rem) {
  .profile__add {
    width: auto;
  }

  .profile__row {
    padding-inline: 1.25rem;
  }

  .profile__section-head {
    flex-wrap: nowrap;
  }

  .profile__addresses {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .delete__actions {
    justify-content: flex-end;
  }

  .delete__actions > * {
    flex: 0 0 auto;
  }
}
</style>
