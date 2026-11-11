import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth, requireLeader } from '../common/auth';
import { audit, diff } from '../common/audit';
import { AppError, notFound, parse } from '../common/errors';
import { type Db, one, pool, q, tx } from '../db';
import { currentPeriod, workPeriod } from '../common/time';
import { sharePercent } from './clients';
import { getDueTime } from './generator';
import { reopenDue, stopTimersForTask } from './taskService';
import { getOverdueReminder, overdueReminderSchema, reminderDays } from './overdueReminder';

// Sozlamalar: hamma o'qiydi, faqat rahbar yozadi. O'zgarishlar keyingi generatsiyadan kuchga kiradi;
// istisno — hisobot muddat kuni: joriy va keyingi davrlarning ochiq vazifalari ham yangi muddatga o'tadi.

const REPORT = `id, code, name, name_ru AS "nameRu", frequency, due_day AS "dueDay", generation_months AS "generationMonths",
  applies_to_aos AS "appliesToAos", applies_to_qqs AS "appliesToQqs", applies_to_yatt AS "appliesToYatt", creates_accountant_task AS "createsAccountantTask",
  requires_event_flag AS "requiresEventFlag", sheet_aliases AS "sheetAliases", active, sort_order AS "sortOrder"`;
const ROUTINE = `id, name, name_ru AS "nameRu", sort_order AS "sortOrder", active, report_type_id AS "reportTypeId",
  is_free_text AS "isFreeText", effective_from AS "effectiveFrom", due_day AS "dueDay"`;

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const intId = z.coerce.number().int().positive();

// ---------- Hisobot turlari ----------
settingsRouter.get('/report-types', async (_req, res) => {
  res.json(await q(pool, `SELECT ${REPORT} FROM report_type ORDER BY sort_order, id`));
});

settingsRouter.patch('/report-types/:id', requireLeader, async (req, res) => {
  const u = me(req);
  const id = parse(intId, req.params.id);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(200).optional(),
      nameRu: z.string().trim().min(1).max(200).optional(),
      dueDay: z.number().int().min(1).max(31).nullable().optional(),
      generationMonths: z.array(z.number().int().min(1).max(12)).min(1).nullable().optional(),
      appliesToAos: z.boolean().optional(),
      appliesToQqs: z.boolean().optional(),
      appliesToYatt: z.boolean().optional(),
      createsAccountantTask: z.boolean().optional(),
      requiresEventFlag: z.boolean().optional(),
      sheetAliases: z.array(z.string().trim().min(2).max(50)).optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
    req.body,
  );
  const row = await tx(async (db) => {
    const before = await one(db, `SELECT ${REPORT} FROM report_type WHERE id = $1 FOR UPDATE`, [id]);
    if (!before) throw notFound('Hisobot turi');
    const r = await one(
      db,
      `UPDATE report_type SET
         name = coalesce($2, name), name_ru = coalesce($3, name_ru),
         due_day = CASE WHEN $4 THEN $5::int ELSE due_day END,
         generation_months = CASE WHEN $6 THEN $7::int[] ELSE generation_months END,
         applies_to_aos = coalesce($8, applies_to_aos), applies_to_qqs = coalesce($9, applies_to_qqs),
         creates_accountant_task = coalesce($10, creates_accountant_task),
         requires_event_flag = coalesce($11, requires_event_flag),
         sheet_aliases = coalesce($12, sheet_aliases),
         active = coalesce($13, active), sort_order = coalesce($14, sort_order),
         applies_to_yatt = coalesce($15, applies_to_yatt)
       WHERE id = $1 RETURNING ${REPORT}`,
      [
        id,
        body.name ?? null,
        body.nameRu ?? null,
        body.dueDay !== undefined,
        body.dueDay ?? null,
        body.generationMonths !== undefined,
        body.generationMonths ?? null,
        body.appliesToAos ?? null,
        body.appliesToQqs ?? null,
        body.createsAccountantTask ?? null,
        body.requiresEventFlag ?? null,
        body.sheetAliases ? body.sheetAliases.map((a) => a.toUpperCase()) : null,
        body.active ?? null,
        body.sortOrder ?? null,
        body.appliesToYatt ?? null,
      ],
    );
    const d = diff(before, body);
    // Muddat kuni bitta joyda: o'zgarsa ochiq vazifalar (belgilanadigan oydan: noyabrda oktyabr — muddati shu oyda)
    // ham yangi muddatga o'tadi — jadval, karta, vazifa ranglari bir xil sanani ko'rsatsin. Undan oldingi davrlar va
    // bajarilganlari tegilmaydi (qayta ochilsa muddat qoidadan qayta hisoblanadi, V37).
    // Yangi muddat allaqachon o'tgan bo'lsa "muddat o'tdi" xabari qayta yuborilmaydi; keyinga surilsa yana yuboriladi.
    let retimed = 0;
    if (body.dueDay !== undefined && body.dueDay !== before.dueDay) {
      const moved = await db.query(
        `UPDATE task SET due_at = fn_report_due_at(period, $2, $4, (SELECT due_month_offset FROM report_type WHERE id = $1)),
                overdue_notified_at = CASE WHEN fn_report_due_at(period, $2, $4, (SELECT due_month_offset FROM report_type WHERE id = $1)) < now()
                                           THEN coalesce(overdue_notified_at, now()) END
         WHERE kind = 'REPORT' AND report_type_id = $1 AND period >= $3
           AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')`,
        [id, body.dueDay, workPeriod(), await getDueTime(db)],
      );
      // Hisobotga bog'langan doimiy ish (INPS, mijoz faqat Buxgalter ishlarida) ham shu muddatda
      const linked = await db.query(
        `UPDATE task t SET due_at = fn_work_due_at(t.period, t.routine_type_id, $3),
                overdue_notified_at = CASE WHEN fn_work_due_at(t.period, t.routine_type_id, $3) < now() THEN coalesce(t.overdue_notified_at, now()) END
         FROM routine_work_type w
         WHERE w.id = t.routine_type_id AND w.report_type_id = $1 AND t.kind = 'ROUTINE' AND t.period >= $2
           AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')`,
        [id, workPeriod(), await getDueTime(db)],
      );
      retimed = (moved.rowCount ?? 0) + (linked.rowCount ?? 0);
    }
    if (d.changed) {
      await audit(db, { actorId: u.id, entity: 'report_type', entityId: id, action: 'UPDATE', before: d.before, after: retimed ? { ...d.after, tasksRetimed: retimed } : d.after });
    }
    return r;
  });
  res.json(row);
});

// ---------- Oylik doimiy ishlar (maks. 10 faol, DB trigger) ----------
settingsRouter.get('/routine-works', async (_req, res) => {
  res.json(await q(pool, `SELECT ${ROUTINE} FROM routine_work_type WHERE deleted_at IS NULL ORDER BY active DESC, sort_order, id`));
});

/**
 * Yangi yoki qayta yoqilgan ish joriy ish oyidan chiqadi (rahbar qarori): noyabrda qo'shilsa oktyabr ishi
 * (muddati noyabrda) va noyabr ishi darhol yaratiladi — Buxgalter ishlari jadvalida shu zahoti bosiladi.
 * Qaror: generatePeriod butun davrni qayta yuritadi (hisobotlar ham), shuning uchun faqat shu ish uchun
 * generator 2-qadami takrorlanadi. Muddati o'tib ketgan vazifaga "muddat o'tdi" xabari yuborilmaydi.
 */
async function startRoutineWork(db: Db, id: number, actorId: number) {
  const dueTime = await getDueTime(db);
  let created = 0;
  for (const period of [workPeriod(), currentPeriod()]) {
    const RA = `WITH ra AS (SELECT client_id FROM fn_routine_applicability($1) WHERE applicable AND routine_type_id = $2)`;
    const reopened = await db.query(
      `${RA}
       UPDATE task t SET status = 'TODO', prev_status = NULL, cancel_reason = NULL, assignee_id = c.accountant_id,
              ${reopenDue('t.', '$3')}
       FROM ra, client c
       WHERE t.client_id = ra.client_id AND t.kind = 'ROUTINE' AND t.routine_type_id = $2 AND t.period = $1
         AND t.status = 'CANCELLED' AND c.id = ra.client_id`,
      [period, id, dueTime],
    );
    const inserted = await db.query(
      `${RA}
       INSERT INTO task (client_id, kind, routine_type_id, period, title, assignee_id, due_at, status, overdue_notified_at)
       SELECT c.id, 'ROUTINE', w.id, $1, w.name, c.accountant_id, fn_work_due_at($1, w.id, $3), 'TODO',
              CASE WHEN fn_work_due_at($1, w.id, $3) < now() THEN now() END
       FROM ra JOIN client c ON c.id = ra.client_id JOIN routine_work_type w ON w.id = $2
       ON CONFLICT (client_id, kind, coalesce(routine_type_id, 0), coalesce(report_type_id, 0), period)
         WHERE kind IN ('ROUTINE', 'REPORT') DO NOTHING`,
      [period, id, dueTime],
    );
    created += (reopened.rowCount ?? 0) + (inserted.rowCount ?? 0);
  }
  if (created) {
    await audit(db, { actorId, entity: 'routine_work_type', entityId: id, action: 'GENERATE', after: { tasks: created, from: workPeriod() } });
  }
}

async function activeRoutineCount(db: Db) {
  return (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM routine_work_type WHERE active'))!.n;
}

settingsRouter.post('/routine-works', requireLeader, async (req, res) => {
  const u = me(req);
  const body = parse(
    z.object({ name: z.string().trim().min(1).max(200), nameRu: z.string().trim().max(200).optional(), isFreeText: z.boolean().default(false) }),
    req.body,
  );
  const row = await tx(async (db) => {
    if ((await activeRoutineCount(db)) >= 10) {
      throw new AppError(409, 'ROUTINE_LIMIT', 'Faol oylik ishlar soni 10 tadan oshmasligi kerak', { max: 10 });
    }
    // Yangi ish joriy ish oyidan chiqadi (rahbar qarori; oldin keyingi oydan edi)
    const r = await one(
      db,
      `INSERT INTO routine_work_type (name, name_ru, is_free_text, sort_order, effective_from)
       VALUES ($1, $2, $3, coalesce((SELECT max(sort_order) + 1 FROM routine_work_type), 1), $4) RETURNING ${ROUTINE}`,
      [body.name, body.nameRu || body.name, body.isFreeText, workPeriod()],
    );
    await audit(db, { actorId: u.id, entity: 'routine_work_type', entityId: r.id, action: 'CREATE', after: r });
    await startRoutineWork(db, r.id, u.id);
    return r;
  });
  res.status(201).json(row);
});

settingsRouter.put('/routine-works/order', requireLeader, async (req, res) => {
  const u = me(req);
  const { ids } = parse(z.object({ ids: z.array(intId).min(1) }), req.body);
  await tx(async (db) => {
    for (const [i, id] of ids.entries()) {
      await db.query('UPDATE routine_work_type SET sort_order = $2 WHERE id = $1', [id, i + 1]);
    }
    await audit(db, { actorId: u.id, entity: 'routine_work_type', entityId: null, action: 'REORDER', after: { ids } });
  });
  res.json(await q(pool, `SELECT ${ROUTINE} FROM routine_work_type WHERE deleted_at IS NULL ORDER BY active DESC, sort_order, id`));
});

settingsRouter.patch('/routine-works/:id', requireLeader, async (req, res) => {
  const u = me(req);
  const id = parse(intId, req.params.id);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(200).optional(),
      nameRu: z.string().trim().min(1).max(200).optional(),
      sortOrder: z.number().int().optional(),
      active: z.boolean().optional(),
      isFreeText: z.boolean().optional(),
      // Keyingi oyning nechanchi kunigacha (V34); null — keyingi oy oxiri
      dueDay: z.number().int().min(1).max(31).nullable().optional(),
    }),
    req.body,
  );
  const row = await tx(async (db) => {
    const before = await one(db, `SELECT ${ROUTINE} FROM routine_work_type WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    if (!before) throw notFound('Oylik ish');
    if (body.active === true && !before.active && (await activeRoutineCount(db)) >= 10) {
      throw new AppError(409, 'ROUTINE_LIMIT', 'Faol oylik ishlar soni 10 tadan oshmasligi kerak', { max: 10 });
    }
    const r = await one(
      db,
      `UPDATE routine_work_type SET name = coalesce($2, name), name_ru = coalesce($3, name_ru),
         sort_order = coalesce($4, sort_order), active = coalesce($5, active), is_free_text = coalesce($6, is_free_text),
         due_day = CASE WHEN $7 THEN $8::int ELSE due_day END,
         -- Qayta yoqilgan ish ham joriy ish oyidan chiqadi (oldingi tarix saqlanadi: LEAST)
         effective_from = CASE WHEN $5 IS TRUE AND NOT active
                               THEN LEAST(effective_from, $9::date) ELSE effective_from END
       WHERE id = $1 RETURNING ${ROUTINE}`,
      [id, body.name ?? null, body.nameRu ?? null, body.sortOrder ?? null, body.active ?? null, body.isFreeText ?? null, body.dueDay !== undefined, body.dueDay ?? null, workPeriod()],
    );
    if (body.active === true && !before.active) await startRoutineWork(db, id, u.id);
    const d = diff(before, body);
    // Muddat kuni hisobotdagidek darhol: ochiq vazifalar (bajarilmagan barcha oylar) yangi muddatga o'tadi
    let retimed = 0;
    if (body.dueDay !== undefined && body.dueDay !== before.dueDay) {
      const dueTime = await getDueTime(db);
      const moved = await db.query(
        `UPDATE task SET due_at = fn_work_due_at(period, $1, $2),
                overdue_notified_at = CASE WHEN fn_work_due_at(period, $1, $2) < now() THEN coalesce(overdue_notified_at, now()) END
         WHERE kind = 'ROUTINE' AND routine_type_id = $1 AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')`,
        [id, dueTime],
      );
      retimed = moved.rowCount ?? 0;
    }
    if (d.changed) await audit(db, { actorId: u.id, entity: 'routine_work_type', entityId: id, action: 'UPDATE', before: d.before, after: retimed ? { ...d.after, tasksRetimed: retimed } : d.after });
    return r;
  });
  res.json(row);
});

// O'chirish (V50). Hisobot bilan bog'langan ish (INPS) o'chirilmaydi — u hisobotlar orqali ishlaydi.
// Vazifasi yo'q ish (masalan, xato qo'shilgan) butunlay o'chiriladi; vazifasi bor ish yumshoq o'chiriladi:
// ro'yxatdan yo'qoladi, ochiq vazifalari bekor qilinadi, bajarilganlari tarixda qoladi. Hammasi audit'da.
settingsRouter.delete('/routine-works/:id', requireLeader, async (req, res) => {
  const u = me(req);
  const id = parse(intId, req.params.id);
  const result = await tx(async (db) => {
    const before = await one<{ id: number; reportTypeId: number | null }>(
      db, `SELECT ${ROUTINE} FROM routine_work_type WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id],
    );
    if (!before) throw notFound('Oylik ish');
    if (before.reportTypeId) throw new AppError(409, 'ROUTINE_LINKED', "Hisobot bilan bog'langan ishni o'chirib bo'lmaydi");
    const used = await one(db, 'SELECT 1 FROM task WHERE routine_type_id = $1 LIMIT 1', [id]);
    if (!used) {
      for (const tbl of ['client_routine_baseline', 'client_routine_raw', 'client_routine_cell']) {
        await db.query(`DELETE FROM ${tbl} WHERE routine_type_id = $1`, [id]);
      }
      await db.query('DELETE FROM routine_work_type WHERE id = $1', [id]);
      await audit(db, { actorId: u.id, entity: 'routine_work_type', entityId: id, action: 'DELETE', before });
      return { deleted: 'HARD' as const, cancelled: 0 };
    }
    await db.query('UPDATE routine_work_type SET active = false, deleted_at = now() WHERE id = $1', [id]);
    const cancelled = await q<{ id: number; clientId: number; title: string; prevStatus: string }>(
      db,
      `UPDATE task SET prev_status = status, status = 'CANCELLED', cancel_reason = 'WORK_DELETED'
       WHERE kind = 'ROUTINE' AND routine_type_id = $1 AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
       RETURNING id, client_id AS "clientId", title, prev_status AS "prevStatus"`,
      [id],
    );
    for (const t of cancelled) {
      await stopTimersForTask(db, t.id);
      await audit(db, {
        actorId: u.id, entity: 'task', entityId: t.id, clientId: t.clientId, action: 'CANCEL_WORK_DELETED',
        before: { status: t.prevStatus }, after: { status: 'CANCELLED', title: t.title },
      });
    }
    await audit(db, { actorId: u.id, entity: 'routine_work_type', entityId: id, action: 'DELETE', before, after: { deleted: 'SOFT', tasksCancelled: cancelled.length } });
    return { deleted: 'SOFT' as const, cancelled: cancelled.length };
  });
  res.json(result);
});

// ---------- Shoshilinch vazifa shablonlari ----------
interface Template {
  id: string;
  text: string;
}
async function getTemplates(db: Db): Promise<Template[]> {
  const r = await one<{ value: Template[] }>(db, `SELECT value FROM setting WHERE key = 'urgent_templates'`);
  return Array.isArray(r?.value) ? r!.value : [];
}
async function saveTemplates(db: Db, list: Template[], actorId: number, action: string, before: unknown, after: unknown) {
  await db.query(
    `INSERT INTO setting (key, value) VALUES ('urgent_templates', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(list)],
  );
  await audit(db, { actorId, entity: 'setting', entityId: 'urgent_templates', action, before, after });
}

settingsRouter.get('/urgent-templates', async (_req, res) => {
  res.json(await getTemplates(pool));
});

settingsRouter.post('/urgent-templates', requireLeader, async (req, res) => {
  const u = me(req);
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(500) }), req.body);
  const t = await tx(async (db) => {
    const list = await getTemplates(db);
    const item = { id: crypto.randomUUID().slice(0, 8), text };
    await saveTemplates(db, [...list, item], u.id, 'CREATE', null, item);
    return item;
  });
  res.status(201).json(t);
});

settingsRouter.patch('/urgent-templates/:id', requireLeader, async (req, res) => {
  const u = me(req);
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(500) }), req.body);
  const t = await tx(async (db) => {
    const list = await getTemplates(db);
    const old = list.find((x) => x.id === req.params.id);
    if (!old) throw notFound('Shablon');
    const item = { ...old, text };
    await saveTemplates(db, list.map((x) => (x.id === old.id ? item : x)), u.id, 'UPDATE', old, item);
    return item;
  });
  res.json(t);
});

settingsRouter.delete('/urgent-templates/:id', requireLeader, async (req, res) => {
  const u = me(req);
  await tx(async (db) => {
    const list = await getTemplates(db);
    const old = list.find((x) => x.id === req.params.id);
    if (!old) throw notFound('Shablon');
    await saveTemplates(db, list.filter((x) => x.id !== old.id), u.id, 'DELETE', old, null);
  });
  res.status(204).end();
});

// ---------- Kechikkan mijozlar eslatmasi ----------
settingsRouter.get('/overdue-reminder', async (_req, res) => {
  const cfg = await getOverdueReminder(pool);
  res.json({ ...cfg, previewDays: reminderDays(cfg.steps) });
});

settingsRouter.put('/overdue-reminder', requireLeader, async (req, res) => {
  const u = me(req);
  const body = parse(overdueReminderSchema, req.body);
  await tx(async (db) => {
    const before = await getOverdueReminder(db);
    await db.query(
      `INSERT INTO setting (key, value) VALUES ('overdue_reminder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(body)],
    );
    await audit(db, { actorId: u.id, entity: 'setting', entityId: 'overdue_reminder', action: 'UPDATE', before, after: body });
  });
  res.json({ ...body, previewDays: reminderDays(body.steps) });
});

// ---------- Umumiy ----------
settingsRouter.get('/general', async (_req, res) => {
  const r = await one<{ value: string }>(pool, `SELECT value FROM setting WHERE key = 'task_due_time'`);
  res.json({ taskDueTime: r?.value ?? '18:00', accountantSharePercent: await sharePercent(pool) });
});

settingsRouter.put('/general', requireLeader, async (req, res) => {
  const u = me(req);
  const body = parse(
    z.object({
      taskDueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      // "Бухгалтер ишлари" faylidagi 30% (buxgalterlar ulushi)
      accountantSharePercent: z.number().min(0).max(100).optional(),
    }),
    req.body,
  );
  const KEYS = { taskDueTime: 'task_due_time', accountantSharePercent: 'accountant_share_percent' } as const;
  await tx(async (db) => {
    for (const [field, key] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
      if (body[field] === undefined) continue;
      const before = await one(db, `SELECT value FROM setting WHERE key = $1`, [key]);
      await db.query(
        `INSERT INTO setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(body[field])],
      );
      await audit(db, { actorId: u.id, entity: 'setting', entityId: key, action: 'UPDATE', before: { [field]: before?.value ?? null }, after: { [field]: body[field] } });
    }
  });
  const r = await one<{ value: string }>(pool, `SELECT value FROM setting WHERE key = 'task_due_time'`);
  res.json({ taskDueTime: r?.value ?? '18:00', accountantSharePercent: await sharePercent(pool) });
});
