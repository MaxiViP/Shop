import type { Prisma } from '../db/gen/client.js';

export const authUserSelect = {
  id: true,
  phone: true,
  name: true,
  role: true,
  verifiedAt: true,
  telegramIdentity: {
    select: {
      username: true,
      firstName: true,
      lastName: true,
      photoUrl: true,
      phoneNumber: true,
      phoneVerified: true,
    },
  },
} as const satisfies Prisma.UserSelect;

type AuthUser = Prisma.UserGetPayload<{ select: typeof authUserSelect }>;

export function authUser(user: AuthUser) {
  const telegram = user.telegramIdentity;
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    role: user.role,
    verifiedAt: user.verifiedAt,
    telegram: telegram
      ? {
          connected: true as const,
          username: telegram.username,
          firstName: telegram.firstName,
          lastName: telegram.lastName,
          photoUrl: telegram.photoUrl,
          phoneNumber: telegram.phoneNumber,
          phoneVerified: telegram.phoneVerified,
        }
      : null,
  };
}
