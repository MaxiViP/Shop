import { useAuthStore } from "~/stores/auth";
import type { User } from "~/types/user";
export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore();
  const user = await $fetch<User | null>("/auth/me", {
    baseURL: useRuntimeConfig().public.apiBase,
    credentials: "include",
    headers: import.meta.server ? useRequestHeaders(["cookie"]) : undefined,
  });
  auth.set(user);
  if (to.path === "/admin/login") {
    if (user?.role === "ADMIN") return navigateTo("/admin/products");
    return;
  }
  if (!user) return navigateTo("/admin/login");
  if (user.role !== "ADMIN") return navigateTo("/");
});
