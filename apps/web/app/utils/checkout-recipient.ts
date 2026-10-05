import type { User } from "../types/user";

export function effectiveOrderPhone(user: User | null) {
  if (!user) return "";
  return user.phone?.trim() ||
    (user.telegram?.phoneVerified ? user.telegram.phoneNumber?.trim() || "" : "");
}

export function recipientDefaults(user: User | null, guestName = "", primaryPhone = "") {
  if (!user) return { name: guestName.trim(), phone: "" };
  const telegramName = [user.telegram?.firstName, user.telegram?.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  return {
    name: user.name?.trim() || telegramName || "",
    phone: primaryPhone.trim() || effectiveOrderPhone(user),
  };
}

export function recipientDraft(name = "", phone = "", city = "") {
  return {
    name, phone, city,
    street: "", house: "", buildingPart: "", flat: "", entrance: "",
    floor: "", intercom: "", comment: "",
  };
}
