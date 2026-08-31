export type UserRole = "USER" | "SELLER" | "ADMIN";

export interface User {
  id: number;
  phone: string;
  name: string | null;
  role: UserRole;
  verifiedAt: string;
}
