import type { User } from "../types/user";

export function headerAccount(user: Pick<User, "role"> | null) {
  return {
    to: user ? "/profile" : undefined,
    label: user ? "Профиль" : "Войти или зарегистрироваться",
    adminTo: user?.role === "ADMIN" ? "/admin/products" : undefined,
  };
}
