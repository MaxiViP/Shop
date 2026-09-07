import type { User } from "~/types/user";
import { useAuthStore } from "~/stores/auth";

export function useAdminLogin() {
  const api = useApiClient();
  const auth = useAuthStore();
  return async (phone: string, password: string) => {
    const user = await api<User>("/auth/admin/login", {
      method: "POST",
      body: { phone, password },
    });
    auth.set(user);
  };
}
