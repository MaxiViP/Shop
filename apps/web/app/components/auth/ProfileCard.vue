<template>
  <section class="account" aria-label="Аккаунт">
    <div v-if="user.telegram" class="account__telegram">
      <UAvatar
        :src="user.telegram.photoUrl ?? undefined"
        :alt="displayName"
        :text="displayName.slice(0, 1)"
        icon="i-lucide-send"
        size="3xl"
        referrerpolicy="no-referrer"
        class="account__avatar"
      />
      <div class="account__identity">
        <h2 class="account__name">{{ displayName }}</h2>
        <p v-if="user.telegram.username" class="account__username">
          @{{ user.telegram.username }}
        </p>
        <UBadge color="success" variant="soft" icon="i-lucide-check">
          Telegram подключен
        </UBadge>
      </div>
    </div>
    <div v-else class="account__row">
      <span>Способ входа</span>
      <strong>{{ user.role === "ADMIN" ? "Пароль администратора" : "По телефону" }}</strong>
    </div>
    <div v-if="user.telegram" class="account__row">
      <span>Телефон Telegram</span>
      <div class="account__value">
        <template v-if="user.telegram.phoneNumber">
          <strong>{{ user.telegram.phoneNumber }}</strong>
          <UBadge
            v-if="user.telegram.phoneVerified"
            color="success"
            variant="soft"
            icon="i-lucide-badge-check"
          >
            Подтверждено Telegram
          </UBadge>
        </template>
        <span v-else class="account__muted">Номер Telegram не предоставлен</span>
      </div>
    </div>
    <div class="account__row">
      <span>Телефон для заказов</span>
      <strong v-if="user.phone">{{ user.phone }}</strong>
      <span v-else class="account__muted">Телефон для заказов не указан</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { User } from "~/types/user";

const props = defineProps<{ user: User }>();
const displayName = computed(() =>
  props.user.name?.trim()
  || [props.user.telegram?.firstName, props.user.telegram?.lastName].filter(Boolean).join(" ")
  || props.user.telegram?.username
  || "Покупатель",
);
</script>

<style scoped>
.account {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: var(--ui-bg);
}
.account__telegram {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
}
.account__avatar {
  width: 5rem;
  height: 5rem;
  flex: 0 0 5rem;
}
.account__identity {
  min-width: 0;
}
.account__name {
  font-size: clamp(1.125rem, 3vw, 1.5rem);
  font-weight: 700;
  overflow-wrap: anywhere;
}
.account__username {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
  margin-block: 0.125rem 0.5rem;
}
.account__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.875rem 1rem;
}
.account__row + .account__row,
.account__telegram + .account__row {
  border-top: 1px solid var(--ui-border);
}
.account__row > span:first-child,
.account__muted {
  color: var(--ui-text-muted);
}
.account__row > *,
.account__value {
  min-width: 0;
  overflow-wrap: anywhere;
}
.account__value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
</style>
