import type { User } from "../types/user";

export function recipientDefaults(user: User | null, guestName = "") {
  if (!user) return { name: guestName.trim(), phone: "" };
  const telegramName = [user.telegram?.firstName, user.telegram?.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  return {
    name: user.name?.trim() || telegramName || "",
    phone: user.phone?.trim() ||
      (user.telegram?.phoneVerified ? user.telegram.phoneNumber?.trim() || "" : ""),
  };
}

export function recipientDraft(name = "", phone = "", city = "") {
  return {
    name, phone, city,
    street: "", house: "", flat: "", entrance: "",
    floor: "", intercom: "", comment: "",
  };
}
