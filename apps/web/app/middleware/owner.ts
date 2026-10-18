import type { User } from '~/types/user';
import { isPointOwner } from '~/utils/permissions';
export default defineNuxtRouteMiddleware(async () => {
  const auth = useAuthStore();
  const user = await $fetch<User | null>('/auth/me', {
    baseURL: useRuntimeConfig().public.apiBase, credentials: 'include',
    headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  });
  auth.set(user);
  if (!user || !isPointOwner(user)) return navigateTo('/');
});
