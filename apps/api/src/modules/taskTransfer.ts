import { Router } from 'express';
import { z } from 'zod';
import { type AuthUser, isLeader, me, requireAuth } from '../common/auth';
import { audit } from '../common/audit';
import { AppError, forbidden, notFound, parse } from '../common/errors';
import { type Db, one, pool, q, tx } from '../db';
import { enqueue } from './notifications';
import { getTaskDto, OPEN_STATUSES, stopTimersForTask } from './taskService';

/**
 * Vazifani boshqa xodimga o'tkazish (rahbar qarori):
 * - faqat Shoshilinch va qo'lda yaratilgan (URGENT/MANUAL) vazifa — doimiy ish va hisobotlar mijoz buxgalteriga bog'langan;
 * - so'rovni vazifa egasi (mas'ul) yoki rahbar yuboradi, sabab majburiy;
 * - qabul qiluvchi rozilik beradi: "Qabul qilaman" bosguncha vazifa eski egasida qoladi;
 * - zanjir cheklanmaydi: qabul qilgan xodim yana boshqasiga o'tkaza oladi.
 */
export const TRANSFERABLE_KINDS = ['URGENT', 'MANUAL'] as const;
export const TRANSFER_REASONS = ['NOT_MINE', 'BUSY', 'OTHER'] as const;

export const transfersRouter = Router();
transfersRouter.use(requireAuth);

const id = z.coerce.number().int().positive();

const TRANSFER_SELECT = `
  SELECT tr.id, tr.task_id AS "taskId", tr.status, tr.reason_code AS "reasonCode", tr.reason_text AS "reasonText",
         tr.reject_reason AS "rejectReason", tr.created_at AS "createdAt", tr.resolved_at AS "resolvedAt",
         tr.from_user_id AS "fromUserId", fu.full_name AS "fromName",
         tr.to_user_id AS "toUserId", tu.full_name AS "toName",
         tr.requested_by AS "requestedBy", ru.full_name AS "requestedByName"
  FROM task_transfer tr
  LEFT JOIN app_user fu ON fu.id = tr.from_user_id
  JOIN app_user tu ON tu.id = tr.to_user_id
  JOIN app_user ru ON ru.id = tr.requested_by`;

/** Vazifa paneli uchun: kutilayotgan so'rov va oxirgi o'tkazishlar tarixi */
export async function transfersForTask(db: Db, taskId: number) {
  const history = await q<any>(db, `${TRANSFER_SELECT} WHERE tr.task_id = $1 ORDER BY tr.created_at DESC, tr.id DESC LIMIT 20`, [taskId]);
  return { pendingTransfer: history.find((h) => h.status === 'PENDING') ?? null, transfers: history };
}

/** Qabul qiluvchi vazifani (o'ziga hali o'tmagan bo'lsa ham) ko'rib qaror qila olishi uchun */
export async function hasPendingTransferTo(db: Db, taskId: number, userId: number) {
  return !!(await one(db, `SELECT 1 FROM task_transfer WHERE task_id = $1 AND to_user_id = $2 AND status = 'PENDING'`, [taskId, userId]));
}

interface TaskForTransfer {
  id: number;
  kind: string;
  status: string;
  title: string;
  client_id: number;
  client_name: string;
  assignee_id: number | null;
  created_by: number | null;
  due_at: Date | null;
}

async function lockTask(db: Db, taskId: number) {
  const t = await one<TaskForTransfer>(
    db,
    `SELECT t.id, t.kind, t.status, t.title, t.client_id, c.name AS client_name, t.assignee_id, t.created_by, t.due_at
     FROM task t JOIN client c ON c.id = t.client_id WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId],
  );
  if (!t) throw notFound('Vazifa');
  return t;
}

const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/** Natija xabari: so'rov yuborgan, eski egasi va (rahbar bergan bo'lsa) vazifa muallifi — qaror qilgan odamdan tashqari */
async function notifyResult(db: Db, tr: any, t: TaskForTransfer, actor: AuthUser, accepted: boolean, rejectReason: string | null) {
  const to = await one<{ full_name: string }>(db, 'SELECT full_name FROM app_user WHERE id = $1', [tr.to_user_id]);
  const recipients = new Set<number>([tr.requested_by, tr.from_user_id].filter((x): x is number => !!x));
  if (accepted && t.created_by) recipients.add(t.created_by);
  recipients.delete(actor.id);
  for (const userId of recipients) {
    await enqueue(db, {
      userId,
      kind: 'TASK_TRANSFER_RESULT',
      taskId: t.id,
      payload: {
        transferId: tr.id,
        taskId: t.id,
        taskTitle: t.title,
        clientId: t.client_id,
        clientName: t.client_name,
        accepted,
        toName: to?.full_name ?? null,
        rejectReason,
      },
    });
  }
}

// ---------- Menga kelgan so'rovlar ("Mening kunim" yuqorisida) ----------
transfersRouter.get('/incoming', async (req, res) => {
  const u = me(req);
  const rows = await q<any>(
    pool,
    `${TRANSFER_SELECT} JOIN task t ON t.id = tr.task_id
     WHERE tr.to_user_id = $1 AND tr.status = 'PENDING' AND t.status IN ('TODO','IN_PROGRESS','WAITING_CLIENT')
     ORDER BY tr.created_at`,
    [u.id],
  );
  const items = [];
  for (const r of rows) items.push({ ...r, task: await getTaskDto(pool, r.taskId) });
  res.json(items);
});

// ---------- So'rov yuborish ----------
transfersRouter.post('/', async (req, res) => {
  const u = me(req);
  const body = parse(
    z
      .object({
        taskId: id,
        toUserId: id,
        reasonCode: z.enum(TRANSFER_REASONS),
        reasonText: z.string().trim().max(500).optional(),
      })
      .refine((b) => b.reasonCode !== 'OTHER' || !!b.reasonText, { message: 'Sababni yozing', path: ['reasonText'] }),
    req.body,
  );
  const result = await tx(async (db) => {
    const t = await lockTask(db, body.taskId);
    if (!isLeader(u) && t.assignee_id !== u.id) throw forbidden();
    if (!(TRANSFERABLE_KINDS as readonly string[]).includes(t.kind)) {
      throw new AppError(409, 'TRANSFER_KIND', "Faqat shoshilinch va qo'lda yaratilgan vazifani o'tkazish mumkin");
    }
    if (!isOpen(t.status)) throw new AppError(409, 'TRANSFER_CLOSED', "Bajarilgan yoki bekor qilingan vazifani o'tkazib bo'lmaydi");
    if (body.toUserId === t.assignee_id) throw new AppError(400, 'TRANSFER_SAME', 'Vazifa allaqachon shu xodimda');
    // TODO(tasdiqlash): faqat buxgalterga o'tkaziladi (rahbar va operator ro'yxatda yo'q)
    const target = await one<{ id: number; full_name: string }>(
      db,
      `SELECT id, full_name FROM app_user WHERE id = $1 AND active AND role = 'ACCOUNTANT'`,
      [body.toUserId],
    );
    if (!target) throw new AppError(400, 'INVALID_ASSIGNEE', 'Buxgalter topilmadi');
    if (await one(db, `SELECT 1 FROM task_transfer WHERE task_id = $1 AND status = 'PENDING'`, [t.id])) {
      throw new AppError(409, 'TRANSFER_PENDING', "Bu vazifa bo'yicha javob kutilayotgan so'rov bor");
    }
    const tr = await one<{ id: number }>(
      db,
      `INSERT INTO task_transfer (task_id, from_user_id, to_user_id, requested_by, reason_code, reason_text)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [t.id, t.assignee_id, target.id, u.id, body.reasonCode, body.reasonText || null],
    );
    const from = t.assignee_id ? await one<{ full_name: string }>(db, 'SELECT full_name FROM app_user WHERE id = $1', [t.assignee_id]) : null;
    await audit(db, {
      actorId: u.id,
      entity: 'task',
      entityId: t.id,
      clientId: t.client_id,
      action: 'TRANSFER_REQUEST',
      before: { assigneeId: t.assignee_id },
      after: { toUserId: target.id, reasonCode: body.reasonCode, reasonText: body.reasonText || null, transferId: tr!.id },
    });
    await enqueue(db, {
      userId: target.id,
      kind: 'TASK_TRANSFER',
      taskId: t.id,
      payload: {
        transferId: tr!.id,
        taskId: t.id,
        taskTitle: t.title,
        clientId: t.client_id,
        clientName: t.client_name,
        dueAt: t.due_at?.toISOString() ?? null,
        fromName: from?.full_name ?? null,
        actorName: u.fullName,
        reasonCode: body.reasonCode,
        reasonText: body.reasonText || null,
      },
    });
    return transfersForTask(db, t.id);
  });
  res.status(201).json(result);
});

async function lockPending(db: Db, transferId: number) {
  const tr = await one<any>(db, `SELECT * FROM task_transfer WHERE id = $1 FOR UPDATE`, [transferId]);
  if (!tr) throw notFound("O'tkazish so'rovi");
  if (tr.status !== 'PENDING') throw new AppError(409, 'TRANSFER_RESOLVED', "So'rov allaqachon hal qilingan");
  return tr;
}

// ---------- Qabul qilish ----------
transfersRouter.post('/:id/accept', async (req, res) => {
  const u = me(req);
  const transferId = parse(id, req.params.id);
  // Vazifa yopilgan bo'lsa so'rov bekor qilinadi (commit), keyin 409 qaytadi
  const r = await tx(async (db) => {
    const tr = await lockPending(db, transferId);
    if (tr.to_user_id !== u.id) throw forbidden();
    const t = await lockTask(db, tr.task_id);
    if (!isOpen(t.status)) {
      await db.query(`UPDATE task_transfer SET status = 'CANCELLED', resolved_at = now() WHERE id = $1`, [tr.id]);
      return { stale: true as const };
    }
    // Eski egasining taymeri to'xtaydi: "Jarayonda" yangi egada noldan boshlanadi
    if (t.status === 'IN_PROGRESS') {
      await stopTimersForTask(db, t.id);
      await db.query(`UPDATE task SET status = 'TODO' WHERE id = $1`, [t.id]);
    }
    await db.query('UPDATE task SET assignee_id = $2 WHERE id = $1', [t.id, u.id]);
    await db.query(`UPDATE task_transfer SET status = 'ACCEPTED', resolved_by = $2, resolved_at = now() WHERE id = $1`, [tr.id, u.id]);
    await audit(db, {
      actorId: u.id,
      entity: 'task',
      entityId: t.id,
      clientId: t.client_id,
      action: 'TRANSFER_ACCEPT',
      before: { assigneeId: t.assignee_id, status: t.status },
      after: { assigneeId: u.id, status: t.status === 'IN_PROGRESS' ? 'TODO' : t.status, transferId: tr.id },
    });
    await notifyResult(db, tr, t, u, true, null);
    return { stale: false as const, task: await getTaskDto(db, t.id) };
  });
  if (r.stale) throw new AppError(409, 'TRANSFER_CLOSED', "Vazifa bajarilgan yoki bekor qilingan — so'rov yopildi");
  res.json(r.task);
});

// ---------- Rad etish ----------
transfersRouter.post('/:id/reject', async (req, res) => {
  const u = me(req);
  const transferId = parse(id, req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
  await tx(async (db) => {
    const tr = await lockPending(db, transferId);
    if (tr.to_user_id !== u.id) throw forbidden();
    const t = await lockTask(db, tr.task_id);
    await db.query(
      `UPDATE task_transfer SET status = 'REJECTED', reject_reason = $3, resolved_by = $2, resolved_at = now() WHERE id = $1`,
      [tr.id, u.id, reason || null],
    );
    await audit(db, {
      actorId: u.id,
      entity: 'task',
      entityId: t.id,
      clientId: t.client_id,
      action: 'TRANSFER_REJECT',
      after: { transferId: tr.id, reason: reason || null },
    });
    if (isOpen(t.status)) await notifyResult(db, tr, t, u, false, reason || null);
  });
  res.json({ ok: true });
});

// ---------- So'rovni qaytarib olish (yuborgan xodim yoki rahbar) ----------
transfersRouter.post('/:id/cancel', async (req, res) => {
  const u = me(req);
  const transferId = parse(id, req.params.id);
  await tx(async (db) => {
    const tr = await lockPending(db, transferId);
    if (!isLeader(u) && tr.requested_by !== u.id) throw forbidden();
    const t = await lockTask(db, tr.task_id);
    await db.query(`UPDATE task_transfer SET status = 'CANCELLED', resolved_by = $2, resolved_at = now() WHERE id = $1`, [tr.id, u.id]);
    // Qabul qiluvchi hali ko'rmagan xabar unga yetkazilmaydi
    await db.query(
      `UPDATE notification SET cancelled_at = now()
       WHERE task_id = $1 AND kind = 'TASK_TRANSFER' AND user_id = $2 AND delivered_at IS NULL AND cancelled_at IS NULL`,
      [t.id, tr.to_user_id],
    );
    await audit(db, { actorId: u.id, entity: 'task', entityId: t.id, clientId: t.client_id, action: 'TRANSFER_CANCEL', after: { transferId: tr.id } });
  });
  res.json({ ok: true });
});
