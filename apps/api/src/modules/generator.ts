import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth, requireLeader } from '../common/auth';
import { audit } from '../common/audit';
import { parse } from '../common/errors';
import { currentPeriod, periodFromMonth } from '../common/time';
import { type Db, dryTx, one, q, tx } from '../db';
import { reopenDue } from './taskService';

// Generator qoidalari (CLAUDE.md 6.2, 6.3). "Qaysi soliq turiga qaysi hisobot" SQL funksiyasida
// (fn_report_applicability, report_type ma'lumotidan), shu yerda qotirilmagan.
// Idempotentlik: UNIQUE indeks + ON CONFLICT DO NOTHING; bekor qilinganlari qayta ochiladi.

const CONFLICT = `ON CONFLICT (client_id, kind, coalesce(routine_type_id, 0), coalesce(report_type_id, 0), period)
                  WHERE kind IN ('ROUTINE', 'REPORT') DO NOTHING`;

export async function getDueTime(db: Db): Promise<string> {
  const r = await one<{ value: string }>(db, `SELECT value FROM setting WHERE key = 'task_due_time'`);
  return typeof r?.value === 'string' && /^\d{2}:\d{2}$/.test(r.value) ? r.value : '18:00';
}

export interface GenerateResult {
  period: string;
  created: { id: number; clientId: number; kind: string; title: string }[];
  reopened: { id: number; clientId: number; kind: string; title: string }[];
}

/** Davr uchun yetishmayotgan vazifalarni yaratadi (clientId berilsa faqat shu mijoz uchun). */
export async function generatePeriod(db: Db, period: string, clientId: number | null = null): Promise<GenerateResult> {
  const dueTime = await getDueTime(db);
  // Qo'llanadigan (mijoz, hisobot) juftliklari; har so'rovda CTE sifatida
  const A = `WITH a AS (SELECT client_id, report_type_id FROM fn_report_applicability($1)
                        WHERE applicable AND ($2::bigint IS NULL OR client_id = $2))`;

  // 1) Hisobot vazifalari. creates_accountant_task=false: buxgalterga biriktirilmaydi (assignee NULL),
  //    faqat oylik jadval katagi uchun yozuv bo'ladi (rahbar/jadvaldan belgilanadi).
  const reopenedReports = await q(
    db,
    `${A}
     UPDATE task t SET status = 'TODO', prev_status = NULL, cancel_reason = NULL,
            assignee_id = CASE WHEN rt.creates_accountant_task THEN c.accountant_id END, ${reopenDue('t.', '$3')}
     FROM a, report_type rt, client c
     WHERE t.client_id = a.client_id AND t.kind = 'REPORT' AND t.report_type_id = a.report_type_id
       AND t.period = $1 AND t.status = 'CANCELLED' AND rt.id = a.report_type_id AND c.id = a.client_id
     RETURNING t.id, t.client_id AS "clientId", t.kind, t.title`,
    [period, clientId, dueTime],
  );
  const reports = await q(
    db,
    `${A}
     INSERT INTO task (client_id, kind, report_type_id, period, title, assignee_id, due_at, status, overdue_notified_at)
     SELECT a.client_id, 'REPORT', a.report_type_id, $1, rt.name,
            CASE WHEN rt.creates_accountant_task THEN c.accountant_id END,
            fn_report_due_at($1, rt.due_day, $3, rt.due_month_offset), 'TODO',
            -- oy o'rtasida yaratilib muddati allaqachon o'tgan bo'lsa (yangi hisobot turi, kech generatsiya) xabar yuborilmaydi
            CASE WHEN fn_report_due_at($1, rt.due_day, $3, rt.due_month_offset) < now() THEN now() END
     FROM a
     JOIN report_type rt ON rt.id = a.report_type_id
     JOIN client c ON c.id = a.client_id
     ${CONFLICT}
     RETURNING id, client_id AS "clientId", kind, title`,
    [period, clientId, dueTime],
  );

  // 2) Oylik doimiy ishlar: qo'llanishi fn_routine_applicability'da (V31) — ACTIVE, soliq turi aniqlangan (V24),
  //    Buxgalter ishlari bo'limidagi (V25 in_works), rahbarning qo'lda tanlovi (V31) ustun. INPS kabi hisobotga
  //    bog'langan ish, hisobot qo'llansa alohida yaratilmaydi (bitta vazifa). Muddat: buxgalteriya 1 oy orqada (V34) —
  //    ish oyidan keyingi oyning due_day-kuni (fn_work_due_at; belgilanmagan bo'lsa keyingi oy oxiri, INPS — hisobot muddati).
  const RA = `WITH ra AS (SELECT client_id, routine_type_id FROM fn_routine_applicability($1)
                         WHERE applicable AND ($2::bigint IS NULL OR client_id = $2))`;
  const reopenedRoutines = await q(
    db,
    `${RA}
     UPDATE task t SET status = 'TODO', prev_status = NULL, cancel_reason = NULL, assignee_id = c.accountant_id,
            ${reopenDue('t.', '$3')}
     FROM ra, client c
     WHERE t.client_id = ra.client_id AND t.kind = 'ROUTINE' AND t.routine_type_id = ra.routine_type_id AND t.period = $1
       AND t.status = 'CANCELLED' AND c.id = ra.client_id
     RETURNING t.id, t.client_id AS "clientId", t.kind, t.title`,
    [period, clientId, dueTime],
  );
  const routines = await q(
    db,
    `${RA}
     INSERT INTO task (client_id, kind, routine_type_id, period, title, assignee_id, due_at, status)
     SELECT c.id, 'ROUTINE', w.id, $1, w.name, c.accountant_id, fn_work_due_at($1, w.id, $3), 'TODO'
     FROM ra
     JOIN client c ON c.id = ra.client_id
     JOIN routine_work_type w ON w.id = ra.routine_type_id
     ORDER BY c.id, w.sort_order
     ${CONFLICT}
     RETURNING id, client_id AS "clientId", kind, title`,
    [period, clientId, dueTime],
  );

  // 3) Choraklik/yillik ustunlar jadvalda har oy ko'rinadi (V11): katak oxirgi generatsiya oyidagi vazifadan.
  //    O'sha davr vazifasi yo'q bo'lsa (tizim keyin ishga tushgan, mijoz yangi qo'shilgan) shu davrga yaratiladi.
  //    Muddati allaqachon o'tgan bo'lsa "muddat o'tdi" xabari yuborilmaydi (overdue_notified_at = now()).
  const backfilled = await q(
    db,
    `WITH g AS (SELECT * FROM fn_grid_columns($1) WHERE source_period < $1),
          a AS (SELECT x.client_id, x.report_type_id, g.source_period AS period
                FROM (SELECT DISTINCT source_period FROM g) s
                CROSS JOIN LATERAL fn_report_applicability(s.source_period) x
                JOIN g ON g.report_type_id = x.report_type_id AND g.source_period = s.source_period
                WHERE x.applicable AND ($2::bigint IS NULL OR x.client_id = $2))
     INSERT INTO task (client_id, kind, report_type_id, period, title, assignee_id, due_at, status, overdue_notified_at)
     SELECT a.client_id, 'REPORT', a.report_type_id, a.period, rt.name,
            CASE WHEN rt.creates_accountant_task THEN c.accountant_id END,
            fn_report_due_at(a.period, rt.due_day, $3, rt.due_month_offset), 'TODO',
            CASE WHEN fn_report_due_at(a.period, rt.due_day, $3, rt.due_month_offset) < now() THEN now() END
     FROM a
     JOIN report_type rt ON rt.id = a.report_type_id
     JOIN client c ON c.id = a.client_id
     ${CONFLICT}
     RETURNING id, client_id AS "clientId", kind, title`,
    [period, clientId, dueTime],
  );

  return { period, created: [...reports, ...routines, ...backfilled], reopened: [...reopenedReports, ...reopenedRoutines] };
}

/**
 * Mijoz o'zgarganda (soliq turi, holat, dividend) joriy davrni moslashtirish:
 * endi qo'llanmaydigan OCHIQ vazifalar CANCELLED (o'chirilmaydi, audit'da), yangilari yaratiladi, DONE tegilmaydi.
 */
export async function reconcileClient(db: Db, clientId: number, actorId: number | null, period = currentPeriod()) {
  const cancelled = await q(
    db,
    `UPDATE task t SET prev_status = t.status, status = 'CANCELLED', cancel_reason = 'NOT_APPLICABLE'
     FROM client c
     WHERE c.id = t.client_id AND t.client_id = $1 AND t.period = $2
       AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
       AND (
         (t.kind = 'REPORT' AND NOT EXISTS (
            SELECT 1 FROM fn_report_applicability($2) a
            WHERE a.client_id = t.client_id AND a.report_type_id = t.report_type_id AND a.applicable))
         OR (t.kind = 'ROUTINE' AND NOT EXISTS (
            SELECT 1 FROM fn_routine_applicability($2) r
            WHERE r.client_id = t.client_id AND r.routine_type_id = t.routine_type_id AND r.applicable))
       )
     RETURNING t.id, t.kind, t.title, t.prev_status AS "prevStatus"`,
    [clientId, period],
  );
  for (const t of cancelled) {
    await db.query('UPDATE time_entry SET ended_at = now() WHERE task_id = $1 AND ended_at IS NULL', [t.id]);
    await audit(db, {
      actorId,
      entity: 'task',
      entityId: t.id,
      clientId,
      action: 'CANCEL_NOT_APPLICABLE',
      before: { status: t.prevStatus },
      after: { status: 'CANCELLED', title: t.title },
    });
  }
  const gen = await generatePeriod(db, period, clientId);
  for (const t of [...gen.created, ...gen.reopened]) {
    await audit(db, {
      actorId,
      entity: 'task',
      entityId: t.id,
      clientId,
      action: gen.created.includes(t) ? 'CREATE_RECONCILE' : 'REOPEN_RECONCILE',
      after: { kind: t.kind, title: t.title },
    });
  }
  return { cancelled, created: gen.created, reopened: gen.reopened };
}

/**
 * 6.8: buxgalter almashsa ochiq vazifalar yangisiga o'tadi, DONE eskisida qoladi.
 * Biriktirilmagan vazifalar ham (mijozga buxgalter keyinroq qo'yilsa) o'tadi — faqat
 * creates_accountant_task = false hisobotlar emas: ular ataylab hech kimga biriktirilmaydi.
 */
export async function reassignOpenTasks(db: Db, clientId: number, newAccountantId: number | null, actorId: number) {
  const moved = await q(
    db,
    `WITH old AS (
       SELECT t.id, t.assignee_id FROM task t
       LEFT JOIN report_type rt ON rt.id = t.report_type_id
       WHERE t.client_id = $1 AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
         AND t.assignee_id IS DISTINCT FROM $2
         AND (t.assignee_id IS NOT NULL OR t.kind <> 'REPORT' OR rt.creates_accountant_task)
         AND t.kind IN ('ROUTINE', 'REPORT', 'URGENT', 'MANUAL')
     )
     UPDATE task t SET assignee_id = $2 FROM old WHERE t.id = old.id
     RETURNING t.id, old.assignee_id AS "oldAssigneeId"`,
    [clientId, newAccountantId],
  );
  for (const m of moved) {
    // Eski buxgalterning ochiq taymerini to'xtatamiz
    await db.query('UPDATE time_entry SET ended_at = now() WHERE task_id = $1 AND user_id = $2 AND ended_at IS NULL', [
      m.id,
      m.oldAssigneeId,
    ]);
    await audit(db, {
      actorId,
      entity: 'task',
      entityId: m.id,
      clientId,
      action: 'REASSIGN',
      before: { assigneeId: m.oldAssigneeId },
      after: { assigneeId: newAccountantId },
    });
  }
  return moved.length;
}

/** Oy uchun to'liq generatsiya (scheduler va API). dryRun: tranzaksiya ROLLBACK qilinadi. */
export async function runGenerator(period: string, dryRun: boolean, actorId: number | null) {
  const run = async (db: Db) => {
    const r = await generatePeriod(db, period);
    const byClient = await q(
      db,
      `SELECT c.id AS "clientId", c.name AS "clientName", c.status, c.tax_type AS "taxType",
              count(*) FILTER (WHERE t.kind = 'REPORT')::int AS reports,
              count(*) FILTER (WHERE t.kind = 'ROUTINE')::int AS routines
       FROM task t JOIN client c ON c.id = t.client_id
       WHERE t.id = ANY ($1::bigint[]) GROUP BY c.id ORDER BY c.name`,
      [[...r.created, ...r.reopened].map((t) => t.id)],
    );
    const summary = {
      period,
      dryRun,
      created: r.created.length,
      reopened: r.reopened.length,
      reports: r.created.filter((t) => t.kind === 'REPORT').length,
      routines: r.created.filter((t) => t.kind === 'ROUTINE').length,
    };
    // Generator bitta umumiy audit yozuvi qoldiradi (har vazifa uchun alohida emas: oyiga ~1500 qator)
    if (!dryRun) await audit(db, { actorId, entity: 'generator', entityId: period, action: 'RUN', after: summary });
    return { ...summary, byClient };
  };
  return dryRun ? dryTx(run) : tx(run);
}

export const generatorRouter = Router();
generatorRouter.use(requireAuth, requireLeader);

generatorRouter.post('/run', async (req, res) => {
  const { month, dryRun } = parse(
    z.object({ month: z.string().optional(), dryRun: z.enum(['true', 'false']).default('true') }),
    req.query,
  );
  res.json(await runGenerator(periodFromMonth(month), dryRun === 'true', me(req).id));
});
