import type { CookieOptions } from 'express';
import { SESSION_TTL } from './auth.service.js';

export const sessionCookie: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL,
};
