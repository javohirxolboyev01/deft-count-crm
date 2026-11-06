import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { requireAuth, requireLeader } from '../common/auth';
import { parse } from '../common/errors';
import { TZ, dayEnd, dayStart, nowTz, periodFromMonth } from '../common/time';
import { one, pool, q } from '../db';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireLeader);

const OPEN = `('TODO','IN_PROGRESS','WAITING_CLIENT')`;

/**
 * Rahbar qarori: buxgalter biriktirilmagan mijoz dashboarddagi hech bir natijaga kirmaydi (kartalar, foizlar,
 * kechikkan vazifalar, Buxgalterlar jadvali). Bu mijozlar faqat "Kamchiliklar" sahifasida (biriktirish uchun).
 */
const COUNTED_CLIENT = (alias: string) => `${alias}.accountant_id IS NOT NULL`;

/**
 * Mijozlar bo'yicha: bajarilish (jami/bajarildi) — tanlangan oy; kechikish — BARCHA oylar (o'tgan oydan qolgan
 * ochiq vazifa ham kechikish, "Muddati o'tgan vazifalar" ro'yxati va Buxgalterlar jadvali bilan bir xil).
 */
dashboardRouter.get('/clients', async (req, res) => {
  const { month } = parse(z.object({ month: z.string().optional() }), req.query);
  const period = periodFromMonth(month);
  const perClient = await q(
    pool,
    `SELECT c.id AS "clientId", c.name, c.stir, c.status, c.tax_type AS "taxType", c.tax_type_raw AS "taxTypeRaw", c.stir_raw AS "stirRaw",
            c.in_reports AS "inReports", c.in_works AS "inWorks",
            a.id AS "accountantId", a.full_name AS "accountantName",
            count(t.id) FILTER (WHERE t.period = $1)::int AS total,
            count(t.id) FILTER (WHERE t.period = $1 AND t.status = 'DONE')::int AS done,
            count(t.id) FILTER (WHERE t.status IN ${OPEN} AND t.due_at < now())::int AS overdue,
            count(t.id) FILTER (WHERE t.period = $1 AND t.status = 'WAITING_CLIENT')::int AS waiting,
            count(t.id) FILTER (WHERE t.period = $1 AND t.status = 'TODO')::int AS todo,
            count(t.id) FILTER (WHERE t.period = $1 AND t.status = 'IN_PROGRESS')::int AS "inProgress"
     FROM client c
     LEFT JOIN app_user a ON a.id = c.accountant_id
     LEFT JOIN task t ON t.client_id = c.id AND t.status <> 'CANCELLED'
       AND (t.period = $1 OR (t.status IN ${OPEN} AND t.due_at < now()))
     WHERE c.status <> 'ARCHIVED'
     GROUP BY c.id, a.id ORDER BY c.name_normalized`,
    [period],
  );
  // Kechikkan vazifasi bor mijoz (qaysi oyniki bo'lmasin) — "Tayyor" emas
  const all = perClient.map((c: any) => ({
    ...c,
    percent: c.total ? Math.round((c.done / c.total) * 100) : null,
    state: c.overdue > 0 ? 'OVERDUE' : c.total === 0 ? 'NONE' : c.done === c.total ? 'READY' : 'IN_PROGRESS',
  }));
  const clients = all.filter((c: any) => c.accountantId);
  const unassignedClients = all.filter((c: any) => !c.accountantId);
  const totals = await one(
    pool,
    `SELECT count(*) FILTER (WHERE t.period = $1)::int AS total,
            count(*) FILTER (WHERE t.period = $1 AND t.status = 'DONE')::int AS done,
            count(*) FILTER (WHERE t.period = $1 AND t.status IN ${OPEN} AND t.due_at < now())::int AS "overdueMonth",
            count(*) FILTER (WHERE t.status IN ${OPEN} AND t.due_at < now())::int AS overdue
     FROM task t JOIN client c ON c.id = t.client_id WHERE t.status <> 'CANCELLED' AND ${COUNTED_CLIENT('c')}`,
    [period],
  );
  const overdueTasks = await q(
    pool,
    `SELECT t.id, t.title, t.kind, t.due_at AS "dueAt", t.status, c.id AS "clientId", c.name AS "clientName",
            u.id AS "assigneeId", u.full_name AS "assigneeName"
     FROM task t JOIN client c ON c.id = t.client_id LEFT JOIN app_user u ON u.id = t.assignee_id
     WHERE t.status IN ${OPEN} AND t.due_at < now() AND ${COUNTED_CLIENT('c')}
     ORDER BY t.due_at LIMIT 200`,
  );
  res.json({
    period: period.slice(0, 7),
    summary: {
      clients: clients.length,
      // Vazifasi yo'q mijoz (soliq turi aniqlanmagan, bo'limsiz) hech qachon "tayyor" bo'lmaydi — foiz maxrajiga kirmaydi
      withTasks: clients.filter((c) => c.state !== 'NONE').length,
      ready: clients.filter((c) => c.state === 'READY').length,
      inProgress: clients.filter((c) => c.state === 'IN_PROGRESS').length,
      overdue: clients.filter((c) => c.state === 'OVERDUE').length,
      tasksTotal: totals!.total,
      tasksDone: totals!.done,
      // Barcha oylar (ro'yxat sarlavhasidagi haqiqiy son; ro'yxatning o'zi 200 ta bilan cheklangan)
      tasksOverdue: totals!.overdue,
      // Faqat tanlangan oy ("Vazifalar" kartasidagi bo'laklar shu oy jamisidan)
      tasksOverdueMonth: totals!.overdueMonth,
      percent: totals!.total ? Math.round((totals!.done / totals!.total) * 100) : 0,
      // Soliq turi aniqlanmagan (importda tanilmagan): vazifa chiqmaydi, rahbar kartada to'ldirishi kerak
      incomplete: clients.filter((c: any) => !c.taxType).length,
    },
    clients,
    // Faqat "Kamchiliklar" sahifasi uchun (buxgalter biriktirish); dashboard natijalariga kirmaydi
    unassignedClients,
    overdueTasks,
  });
});

/** Buxgalterlar: bajargan (kun/hafta/oy + tanlangan oraliq), o'z vaqtida %, kechikkan, yuklama, sarflangan vaqt */
dashboardRouter.get('/accountants', async (req, res) => {
  const f = parse(
    z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    req.query,
  );
  const now = nowTz();
  const from = dayStart(f.from ?? now.startOf('month').toISODate()!);
  const to = dayEnd(f.to ?? now.toISODate()!);
  const dayFrom = now.startOf('day').toJSDate();
  const weekFrom = now.startOf('week').toJSDate();
  const monthFrom = now.startOf('month').toJSDate();
  // Kechikkan ustuni = muddati o'tgan "Bajarilishi kerak" vazifalar (Jarayonda / Mijozdan kutilmoqda sanalmaydi,
  // rahbar qarori) — buxgalterning "Mening kunim" kartasi bilan bir xil
  const rows = await q(
    pool,
    `SELECT u.id, u.full_name AS "fullName",
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.done_by = u.id AND t.status = 'DONE' AND t.done_at >= $3)::int AS "doneToday",
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.done_by = u.id AND t.status = 'DONE' AND t.done_at >= $4)::int AS "doneWeek",
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.done_by = u.id AND t.status = 'DONE' AND t.done_at >= $5)::int AS "doneMonth",
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.done_by = u.id AND t.status = 'DONE' AND t.done_at BETWEEN $1 AND $2)::int AS done,
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.done_by = u.id AND t.status = 'DONE' AND t.done_at BETWEEN $1 AND $2
          AND t.due_at IS NOT NULL)::int AS "doneWithDue",
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.done_by = u.id AND t.status = 'DONE' AND t.done_at BETWEEN $1 AND $2
          AND t.done_at <= t.due_at)::int AS "onTime",
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.assignee_id = u.id AND t.status = 'TODO' AND t.due_at < now())::int AS overdue,
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.assignee_id = u.id AND t.status = 'WAITING_CLIENT')::int AS waiting,
       (SELECT count(*) FROM task t JOIN client tc ON tc.id = t.client_id AND ${COUNTED_CLIENT('tc')} WHERE t.assignee_id = u.id AND t.status IN ${OPEN})::int AS "openTasks",
       (SELECT count(*) FROM client c WHERE c.accountant_id = u.id)::int AS clients,
       (SELECT coalesce(sum(extract(epoch FROM least(coalesce(te.ended_at, now()), $2) - greatest(te.started_at, $1))), 0)::int
          FROM time_entry te JOIN task tt ON tt.id = te.task_id JOIN client tc ON tc.id = tt.client_id AND ${COUNTED_CLIENT('tc')}
          WHERE te.user_id = u.id AND te.started_at <= $2 AND coalesce(te.ended_at, now()) >= $1) AS "spentSec"
     FROM app_user u WHERE u.role = 'ACCOUNTANT' AND u.active ORDER BY u.full_name`,
    [from, to, dayFrom, weekFrom, monthFrom],
  );
  res.json({
    from: DateTime.fromJSDate(from).setZone(TZ).toISODate(),
    to: DateTime.fromJSDate(to).setZone(TZ).toISODate(),
    // "O'z vaqtida" = done_at <= due_at (muddatsiz vazifalar foizga kirmaydi)
    accountants: rows.map((r: any) => ({
      ...r,
      onTimePercent: r.doneWithDue ? Math.round((r.onTime / r.doneWithDue) * 100) : null,
    })),
  });
});

// ---------- Audit ----------
export const auditRouter = Router();
auditRouter.use(requireAuth, requireLeader);

auditRouter.get('/', async (req, res) => {
  const f = parse(
    z.object({
      actorId: z.coerce.number().int().optional(),
      clientId: z.coerce.number().int().optional(),
      entity: z.string().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (f.actorId) where.push(`l.actor_id = ${p(f.actorId)}`);
  if (f.clientId) where.push(`l.client_id = ${p(f.clientId)}`);
  if (f.entity) where.push(`l.entity = ${p(f.entity)}`);
  if (f.from) where.push(`l.at >= ${p(dayStart(f.from))}`);
  if (f.to) where.push(`l.at <= ${p(dayEnd(f.to))}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await one<{ n: number }>(pool, `SELECT count(*) AS n FROM audit_log l ${w}`, params))!.n;
  const items = await q(
    pool,
    `SELECT l.id, l.entity, l.entity_id AS "entityId", l.client_id AS "clientId", c.name AS "clientName",
            l.action, l.before, l.after, l.at, l.actor_id AS "actorId", u.full_name AS "actorName"
     FROM audit_log l LEFT JOIN app_user u ON u.id = l.actor_id LEFT JOIN client c ON c.id = l.client_id
     ${w} ORDER BY l.at DESC, l.id DESC LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`,
    params,
  );
  res.json({ items, total, page: f.page, pageSize: f.pageSize });
});
