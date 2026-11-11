import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth, requireLeader, requireStaff } from '../common/auth';
import { audit, diff } from '../common/audit';
import { AppError, notFound, parse } from '../common/errors';
import { one, pool, q, tx } from '../db';
import { backfillCallUser } from './calls';
import { reassignOpenTasks } from './generator';
import { clearChatCommands, refreshUserCommands } from './telegram';
import { hashPassword, passwordSchema } from './auth';

// Asterisk ichki raqami (V46): '101'; bo'sh satr = olib tashlash
const phoneExt = z
  .string()
  .trim()
  .max(32)
  .regex(/^[0-9A-Za-z_.-]*$/, 'Ichki raqam: faqat raqam/harf')
  .transform((v) => v || null);

/** Bitta ichki raqam bitta xodimda (ux_app_user_phone_ext) */
function extTaken(e: unknown): never {
  if ((e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'ux_app_user_phone_ext') {
    throw new AppError(409, 'PHONE_EXT_TAKEN', 'Bu ichki raqam boshqa xodimga biriktirilgan');
  }
  throw e;
}

const USER = `id, role, full_name AS "fullName", login, language, active, phone_ext AS "phoneExt",
  (telegram_chat_id IS NOT NULL) AS "telegramLinked", created_at AS "createdAt"`;

export const usersRouter = Router();

// Buxgalterlar ro'yxati (tanlash uchun) hamma xodimga ochiq, qolgani faqat rahbar
usersRouter.get('/accountants', requireAuth, async (_req, res) => {
  res.json(
    await q(
      pool,
      `SELECT u.id, u.full_name AS "fullName", l.open_count AS "openCount"
       FROM app_user u LEFT JOIN v_accountant_load l ON l.user_id = u.id
       WHERE u.role = 'ACCOUNTANT' AND u.active ORDER BY u.full_name`,
    ),
  );
});

usersRouter.get('/report-pdf-info', requireAuth, requireStaff, async (req, res) => {
  const actor = me(req);
  res.json({
    downloadedByName: actor.fullName,
    downloadedByRole: actor.role,
  });
});

usersRouter.use(requireAuth, requireLeader);

usersRouter.get('/', async (_req, res) => {
  res.json(await q(pool, `SELECT ${USER} FROM app_user WHERE deleted_at IS NULL ORDER BY active DESC, role, full_name`));
});

usersRouter.post('/', async (req, res) => {
  const actor = me(req);
  const body = parse(
    z.object({
      fullName: z.string().trim().min(2).max(200),
      login: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/),
      password: passwordSchema,
      role: z.enum(['LEADER', 'ACCOUNTANT', 'OPERATOR']),
      language: z.enum(['uz', 'ru']).default('uz'),
      phoneExt: phoneExt.optional(),
    }),
    req.body,
  );
  const user = await tx(async (db) => {
    const u = await one(
      db,
      `INSERT INTO app_user (full_name, login, password_hash, role, language, phone_ext)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${USER}`,
      [body.fullName, body.login, await hashPassword(body.password), body.role, body.language, body.phoneExt ?? null],
    );
    if (u.phoneExt) await backfillCallUser(db, u.id, u.phoneExt);
    await audit(db, { actorId: actor.id, entity: 'app_user', entityId: u.id, action: 'CREATE', after: u });
    return u;
  }).catch(extTaken);
  res.status(201).json(user);
});

usersRouter.patch('/:id', async (req, res) => {
  const actor = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const body = parse(
    z.object({
      fullName: z.string().trim().min(2).max(200).optional(),
      role: z.enum(['LEADER', 'ACCOUNTANT', 'OPERATOR']).optional(),
      language: z.enum(['uz', 'ru']).optional(),
      active: z.boolean().optional(),
      phoneExt: phoneExt.optional(),
    }),
    req.body,
  );
  if (id === actor.id && (body.active === false || (body.role && body.role !== 'LEADER'))) {
    throw new AppError(400, 'SELF_LOCKOUT', 'O\'zingizni faolsizlantira yoki rolingizni pasaytira olmaysiz');
  }
  const user = await tx(async (db) => {
    const before = await one(db, `SELECT ${USER} FROM app_user WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    if (!before) throw notFound('Foydalanuvchi');
    const u = await one(
      db,
      `UPDATE app_user SET full_name = coalesce($2, full_name), role = coalesce($3, role),
         language = coalesce($4, language), active = coalesce($5, active),
         phone_ext = CASE WHEN $6 THEN $7 ELSE phone_ext END
       WHERE id = $1 RETURNING ${USER}`,
      [id, body.fullName ?? null, body.role ?? null, body.language ?? null, body.active ?? null,
       body.phoneExt !== undefined, body.phoneExt ?? null],
    );
    if (body.phoneExt) await backfillCallUser(db, id, body.phoneExt);
    // Faolsizlantirilsa (o'chirilmaydi) sessiyalari yopiladi
    if (body.active === false) {
      await db.query('UPDATE refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    const d = diff(before, body);
    if (d.changed) await audit(db, { actorId: actor.id, entity: 'app_user', entityId: id, action: 'UPDATE', before: d.before, after: d.after });
    return u;
  }).catch(extTaken);
  // Telegram menyusi rolga mos bo'lsin (rahbar buyruqlari buxgalterga ko'rinmasin)
  if (body.role || body.language || body.active !== undefined) refreshUserCommands(id);
  res.json(user);
});

// O'chirish: ish tarixi yo'q xodim bazadan butunlay o'chadi. Tarixi bor xodim (vazifa, audit_log, qo'ng'iroq, taymer)
// jismonan o'chirilmaydi — audit_log o'zgarmas (CLAUDE.md 9). U deleted_at bilan hamma ro'yxatdan yashiriladi,
// kira olmaydi, login bo'shatiladi; mijozlari va ochiq vazifalari buxgalterisiz qoladi (rahbar qayta tayinlaydi).
usersRouter.delete('/:id', async (req, res) => {
  const actor = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  if (id === actor.id) throw new AppError(400, 'SELF_DELETE', 'O\'zingizni o\'chira olmaysiz');
  const before = await one(pool, `SELECT ${USER} FROM app_user WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!before) throw notFound('Foydalanuvchi');
  const tg = await one<{ chatId: string | null }>(pool, 'SELECT telegram_chat_id AS "chatId" FROM app_user WHERE id = $1', [id]);
  if (tg?.chatId) void clearChatCommands(Number(tg.chatId));
  try {
    await tx(async (db) => {
      await db.query('DELETE FROM refresh_token WHERE user_id = $1', [id]);
      await db.query('DELETE FROM notification WHERE user_id = $1', [id]);
      await db.query('DELETE FROM app_user WHERE id = $1', [id]);
      await audit(db, { actorId: actor.id, entity: 'app_user', entityId: id, action: 'DELETE', before });
    });
    return res.json({ ok: true });
  } catch (e) {
    if ((e as { code?: string }).code !== '23503') throw e;
  }
  // Tarixi bor: yashiriladi (yuqoridagi tranzaksiya to'liq bekor bo'lgan)
  await tx(async (db) => {
    const clients = await q<{ id: number }>(db, 'SELECT id FROM client WHERE accountant_id = $1 FOR UPDATE', [id]);
    for (const c of clients) {
      await db.query('UPDATE client SET accountant_id = NULL WHERE id = $1', [c.id]);
      await audit(db, { actorId: actor.id, entity: 'client', entityId: c.id, clientId: c.id, action: 'UPDATE', before: { accountantId: id }, after: { accountantId: null } });
      await reassignOpenTasks(db, c.id, null, actor.id);
    }
    // Boshqa mijozlardagi ochiq vazifalari (shoshilinch, qo'lda) ham bo'shatiladi
    const rest = await q<{ id: number; clientId: number }>(
      db,
      `UPDATE task SET assignee_id = NULL WHERE assignee_id = $1 AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
       RETURNING id, client_id AS "clientId"`,
      [id],
    );
    for (const t of rest) {
      await audit(db, { actorId: actor.id, entity: 'task', entityId: t.id, clientId: t.clientId, action: 'REASSIGN', before: { assigneeId: id }, after: { assigneeId: null } });
    }
    await db.query('UPDATE time_entry SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [id]);
    await db.query('DELETE FROM refresh_token WHERE user_id = $1', [id]);
    await db.query("UPDATE notification SET cancelled_at = now() WHERE user_id = $1 AND delivered_at IS NULL AND cancelled_at IS NULL", [id]);
    // '~' login qoidasida yo'q: yangi xodim shu loginni bemalol oladi
    await db.query(
      `UPDATE app_user SET deleted_at = now(), active = false, telegram_chat_id = NULL, phone_ext = NULL,
         login = login || '~' || id WHERE id = $1`,
      [id],
    );
    await audit(db, { actorId: actor.id, entity: 'app_user', entityId: id, action: 'DELETE', before });
  });
  res.json({ ok: true });
});

usersRouter.post('/:id/reset-password', async (req, res) => {
  const actor = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const { password } = parse(z.object({ password: passwordSchema }), req.body);
  await tx(async (db) => {
    const r = await db.query(
      'UPDATE app_user SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL',
      [id, await hashPassword(password)],
    );
    if (!r.rowCount) throw notFound('Foydalanuvchi');
    await db.query('UPDATE refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(db, { actorId: actor.id, entity: 'app_user', entityId: id, action: 'RESET_PASSWORD' });
  });
  res.json({ ok: true });
});

/**
 * Asosiy rahbar (.env: BOOTSTRAP_LEADER_*): shu login bazada bo'lmasa ishga tushishda yaratiladi.
 * Bor bo'lsa tegilmaydi — parolni u keyin Profil'da o'zgartirsa, har deploy'da eskisiga qaytmasin.
 * Shunday qilib serverga (Railway) faqat o'zgaruvchilarni qo'yish yetadi, qolgan xodimlarni rahbar saytdan qo'shadi.
 */
export async function bootstrapLeader(login: string, password: string, fullName: string) {
  if (!login || !password) return false;
  const exists = await one(pool, 'SELECT id FROM app_user WHERE login = $1', [login]);
  if (exists) return false;
  passwordSchema.parse(password);
  await pool.query(
    `INSERT INTO app_user (full_name, login, password_hash, role) VALUES ($1, $2, $3, 'LEADER')`,
    [fullName, login, await hashPassword(password)],
  );
  console.log(`Asosiy rahbar yaratildi: ${login}`);
  return true;
}
