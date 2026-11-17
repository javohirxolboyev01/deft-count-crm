import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { one, pool } from '../db';
import { AppError, forbidden } from './errors';

export type Role = 'LEADER' | 'ACCOUNTANT' | 'OPERATOR';

export interface AuthUser {
  id: number;
  role: Role;
  fullName: string;
  language: 'uz' | 'ru';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(u: { id: number; role: Role }) {
  return jwt.sign({ sub: String(u.id), role: u.role }, config.jwtAccessSecret, { expiresIn: config.accessTtlSec });
}

export async function userFromToken(token: string | undefined): Promise<AuthUser> {
  if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Avtorizatsiya talab qilinadi');
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtAccessSecret) as jwt.JwtPayload;
  } catch {
    throw new AppError(401, 'TOKEN_INVALID', 'Token yaroqsiz yoki muddati tugagan');
  }
  return activeUser(Number(payload.sub));
}

/** Har so'rovda bazadan: faolsizlantirilgan xodim darhol uziladi, rol o'zgarishi darhol kuchga kiradi */
export async function activeUser(id: number): Promise<AuthUser> {
  const u = await one<AuthUser & { active: boolean }>(
    pool,
    `SELECT id, role, full_name AS "fullName", language, active FROM app_user WHERE id = $1`,
    [id],
  );
  if (!u || !u.active) throw new AppError(401, 'TOKEN_INVALID', 'Foydalanuvchi faol emas');
  return { id: u.id, role: u.role, fullName: u.fullName, language: u.language };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  // app.ts'dagi rol guardi bilan ikki marta chaqirilsa, bazaga qayta so'ralmaydi
  if (req.user) return next();
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  req.user = await userFromToken(token);
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Avtorizatsiya talab qilinadi');
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}

export const requireLeader = requireRole('LEADER');
/** Buxgalteriya ishi (mijozlar, vazifalar, jadval): operatorga yopiq */
export const requireStaff = requireRole('LEADER', 'ACCOUNTANT');

export function me(req: Request): AuthUser {
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Avtorizatsiya talab qilinadi');
  return req.user;
}

export const isLeader = (u: AuthUser) => u.role === 'LEADER';
