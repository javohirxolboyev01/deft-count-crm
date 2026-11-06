import { Router } from 'express';
import { z } from 'zod';
import { isLeader, me, requireAuth, requireLeader } from '../common/auth';
import { audit, diff } from '../common/audit';
import { AppError, forbidden, notFound, parse } from '../common/errors';
import { DateTime } from 'luxon';
import { TZ, currentPeriod, nowTz, periodFromMonth, todayAt, workPeriod } from '../common/time';
import { one, pool, q, tx } from '../db';
import { getDueTime } from './generator';
import { enqueue } from './notifications';
import { hasPendingTransferTo, transfersForTask } from './taskTransfer';
import {
  assertTaskAccess,
  changeStatus,
  getTaskDto,
  listTasks,
  lockTaskForUser,
  markDone,
  TASK_SELECT,
  undoDone,
} from './taskService';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const id = z.coerce.number().int().positive();

// ---------- Mening kunim ----------
/**
 * Bosh sahifa = Buxgalter ishlari sahifasidagi ishlar (rahbar qarori): bo'limdagi mijozning doimiy ishlari va
 * ish ustuni bor hisobot (INPS, routine_work_type.report_type_id) + rahbar bergan shoshilinch/qo'lda vazifalar.
 * Hisobot topshirish vazifalari bu yerga kirmaydi — buxgalter u jadvalni faqat ko'radi.
 */
const WORKS_SCOPE = `(t.kind IN ('URGENT','MANUAL') OR (c.in_works AND (t.kind = 'ROUTINE' OR (t.kind = 'REPORT' AND t.report_type_id IN (
  SELECT report_type_id FROM routine_work_type WHERE active AND report_type_id IS NOT NULL)))))`;

/**
 * Davr tugmalari (Hafta / Oy / Chorak / Yil) — tepadagi 5 ta karta va "Bajarildi" ustuni shu davr bo'yicha.
 * Davr = joriy kalendar hafta/oy/chorak/yil, Asia/Tashkent, yarim ochiq [boshi, oxiri). Bitta qoida:
 *  - Davrda bajarilgan: o'zi bosgan (done_by) DONE vazifa, done_at davr ichida — rahbar dashboardidagi Buxgalterlar
 *    jadvali bilan aynan bir xil formula (importdan tayyor kelgani / rahbar bosgani yozilmaydi; buxgalteri yo'q
 *    mijoz kirmaydi, 6.11).
 *  - Davrning ochiq vazifalari: menga biriktirilgan ochiq vazifa, muddati davr oxirigacha (o'tgan davrlardan qolgan
 *    qarz ham) yoki muddatsiz. Muddati keyingi davrga tushadigani bu davrniki emas.
 *  - Kechikkan (muddati o'tgan) vazifa har doim davr ichida (muddat < hozir < davr oxiri) — davrga qarab o'zgarmaydi.
 *  - "Bugun" — har doim bugungi kun (u har qanday joriy davr ichida).
 * Pastdagi "Bajarilishi kerak / Jarayonda / Mijozdan kutilmoqda" ustunlari — davrdan qat'i nazar barcha ochiq ishlar.
 */
const MY_DAY_RANGES = ['week', 'month', 'quarter', 'year'] as const;

tasksRouter.get('/my-day', async (req, res) => {
  const u = me(req);
  const { range } = parse(z.object({ range: z.enum(MY_DAY_RANGES).default('month') }), req.query);
  // Belgilanadigan oy (noyabrda oktyabr) — jadvallar va rahbar dashboardi bilan bir xil
  const period = workPeriod();
  const now = nowTz();
  const rangeStart = now.startOf(range).toJSDate();
  const rangeEnd = now.startOf(range).plus({ [`${range}s`]: 1 }).toJSDate();
  const tasks = await listTasks(
    pool,
    [
      `((t.assignee_id = $1 AND ${WORKS_SCOPE} AND t.status IN ('TODO','IN_PROGRESS','WAITING_CLIENT'))
        OR (t.status = 'DONE' AND t.done_by = $1 AND t.done_at >= $2 AND t.done_at < $3 AND c.accountant_id IS NOT NULL))`,
    ],
    [u.id, rangeStart, rangeEnd],
  );
  const today = now.toISODate();
  const open = tasks.filter((t: any) => t.status !== 'DONE');
  const isToday = (d: Date | null) => !!d && DateTime.fromJSDate(d).setZone(TZ).toISODate() === today;
  // Davrning ochiq vazifalari holat bo'yicha (1-karta va 4-karta maxraji) + kechikkanlar (2-karta)
  const inRange = `t.status IN ('TODO','IN_PROGRESS','WAITING_CLIENT') AND (t.due_at < $2 OR t.due_at IS NULL)`;
  const openStats = await one(
    pool,
    `SELECT count(*) FILTER (WHERE ${inRange})::int AS open,
            count(*) FILTER (WHERE ${inRange} AND t.status = 'TODO')::int AS "openTodo",
            count(*) FILTER (WHERE ${inRange} AND t.status = 'IN_PROGRESS')::int AS "openInProgress",
            count(*) FILTER (WHERE ${inRange} AND t.status = 'WAITING_CLIENT')::int AS "openWaiting",
            -- Kechikkan = muddati o'tgan va hali "Bajarilishi kerak" (rahbar qarori): Jarayonda / Mijozdan kutilmoqda
            -- holatiga o'tgani sanalmaydi — rahbar dashboardidagi Buxgalterlar jadvali bilan bir xil
            count(*) FILTER (WHERE t.status = 'TODO' AND t.due_at < now())::int AS overdue,
            count(*) FILTER (WHERE t.status = 'IN_PROGRESS' AND t.due_at < now())::int AS "overdueInProgress",
            count(*) FILTER (WHERE t.status = 'WAITING_CLIENT' AND t.due_at < now())::int AS "overdueWaiting"
     FROM task t JOIN client c ON c.id = t.client_id WHERE t.assignee_id = $1 AND ${WORKS_SCOPE}`,
    [u.id, rangeEnd],
  );
  // Davrda bajarilganlar — dashboard/accountants bilan aynan bir xil formula ("O'z vaqtida" = done_at <= due_at,
  // muddatsizlar foizga kirmaydi)
  const doneStats = await one(
    pool,
    `SELECT count(*)::int AS done,
            count(*) FILTER (WHERE t.done_at <= t.due_at)::int AS "doneOnTime",
            count(*) FILTER (WHERE t.done_at > t.due_at)::int AS "doneLate",
            count(*) FILTER (WHERE t.due_at IS NULL)::int AS "doneNoDue",
            count(*) FILTER (WHERE t.done_at >= $4)::int AS "doneToday"
     FROM task t JOIN client c ON c.id = t.client_id
     WHERE t.done_by = $1 AND t.status = 'DONE' AND t.done_at >= $2 AND t.done_at < $3 AND c.accountant_id IS NOT NULL`,
    [u.id, rangeStart, rangeEnd, now.startOf('day').toJSDate()],
  );
  const stats = { ...openStats, ...doneStats };
  res.json({
    period: period.slice(0, 7),
    range,
    groups: {
      today: open.filter((t: any) => isToday(t.dueAt) && !t.overdue),
      urgent: open.filter((t: any) => t.kind === 'URGENT'),
      overdue: open.filter((t: any) => t.overdue && t.status === 'TODO'),
    },
    columns: {
      TODO: tasks.filter((t: any) => t.status === 'TODO'),
      IN_PROGRESS: tasks.filter((t: any) => t.status === 'IN_PROGRESS'),
      WAITING_CLIENT: tasks.filter((t: any) => t.status === 'WAITING_CLIENT'),
      DONE: tasks.filter((t: any) => t.status === 'DONE'),
    },
    stats,
  });
});

// ---------- Shoshilinch (6.9) ----------
tasksRouter.get('/urgent/suggest-assignee', requireLeader, async (_req, res) => {
  // Eng kam ochiq vazifali buxgalter birinchi; teng bo'lsa alifbo tartibi
  const rows = await q(
    pool,
    `SELECT user_id AS id, full_name AS "fullName", open_count AS "openCount"
     FROM v_accountant_load ORDER BY open_count ASC, full_name ASC`,
  );
  res.json(rows);
});

tasksRouter.post('/urgent', requireLeader, async (req, res) => {
  const u = me(req);
  const body = parse(
    z
      .object({
        clientId: id,
        text: z.string().trim().max(1000).optional(),
        templateId: z.string().optional(),
        assigneeId: id,
        dueAt: z.coerce.date().optional(),
        note: z.string().max(2000).optional(),
      })
      .refine((b) => b.text || b.templateId, { message: 'text yoki templateId kerak' }),
    req.body,
  );
  const task = await tx(async (db) => {
    const client = await one(db, 'SELECT id, name FROM client WHERE id = $1', [body.clientId]);
    if (!client) throw notFound('Mijoz');
    const assignee = await one(db, `SELECT id FROM app_user WHERE id = $1 AND active AND role = 'ACCOUNTANT'`, [
      body.assigneeId,
    ]);
    if (!assignee) throw new AppError(400, 'INVALID_ASSIGNEE', 'Buxgalter topilmadi');
    let title = body.text;
    if (!title && body.templateId) {
      const s = await one<{ value: any[] }>(db, `SELECT value FROM setting WHERE key = 'urgent_templates'`);
      title = s?.value?.find((t: any) => t.id === body.templateId)?.text;
      if (!title) throw new AppError(400, 'TEMPLATE_NOT_FOUND', 'Shablon topilmadi');
    }
    // Muddat odatda shu kuni 18:00 (Asia/Tashkent)
    const dueAt = body.dueAt ?? todayAt(await getDueTime(db));
    const t = await one<{ id: number }>(
      db,
      `INSERT INTO task (client_id, kind, period, title, note, assignee_id, due_at, created_by)
       VALUES ($1, 'URGENT', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [body.clientId, currentPeriod(), title, body.note ?? null, body.assigneeId, dueAt, u.id],
    );
    await audit(db, {
      actorId: u.id,
      entity: 'task',
      entityId: t!.id,
      clientId: body.clientId,
      action: 'CREATE_URGENT',
      after: { title, assigneeId: body.assigneeId, dueAt },
    });
    await enqueue(db, {
      userId: body.assigneeId,
      kind: 'URGENT_TASK',
      taskId: t!.id,
      payload: { taskId: t!.id, title, clientId: client.id, clientName: client.name, dueAt: dueAt.toISOString(), createdByName: u.fullName },
    });
    return getTaskDto(db, t!.id);
  });
  res.status(201).json(task);
});

// ---------- Ro'yxat ----------
tasksRouter.get('/', async (req, res) => {
  const u = me(req);
  const f = parse(
    z.object({
      clientId: id.optional(),
      assigneeId: id.optional(),
      status: z.enum(['TODO', 'IN_PROGRESS', 'WAITING_CLIENT', 'DONE', 'CANCELLED', 'OPEN']).optional(),
      kind: z.enum(['ROUTINE', 'REPORT', 'URGENT', 'MANUAL']).optional(),
      month: z.string().optional(),
      overdue: z.enum(['true']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }),
    req.query,
  );
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (!isLeader(u)) {
    params.push(u.id);
    where.push(`(t.assignee_id = $${params.length} OR c.accountant_id = $${params.length})`);
  }
  if (f.clientId) add('t.client_id = ?', f.clientId);
  if (f.assigneeId) add('t.assignee_id = ?', f.assigneeId);
  if (f.status === 'OPEN') where.push(`t.status IN ('TODO','IN_PROGRESS','WAITING_CLIENT')`);
  else if (f.status) add('t.status = ?', f.status);
  else where.push(`t.status <> 'CANCELLED'`);
  if (f.kind) add('t.kind = ?', f.kind);
  if (f.month) add('t.period = ?', periodFromMonth(f.month));
  if (f.overdue) where.push('t.is_overdue');
  params.push(f.limit);
  const rows = await q(
    pool,
    `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.due_at NULLS LAST, t.id LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
});

tasksRouter.post('/', async (req, res) => {
  const u = me(req);
  const body = parse(
    z.object({
      clientId: id,
      title: z.string().trim().min(1).max(500),
      note: z.string().max(5000).optional(),
      assigneeId: id.optional(),
      dueAt: z.coerce.date().optional(),
    }),
    req.body,
  );
  const task = await tx(async (db) => {
    const c = await one<{ accountant_id: number | null }>(db, 'SELECT accountant_id FROM client WHERE id = $1', [body.clientId]);
    if (!c) throw notFound('Mijoz');
    let assigneeId = body.assigneeId ?? c.accountant_id;
    if (!isLeader(u)) {
      if (c.accountant_id !== u.id) throw forbidden();
      assigneeId = u.id;
    }
    const t = await one<{ id: number }>(
      db,
      `INSERT INTO task (client_id, kind, period, title, note, assignee_id, due_at, created_by)
       VALUES ($1, 'MANUAL', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [body.clientId, currentPeriod(), body.title, body.note ?? null, assigneeId, body.dueAt ?? null, u.id],
    );
    await audit(db, {
      actorId: u.id,
      entity: 'task',
      entityId: t!.id,
      clientId: body.clientId,
      action: 'CREATE_MANUAL',
      after: { title: body.title, assigneeId, dueAt: body.dueAt ?? null },
    });
    return getTaskDto(db, t!.id);
  });
  res.status(201).json(task);
});

tasksRouter.get('/:id', async (req, res) => {
  const u = me(req);
  const taskId = parse(id, req.params.id);
  const t = await one(pool, 'SELECT t.assignee_id, c.accountant_id FROM task t JOIN client c ON c.id = t.client_id WHERE t.id = $1', [taskId]);
  if (!t) throw notFound('Vazifa');
  // Qabul qiluvchi o'ziga o'tkazilayotgan vazifani qaror qilishdan oldin ko'ra oladi (faqat ko'radi)
  if (!(await hasPendingTransferTo(pool, taskId, u.id))) assertTaskAccess(u, t);
  const task = await getTaskDto(pool, taskId);
  const checklist = await q(
    pool,
    `SELECT id, text, done, sort_order AS "sortOrder" FROM task_checklist_item WHERE task_id = $1 ORDER BY sort_order, id`,
    [taskId],
  );
  const timeEntries = await q(
    pool,
    `SELECT te.id, te.user_id AS "userId", u.full_name AS "userName", te.started_at AS "startedAt", te.ended_at AS "endedAt"
     FROM time_entry te JOIN app_user u ON u.id = te.user_id WHERE te.task_id = $1 ORDER BY te.started_at DESC LIMIT 50`,
    [taskId],
  );
  res.json({ ...task, checklist, timeEntries, ...(await transfersForTask(pool, taskId)) });
});

tasksRouter.patch('/:id', async (req, res) => {
  const u = me(req);
  const taskId = parse(id, req.params.id);
  const body = parse(
    z.object({
      note: z.string().max(5000).nullable().optional(),
      title: z.string().trim().min(1).max(500).optional(),
      dueAt: z.coerce.date().nullable().optional(),
      assigneeId: id.nullable().optional(),
    }),
    req.body,
  );
  const task = await tx(async (db) => {
    const t = await lockTaskForUser(db, taskId, u);
    // Buxgalter faqat izohni o'zgartiradi; sarlavha/muddat/mas'ul — rahbar
    if (!isLeader(u) && (body.title !== undefined || body.dueAt !== undefined || body.assigneeId !== undefined)) {
      throw forbidden();
    }
    const before = await one(db, 'SELECT note, title, due_at AS "dueAt", assignee_id AS "assigneeId" FROM task WHERE id = $1', [taskId]);
    await db.query(
      `UPDATE task SET note = CASE WHEN $2 THEN $3 ELSE note END,
                       title = coalesce($4, title),
                       due_at = CASE WHEN $5 THEN $6::timestamptz ELSE due_at END,
                       assignee_id = CASE WHEN $7 THEN $8::bigint ELSE assignee_id END
       WHERE id = $1`,
      [
        taskId,
        body.note !== undefined,
        body.note ?? null,
        body.title ?? null,
        body.dueAt !== undefined,
        body.dueAt ?? null,
        body.assigneeId !== undefined,
        body.assigneeId ?? null,
      ],
    );
    // Oldin/Keyin bir xil maydonlarga ega bo'lsin: faqat o'zgarganlari yoziladi
    const d = diff(before, body);
    if (d.changed) await audit(db, { actorId: u.id, entity: 'task', entityId: taskId, clientId: t.client_id, action: 'UPDATE', before: d.before, after: d.after });
    return getTaskDto(db, taskId);
  });
  res.json(task);
});

tasksRouter.patch('/:id/status', async (req, res) => {
  const taskId = parse(id, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['TODO', 'IN_PROGRESS', 'WAITING_CLIENT', 'DONE']) }), req.body);
  res.json(await tx((db) => changeStatus(db, taskId, me(req), status)));
});

tasksRouter.post('/:id/done', async (req, res) => {
  const taskId = parse(id, req.params.id);
  res.json(await tx((db) => markDone(db, taskId, me(req))));
});

tasksRouter.post('/:id/undo-done', async (req, res) => {
  const taskId = parse(id, req.params.id);
  res.json(await tx((db) => undoDone(db, taskId, me(req))));
});

// ---------- Checklist ----------
tasksRouter.post('/:id/checklist', async (req, res) => {
  const u = me(req);
  const taskId = parse(id, req.params.id);
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(500) }), req.body);
  const item = await tx(async (db) => {
    const t = await lockTaskForUser(db, taskId, u);
    const it = await one(
      db,
      `INSERT INTO task_checklist_item (task_id, text, sort_order)
       VALUES ($1, $2, coalesce((SELECT max(sort_order) + 1 FROM task_checklist_item WHERE task_id = $1), 0))
       RETURNING id, text, done, sort_order AS "sortOrder"`,
      [taskId, text],
    );
    await audit(db, { actorId: u.id, entity: 'task_checklist_item', entityId: it.id, clientId: t.client_id, action: 'CREATE', after: it });
    return it;
  });
  res.status(201).json(item);
});

tasksRouter.patch('/:id/checklist/:itemId', async (req, res) => {
  const u = me(req);
  const taskId = parse(id, req.params.id);
  const itemId = parse(id, req.params.itemId);
  const body = parse(z.object({ text: z.string().trim().min(1).max(500).optional(), done: z.boolean().optional() }), req.body);
  const item = await tx(async (db) => {
    const t = await lockTaskForUser(db, taskId, u);
    const before = await one(db, 'SELECT text, done FROM task_checklist_item WHERE id = $1 AND task_id = $2', [itemId, taskId]);
    if (!before) throw notFound('Checklist bandi');
    const it = await one(
      db,
      `UPDATE task_checklist_item SET text = coalesce($3, text), done = coalesce($4, done)
       WHERE id = $1 AND task_id = $2 RETURNING id, text, done, sort_order AS "sortOrder"`,
      [itemId, taskId, body.text ?? null, body.done ?? null],
    );
    const d = diff(before, body);
    if (d.changed) await audit(db, { actorId: u.id, entity: 'task_checklist_item', entityId: itemId, clientId: t.client_id, action: 'UPDATE', before: d.before, after: d.after });
    return it;
  });
  res.json(item);
});

tasksRouter.delete('/:id/checklist/:itemId', async (req, res) => {
  const u = me(req);
  const taskId = parse(id, req.params.id);
  const itemId = parse(id, req.params.itemId);
  await tx(async (db) => {
    const t = await lockTaskForUser(db, taskId, u);
    const r = await one(db, 'DELETE FROM task_checklist_item WHERE id = $1 AND task_id = $2 RETURNING text, done', [itemId, taskId]);
    if (!r) throw notFound('Checklist bandi');
    await audit(db, { actorId: u.id, entity: 'task_checklist_item', entityId: itemId, clientId: t.client_id, action: 'DELETE', before: r });
  });
  res.status(204).end();
});
