import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth } from '../common/auth';
import { forbidden, notFound, parse } from '../common/errors';
import { one, pool, q } from '../db';
import { emitToUser } from './events';

// Ichki chat: barcha rollar (rahbar, buxgalter, operator) bir-biri bilan 1:1 yozishadi.
// Real vaqt — mavjud SSE oqimi orqali (`chat-message`, `chat-read` hodisalari); Telegram'ga yuborilmaydi.
export const chatRouter = Router();
chatRouter.use(requireAuth);

const MSG = `id, sender_id AS "senderId", recipient_id AS "recipientId", body, created_at AS "createdAt", read_at AS "readAt",
             edited_at AS "editedAt"`;

const userId = (v: unknown) => parse(z.coerce.number().int().positive(), v);

/** Suhbatdoshlar: faol xodimlar (+ yozishmasi bor faolsizlantirilganlar), oxirgi xabar va o'qilmaganlar soni bilan */
chatRouter.get('/contacts', async (req, res) => {
  const u = me(req);
  const items = await q(
    pool,
    `WITH mine AS (
       SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other, m.*
       FROM chat_message m WHERE (sender_id = $1 OR recipient_id = $1) AND deleted_at IS NULL
     ), last AS (
       SELECT DISTINCT ON (other) other, id, body, sender_id, created_at, read_at FROM mine ORDER BY other, id DESC
     ), unread AS (
       SELECT sender_id AS other, count(*) AS n FROM chat_message
       WHERE recipient_id = $1 AND read_at IS NULL AND deleted_at IS NULL GROUP BY sender_id
     )
     SELECT u.id, u.full_name AS "fullName", u.role, u.active,
            coalesce(un.n, 0) AS unread,
            CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object(
              'id', l.id, 'body', l.body, 'senderId', l.sender_id, 'createdAt', l.created_at, 'readAt', l.read_at
            ) END AS "lastMessage"
     FROM app_user u
     LEFT JOIN last l ON l.other = u.id
     LEFT JOIN unread un ON un.other = u.id
     WHERE u.id <> $1 AND (u.active OR l.id IS NOT NULL)
     ORDER BY l.id DESC NULLS LAST, u.full_name`,
    [u.id],
  );
  res.json(items);
});

chatRouter.get('/unread-count', async (req, res) => {
  const r = await one<{ n: number; chats: number }>(
    pool,
    `SELECT count(*) AS n, count(DISTINCT sender_id) AS chats FROM chat_message
     WHERE recipient_id = $1 AND read_at IS NULL AND deleted_at IS NULL`,
    [me(req).id],
  );
  res.json({ count: r!.n, chats: r!.chats });
});

/** Suhbat tarixi: eng yangisidan orqaga sahifalab (before = eng eski ko'rilgan xabar id'si) */
chatRouter.get('/with/:userId', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  const { before, limit } = parse(
    z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    req.query,
  );
  const rows = await q(
    pool,
    `SELECT ${MSG} FROM chat_message
     WHERE deleted_at IS NULL
       AND least(sender_id, recipient_id) = least($1::bigint, $2::bigint)
       AND greatest(sender_id, recipient_id) = greatest($1::bigint, $2::bigint)
       ${before ? 'AND id < $4' : ''}
     ORDER BY id DESC LIMIT $3`,
    before ? [u.id, other, limit + 1, before] : [u.id, other, limit + 1],
  );
  const hasMore = rows.length > limit;
  res.json({ items: rows.slice(0, limit).reverse(), hasMore });
});

chatRouter.post('/with/:userId', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const target = await one<{ active: boolean }>(pool, 'SELECT active FROM app_user WHERE id = $1', [other]);
  if (!target?.active || other === u.id) throw notFound('Foydalanuvchi');
  const msg = await one(
    pool,
    `INSERT INTO chat_message (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING ${MSG}`,
    [u.id, other, body],
  );
  const event = { ...msg, senderName: u.fullName };
  emitToUser(other, 'chat-message', event);
  // Yuboruvchining boshqa oynalari (tab) ham yangilansin
  emitToUser(u.id, 'chat-message', event);
  res.status(201).json(msg);
});

/** Suhbatdoshdan kelgan barcha xabarlarni o'qilgan qilish (suhbat ochilganda) */
chatRouter.post('/with/:userId/read', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  const r = await one<{ n: number; last: number | null }>(
    pool,
    `WITH upd AS (
       UPDATE chat_message SET read_at = now()
       WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL AND deleted_at IS NULL RETURNING id
     ) SELECT count(*) AS n, max(id) AS last FROM upd`,
    [u.id, other],
  );
  if (r!.n) {
    const event = { readerId: u.id, senderId: other, upToId: r!.last };
    emitToUser(other, 'chat-read', event); // yuboruvchida ✓✓
    emitToUser(u.id, 'chat-read', event); // o'z oynalarida badge kamayadi
  }
  res.json({ read: r!.n });
});

/** Faqat yuboruvchi o'z (o'chirilmagan) xabarini o'zgartiradi */
async function ownMessage(id: number, userId: number) {
  const m = await one<{ sender_id: number; recipient_id: number }>(
    pool,
    'SELECT sender_id, recipient_id FROM chat_message WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (!m || (m.sender_id !== userId && m.recipient_id !== userId)) throw notFound('Xabar');
  if (m.sender_id !== userId) throw forbidden();
  return m;
}

/** Ikkala tomonga: suhbat va ro'yxat qayta o'qiladi */
function emitUpdate(m: { sender_id: number; recipient_id: number }, data: unknown) {
  emitToUser(m.recipient_id, 'chat-update', data);
  emitToUser(m.sender_id, 'chat-update', data);
}

chatRouter.patch('/messages/:id', async (req, res) => {
  const u = me(req);
  const id = userId(req.params.id);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const m = await ownMessage(id, u.id);
  const msg = await one(
    pool,
    `UPDATE chat_message SET body = $2, edited_at = CASE WHEN body = $2 THEN edited_at ELSE now() END
     WHERE id = $1 RETURNING ${MSG}`,
    [id, body],
  );
  emitUpdate(m, { id, action: 'edit' });
  res.json(msg);
});

chatRouter.delete('/messages/:id', async (req, res) => {
  const u = me(req);
  const id = userId(req.params.id);
  const m = await ownMessage(id, u.id);
  await pool.query('UPDATE chat_message SET deleted_at = now() WHERE id = $1', [id]);
  emitUpdate(m, { id, action: 'delete' });
  res.json({ ok: true });
});
