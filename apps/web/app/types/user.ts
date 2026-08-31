export type UserRole = "USER" | "ADMIN";

export interface User {
  id: number;
  phone: string;
  name: string | null;
  role: UserRole;
  verifiedAt: string;
}
