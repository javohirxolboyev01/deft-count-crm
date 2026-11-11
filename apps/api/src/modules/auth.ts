import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { me, type Role, requireAuth, signAccessToken } from '../common/auth';
import { audit, diff } from '../common/audit';
import { AppError, parse } from '../common/errors';
import { config } from '../config';
import { one, pool, tx } from '../db';
import { NOTIFICATION_KINDS, notificationKindsFor } from './notifications';
import { clearChatCommands, refreshUserCommands, telegramEnabled } from './telegram';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RT_COOKIE = 'bux_rt';

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
// Rahbar qarori: parol — faqat raqam (6–12 xona, masalan 135792468). Taxmin qilishdan 5 marta xato -> 15 daqiqalik bloklash himoya qiladi.
// Kirish sahifasi ham faqat raqam qabul qiladi: harfli eski parol bo'lsa rahbar uni Xodimlar sahifasidan tiklaydi.
export const passwordSchema = z.string().regex(/^\d{6,12}$/, 'Parol 6–12 ta raqamdan iborat bo\'lishi kerak');

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function issueTokens(res: Response, userId: number, role: Role, replaceId?: number) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const rt = await one<{ id: number }>(
    pool,
    `INSERT INTO refresh_token (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING id`,
    [userId, sha256(raw), config.refreshTtlDays],
  );
  if (replaceId) {
    await pool.query('UPDATE refresh_token SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [replaceId, rt!.id]);
  }
  // Refresh token httpOnly cookie'da (JS o'qiy olmaydi), access token javobda (xotirada saqlanadi)
  res.cookie(RT_COOKIE, raw, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.refreshTtlDays * 86400 * 1000,
  });
  return { accessToken: signAccessToken({ id: userId, role }), expiresIn: config.accessTtlSec };
}

const PROFILE = `id, role, full_name AS "fullName", login, language, active,
  (telegram_chat_id IS NOT NULL) AS "telegramLinked", notification_prefs AS "notificationPrefs"`;

export const authRouter = Router();

// IP bo'yicha login urinishlari cheklovi (hisob bloklashga qo'shimcha)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Juda ko\'p urinish. Keyinroq qayta urining.', details: null },
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { login, password } = parse(z.object({ login: z.string().trim().min(1), password: z.string().min(1) }), req.body);
  const u = await one<any>(
    pool,
    `SELECT id, role, password_hash, active, failed_login_count, locked_until > now() AS locked FROM app_user WHERE login = $1`,
    [login],
  );
  if (u?.locked) throw new AppError(423, 'ACCOUNT_LOCKED', `Hisob ${LOCK_MINUTES} daqiqaga bloklangan`);
  const ok = u && u.active && (await bcrypt.compare(password, u.password_hash));
  if (!ok) {
    if (u) {
      await pool.query(
        `UPDATE app_user SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) END
         WHERE id = $1`,
        [u.id, MAX_FAILED, LOCK_MINUTES],
      );
    }
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Login yoki parol noto\'g\'ri');
  }
  await pool.query('UPDATE app_user SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [u.id]);
  const tokens = await issueTokens(res, u.id, u.role);
  const user = await one(pool, `SELECT ${PROFILE} FROM app_user WHERE id = $1`, [u.id]);
  res.json({ ...tokens, user });
});

authRouter.post('/refresh', async (req, res) => {
  const raw = req.cookies?.[RT_COOKIE];
  if (!raw) throw new AppError(401, 'NO_REFRESH', 'Qayta kirish talab qilinadi');
  const rt = await one<any>(
    pool,
    `SELECT r.id, r.user_id, r.revoked_at, r.replaced_by, r.revoked_at > now() - interval '30 seconds' AS recently_revoked,
            r.expires_at < now() AS expired, u.role, u.active
     FROM refresh_token r JOIN app_user u ON u.id = r.user_id WHERE r.token_hash = $1`,
    [sha256(raw)],
  );
  if (!rt) throw new AppError(401, 'NO_REFRESH', 'Qayta kirish talab qilinadi');
  if (rt.revoked_at && rt.replaced_by && rt.recently_revoked) {
    // Bir nechta tab bir vaqtda yangiladi: o'g'irlik emas, mijoz yangi cookie bilan qayta urinadi
    throw new AppError(401, 'REFRESH_RACE', 'Token hozirgina yangilandi, qayta urining');
  }
  if (rt.revoked_at) {
    // Eski (aylantirilgan) token qayta ishlatildi: o'g'irlangan bo'lishi mumkin -> barcha sessiyalar yopiladi
    await pool.query('UPDATE refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rt.user_id]);
    throw new AppError(401, 'REFRESH_REUSED', 'Sessiya yopildi, qayta kiring');
  }
  if (rt.expired || !rt.active) throw new AppError(401, 'NO_REFRESH', 'Qayta kirish talab qilinadi');
  const tokens = await issueTokens(res, rt.user_id, rt.role, rt.id);
  const user = await one(pool, `SELECT ${PROFILE} FROM app_user WHERE id = $1`, [rt.user_id]);
  res.json({ ...tokens, user });
});

authRouter.post('/logout', async (req, res) => {
  const raw = req.cookies?.[RT_COOKIE];
  if (raw) await pool.query('UPDATE refresh_token SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(raw)]);
  res.clearCookie(RT_COOKIE, { path: '/api/auth' });
  res.json({ ok: true });
});

// ---------- /api/me ----------
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', async (req, res) => {
  const user = await one(pool, `SELECT ${PROFILE} FROM app_user WHERE id = $1`, [me(req).id]);
  res.json({ ...user, telegramBotEnabled: telegramEnabled(), telegramBotUsername: config.telegram.username || null, notificationKinds: notificationKindsFor(user.role) });
});

const prefsSchema = z.record(
  z.enum(NOTIFICATION_KINDS),
  z.object({ app: z.boolean().optional(), telegram: z.boolean().optional() }),
);

meRouter.patch('/', async (req, res) => {
  const u = me(req);
  const body = parse(z.object({ language: z.enum(['uz', 'ru']).optional(), notificationPrefs: prefsSchema.optional() }), req.body);
  const user = await tx(async (db) => {
    const before = await one(db, 'SELECT language, notification_prefs AS "notificationPrefs" FROM app_user WHERE id = $1', [u.id]);
    const r = await one(
      db,
      `UPDATE app_user SET language = coalesce($2, language), notification_prefs = coalesce($3, notification_prefs)
       WHERE id = $1 RETURNING ${PROFILE}`,
      [u.id, body.language ?? null, body.notificationPrefs ? JSON.stringify(body.notificationPrefs) : null],
    );
    const d = diff(before, body);
    if (d.changed) await audit(db, { actorId: u.id, entity: 'app_user', entityId: u.id, action: 'UPDATE_PROFILE', before: d.before, after: d.after });
    return r;
  });
  if (body.language) refreshUserCommands(u.id);
  res.json(user);
});

meRouter.post('/password', async (req, res) => {
  const u = me(req);
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body);
  const row = await one<{ password_hash: string }>(pool, 'SELECT password_hash FROM app_user WHERE id = $1', [u.id]);
  if (!(await bcrypt.compare(body.currentPassword, row!.password_hash))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Joriy parol noto\'g\'ri');
  }
  await tx(async (db) => {
    await db.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.newPassword)]);
    await audit(db, { actorId: u.id, entity: 'app_user', entityId: u.id, action: 'CHANGE_PASSWORD' });
  });
  res.json({ ok: true });
});

/** Telegram bog'lash: bir martalik kod (15 daqiqa). Xodim botga /start <kod> yuboradi. */
meRouter.post('/telegram/code', async (req, res) => {
  const u = me(req);
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const r = await one(
    pool,
    `UPDATE app_user SET telegram_link_code = $2, telegram_link_expires_at = now() + interval '15 minutes'
     WHERE id = $1 RETURNING telegram_link_expires_at AS "expiresAt"`,
    [u.id, code],
  );
  const username = config.telegram.username;
  res.json({
    code,
    expiresAt: r.expiresAt,
    botEnabled: telegramEnabled(),
    deepLink: username ? `https://t.me/${username}?start=${code}` : null,
  });
});

meRouter.delete('/telegram', async (req, res) => {
  const u = me(req);
  const tg = await one<{ chatId: string | null }>(pool, 'SELECT telegram_chat_id AS "chatId" FROM app_user WHERE id = $1', [u.id]);
  await tx(async (db) => {
    await db.query('UPDATE app_user SET telegram_chat_id = NULL WHERE id = $1', [u.id]);
    await audit(db, { actorId: u.id, entity: 'app_user', entityId: u.id, action: 'TELEGRAM_UNLINK' });
  });
  if (tg?.chatId) void clearChatCommands(Number(tg.chatId));
  res.json({ ok: true });
});
