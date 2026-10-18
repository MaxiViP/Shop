import type { User } from '../types/user';
export function isPointOwner(user: Pick<User, 'ownedPoints'> | null) { return !!user?.ownedPoints?.length; }
export function isStaff(user: Pick<User, 'role' | 'ownedPoints'> | null) {
  return user?.role === 'SELLER' || user?.role === 'ADMIN' || isPointOwner(user);
}
