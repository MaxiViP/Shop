export type UserRole = "USER" | "SELLER" | "ADMIN";

export interface TelegramProfile {
  connected: true;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
}

export interface User {
  id: number;
  phone: string | null;
  name: string | null;
  role: UserRole;
  verifiedAt: string | null;
  telegram: TelegramProfile | null;
}
