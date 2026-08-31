import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { User } from "~/types/user";

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | null>(null);

  const loggedIn = computed(() => Boolean(user.value));

  function set(value: User | null) {
    user.value = value;
  }

  function clear() {
    user.value = null;
  }

  return {
    user,
    loggedIn,
    set,
    clear,
  };
});
