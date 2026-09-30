import { pickupDate } from "./pickup.ts";

export type CheckoutField = "name" | "phone" | "city" | "street" | "house" | "deliveryAt";
export type CheckoutErrors = Record<CheckoutField, string>;
export type CheckoutRecipient = {
  name: string;
  phone: string;
  city: string;
  street: string;
  house: string;
};
export type CheckoutSelection = {
  type: "DELIVERY" | "PICKUP";
  pickupTiming: string;
  pickupAt: string;
};

export function validOrderPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && /^[78]/.test(digits));
}

export function checkoutErrors(
  recipient: CheckoutRecipient,
  selection: CheckoutSelection,
  now = Date.now(),
): CheckoutErrors {
  const errors: CheckoutErrors = {
    name: "", phone: "", city: "", street: "", house: "", deliveryAt: "",
  };
  if (!recipient.name.trim()) errors.name = "Введите имя";
  if (!recipient.phone.trim()) errors.phone = "Введите телефон";
  else if (!validOrderPhone(recipient.phone)) errors.phone = "Введите корректный номер телефона";
  if (selection.type === "DELIVERY") {
    if (!recipient.city.trim()) errors.city = "Введите город";
    if (!recipient.street.trim()) errors.street = "Введите улицу";
    if (!recipient.house.trim()) errors.house = "Введите дом";
  } else if (selection.pickupTiming === "scheduled") {
    const date = pickupDate(selection.pickupAt);
    if (!date || date.getTime() <= now)
      errors.deliveryAt = "Укажите дату и время в будущем";
  }
  return errors;
}

export const checkoutFieldOrder: CheckoutField[] = [
  "name", "phone", "city", "street", "house", "deliveryAt",
];

