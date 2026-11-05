import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth, type Role } from '../common/auth';
import { notFound, parse } from '../common/errors';
import { type Db, one, pool, q } from '../db';
import { emitToUser } from './events';
import { renderNotification } from './messages';
import { sendTelegram, telegramEnabled } from './telegram';

export const NOTIFICATION_KINDS = [
  'TASK_DONE',
  'TASK_OVERDUE',
  'CLIENTS_OVERDUE',
  'URGENT_TASK',
  'TASK_TRANSFER',
  'TASK_TRANSFER_RESULT',
  'LEAD_WON',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Profil sozlamasida ko'rinadigan turlar: kimga qaysi xabar umuman kelishi mumkin */
export function notificationKindsFor(role: Role): readonly NotificationKind[] {
  if (role === 'LEADER') return NOTIFICATION_KINDS;
  if (role === 'ACCOUNTANT') return ['TASK_DONE', 'TASK_OVERDUE', 'CLIENTS_OVERDUE', 'URGENT_TASK', 'TASK_TRANSFER', 'TASK_TRANSFER_RESULT'];
  return [];
}

export interface EnqueueInput {
  userId: number;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  taskId?: number | null;
  delaySec?: number;
  dedupeKey?: string | null;
}

/**
 * Bildirishnomani navbatga qo'yish. Ilova ichidagi nusxa (APP) doim saqlanadi (agar o'chirilmagan bo'lsa);
 * TELEGRAM faqat bot sozlangan va xodim chat_id bog'lagan bo'lsa.
 */
export async function enqueue(db: Db, n: EnqueueInput) {
  const u = await one<{ telegram_chat_id: number | null; notification_prefs: any; active: boolean }>(
    db,
    'SELECT telegram_chat_id, notification_prefs, active FROM app_user WHERE id = $1',
    [n.userId],
  );
  if (!u?.active) return;
  const pref = u.notification_prefs?.[n.kind] ?? {};
  const channels: string[] = [];
  if (pref.app !== false) channels.push('APP');
  if (pref.telegram !== false && u.telegram_chat_id && telegramEnabled()) channels.push('TELEGRAM');
  for (const channel of channels) {
    await db.query(
      `INSERT INTO notification (user_id, kind, channel, payload, task_id, dedupe_key, deliver_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
       ON CONFLICT (user_id, channel, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [n.userId, n.kind, channel, JSON.stringify(n.payload), n.taskId ?? null, n.dedupeKey ?? null, n.delaySec ?? 0],
    );
  }
}

export async function notifyLeaders(db: Db, n: Omit<EnqueueInput, 'userId'> & { exceptUserId?: number | null }) {
  const leaders = await q<{ id: number }>(db, `SELECT id FROM app_user WHERE role = 'LEADER' AND active`);
  for (const l of leaders) {
    if (l.id === n.exceptUserId) continue;
    await enqueue(db, { ...n, userId: l.id });
  }
}

/** Undo: hali yetkazilmagan xabarlarni bekor qilish (o'chirilmaydi, cancelled_at qo'yiladi) */
export async function cancelPendingForTask(db: Db, taskId: number, kind: NotificationKind) {
  const r = await db.query(
    `UPDATE notification SET cancelled_at = now()
     WHERE task_id = $1 AND kind = $2 AND delivered_at IS NULL AND cancelled_at IS NULL`,
    [taskId, kind],
  );
  return r.rowCount ?? 0;
}

const DTO = `id, kind, payload, task_id AS "taskId", deliver_at AS "deliverAt", delivered_at AS "deliveredAt",
             read_at AS "readAt", created_at AS "createdAt"`;

// ---------- Dispatcher ----------
let dispatching = false;
const MAX_ATTEMPTS = 5;

/** deliver_at <= now(), yetkazilmagan va bekor qilinmaganlarni yetkazadi. Bir vaqtda bitta ishga tushadi. */
export async function dispatchDue(send: typeof sendTelegram = sendTelegram) {
  if (dispatching) return 0;
  dispatching = true;
  let count = 0;
  try {
    const due = await q<{ id: number; channel: string }>(
      pool,
      `SELECT id, channel FROM notification
       WHERE delivered_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL AND deliver_at <= now()
       ORDER BY deliver_at LIMIT 200`,
    );
    for (const d of due) {
      if (d.channel === 'APP') {
        const n = await one(
          pool,
          `UPDATE notification SET delivered_at = now(), attempts = attempts + 1
           WHERE id = $1 AND delivered_at IS NULL AND cancelled_at IS NULL RETURNING user_id, ${DTO}`,
          [d.id],
        );
        if (n) {
          const { user_id, ...dto } = n;
          emitToUser(user_id, 'notification', dto);
          count++;
        }
        continue;
      }
      // TELEGRAM: avval "egallab olamiz" (deliver_at kelajakka), keyin yuboramiz
      const n = await one<any>(
        pool,
        `UPDATE notification n SET attempts = n.attempts + 1, deliver_at = now() + interval '60 seconds'
         FROM app_user u
         WHERE n.id = $1 AND u.id = n.user_id AND n.delivered_at IS NULL AND n.cancelled_at IS NULL
         RETURNING n.id, n.kind, n.payload, n.attempts, u.telegram_chat_id, u.language`,
        [d.id],
      );
      if (!n) continue;
      if (!n.telegram_chat_id) {
        await pool.query(`UPDATE notification SET failed_at = now(), last_error = 'NO_CHAT_ID' WHERE id = $1`, [n.id]);
        continue;
      }
      try {
        await send(n.telegram_chat_id, renderNotification(n.kind, n.payload, n.language));
        await pool.query('UPDATE notification SET delivered_at = now(), last_error = NULL WHERE id = $1', [n.id]);
        count++;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        console.error(`Telegram yuborilmadi (notification ${n.id}):`, msg);
        await pool.query(
          `UPDATE notification SET last_error = $2,
             deliver_at = now() + make_interval(secs => 30 * attempts),
             failed_at = CASE WHEN attempts >= $3 THEN now() END
           WHERE id = $1`,
          [n.id, msg, MAX_ATTEMPTS],
        );
      }
    }
  } finally {
    dispatching = false;
  }
  return count;
}

// ---------- Eslatma: muddat o'tdi (bir marta) ----------
export async function remindOverdue() {
  const tasks = await q<any>(
    pool,
    `SELECT t.id, t.title, t.due_at, t.assignee_id, c.name AS client_name, c.id AS client_id, a.full_name AS assignee_name
     FROM task t JOIN client c ON c.id = t.client_id LEFT JOIN app_user a ON a.id = t.assignee_id
     WHERE t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT') AND t.due_at < now() AND t.overdue_notified_at IS NULL
     LIMIT 500`,
  );
  for (const t of tasks) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const claimed = await c.query(
        'UPDATE task SET overdue_notified_at = now() WHERE id = $1 AND overdue_notified_at IS NULL',
        [t.id],
      );
      if (claimed.rowCount) {
        const payload = {
          taskId: t.id,
          taskTitle: t.title,
          clientId: t.client_id,
          clientName: t.client_name,
          dueAt: t.due_at.toISOString(),
          assigneeName: t.assignee_name,
        };
        const dedupeKey = `overdue:${t.id}`;
        if (t.assignee_id) await enqueue(c, { userId: t.assignee_id, kind: 'TASK_OVERDUE', payload, taskId: t.id, dedupeKey });
        await notifyLeaders(c, { kind: 'TASK_OVERDUE', payload, taskId: t.id, dedupeKey, exceptUserId: t.assignee_id });
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      console.error('Overdue eslatma xatosi:', e);
    } finally {
      c.release();
    }
  }
  return tasks.length;
}

// ---------- API ----------
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (req, res) => {
  const u = me(req);
  const { unreadOnly, page, pageSize } = parse(
    z.object({
      unreadOnly: z.enum(['true', 'false']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30),
    }),
    req.query,
  );
  const where = `user_id = $1 AND channel = 'APP' AND delivered_at IS NOT NULL AND cancelled_at IS NULL
                 ${unreadOnly === 'true' ? 'AND read_at IS NULL' : ''}`;
  const items = await q(pool, `SELECT ${DTO} FROM notification WHERE ${where} ORDER BY delivered_at DESC LIMIT $2 OFFSET $3`, [
    u.id,
    pageSize,
    (page - 1) * pageSize,
  ]);
  const total = (await one<{ n: number }>(pool, `SELECT count(*) AS n FROM notification WHERE ${where}`, [u.id]))!.n;
  res.json({ items, total, page, pageSize });
});

notificationsRouter.get('/unread-count', async (req, res) => {
  const r = await one<{ n: number }>(
    pool,
    `SELECT count(*) AS n FROM notification WHERE user_id = $1 AND channel = 'APP'
     AND delivered_at IS NOT NULL AND cancelled_at IS NULL AND read_at IS NULL`,
    [me(req).id],
  );
  res.json({ count: r!.n });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await pool.query(
    `UPDATE notification SET read_at = now() WHERE user_id = $1 AND channel = 'APP' AND read_at IS NULL AND delivered_at IS NOT NULL`,
    [me(req).id],
  );
  res.json({ ok: true });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const id = parse(z.coerce.number().int(), req.params.id);
  const r = await pool.query(
    `UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2 AND channel = 'APP'`,
    [id, me(req).id],
  );
  if (!r.rowCount) throw notFound('Bildirishnoma');
  res.json({ ok: true });
});
