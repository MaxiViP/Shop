import assert from "node:assert/strict";
import test from "node:test";
import { computed } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "../app/stores/auth.ts";
import { headerAccount } from "../app/utils/header-account.ts";

test("guest account opens the existing login flow without a profile or admin route", () => {
  assert.deepEqual(headerAccount(null), {
    to: undefined,
    label: "Войти или зарегистрироваться",
    adminTo: undefined,
  });
});

for (const role of ["USER", "SELLER", "ADMIN"]) {
  test(`${role} has a profile shortcut; only ADMIN has the admin shortcut`, () => {
    assert.deepEqual(headerAccount({ role }), {
      to: "/profile",
      label: "Профиль",
      adminTo: role === "ADMIN" ? "/admin/products" : undefined,
    });
  });
}

test("account actions follow login, role changes and logout through the existing auth store", () => {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  const account = computed(() => headerAccount(auth.user));
  assert.equal(account.value.to, undefined);
  const user = { id: 1, phone: "+79990000000", name: null, verifiedAt: "2026-09-15T00:00:00Z" };
  auth.set({ ...user, role: "USER" });
  assert.equal(account.value.to, "/profile");
  assert.equal(account.value.adminTo, undefined);
  auth.set({ ...user, role: "ADMIN" });
  assert.equal(account.value.adminTo, "/admin/products");
  auth.set({ ...user, role: "SELLER" });
  assert.equal(account.value.adminTo, undefined);
  auth.clear();
  assert.equal(account.value.to, undefined);
  assert.equal(account.value.label, "Войти или зарегистрироваться");
});
