import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { type AuthUser, isLeader, me, requireAuth, requireLeader } from '../common/auth';
import { audit } from '../common/audit';
import { AppError, forbidden, notFound, parse } from '../common/errors';
import { currentPeriod } from '../common/time';
import { config } from '../config';
import { type Db, one, pool, q, tx } from '../db';
import { CLIENT, FROM, clientListQuery, clientListWhere, loadClientForUser, presentClient, sharePercent } from './clients';
import { markDone } from './taskService';

// "Oylik ishlar" sahifasi ("Бухгалтер ишлари" fayli): qatorda mijoz, ustunda doimiy ish, katakda
// "qaysi oygacha bajarilgan" + necha oy orqada.
// Qaror: katak holati SAQLANMAYDI, vazifalardan hisoblanadi ("muddati o'tgan" kabi). Faqat tizimgacha
// bo'lgan oylar uchun client_routine_baseline (rahbar fayldan bir marta kiritadi).
// Hammasi "ish oyi"da yuritiladi: ROUTINE vazifa davri = ish oyi. Hisobotga bog'langan ish (INPS) esa
// keyingi oyda topshiriladi: oktyabr vazifasi (15.10) = sentabr ishi.
// TODO(tasdiqlash): hisobotga bog'langan ishning ish oyi = vazifa davri - 1 oy (INPS) deb olindi.

export type WorkTone = 'done' | 'waiting' | 'overdue' | 'soon';

export interface WorkColumn {
  routineTypeId: number;
  name: string;
  nameRu: string;
  reportTypeId: number | null;
  isFreeText: boolean;
  /** Jadval sarlavhasi (fayldagidek qisqa); bo'lmasa name */
  shortName: string | null;
  shortNameRu: string | null;
  /** Ketma-ket bir xil guruh sarlavha ustida birlashadi ("Schyot-faktura") */
  group: string | null;
  groupRu: string | null;
}

export interface WorkCell {
  /** Vazifa ham, boshlang'ich nuqta ham yo'q: ish bu mijozga chiqmaydi (holat/yangi ish) */
  na: boolean;
  /** 'YYYY-MM': shu oygacha (shu oy ham) uzluksiz bajarilgan */
  doneThrough: string | null;
  /** 'YYYY-MM': rahbar kiritgan tizimgacha bo'lgan nuqta */
  baseline: string | null;
  /** Muddati o'tgan, bajarilmagan oylar soni */
  lag: number;
  tone: WorkTone | null;
  /** Katakni bosganda nima yopiladi: tizimdagi vazifa yoki tizimgacha bo'lgan oy */
  next: { kind: 'TASK'; taskId: number; status: string; month: string } | { kind: 'BASELINE'; month: string } | null;
  /** Fayldagi tanilmagan qiymat ("eri", "28,02,2025(14)"): oy kiritilguncha boricha ko'rsatiladi (V24) */
  raw?: string | null;
}

const monthOfPeriod = (period: string) => period.slice(0, 7);
const addMonths = (period: string, n: number) => DateTime.fromISO(period).plus({ months: n }).toISODate()!;
/** from'dan keyingi oydan to'gacha (shu ham) nechta oy */
const monthsAfter = (from: string, to: string) => Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'months').months);
const workOffset = (c: WorkColumn) => (c.reportTypeId ? 1 : 0);

const COLUMN = `id AS "routineTypeId", name, name_ru AS "nameRu", report_type_id AS "reportTypeId", is_free_text AS "isFreeText",
  short_name AS "shortName", short_name_ru AS "shortNameRu", header_group AS "group", header_group_ru AS "groupRu"`;

export async function loadColumns(db: Db): Promise<WorkColumn[]> {
  return q<WorkColumn>(db, `SELECT ${COLUMN} FROM routine_work_type WHERE active ORDER BY sort_order, id`);
}

async function loadColumn(db: Db, id: number): Promise<WorkColumn> {
  const c = await one<WorkColumn>(db, `SELECT ${COLUMN} FROM routine_work_type WHERE id = $1 AND active`, [id]);
  if (!c) throw notFound('Oylik ish');
  return c;
}

interface Agg {
  clientId: number;
  routineTypeId: number;
  firstPeriod: string;
  lastDonePeriod: string | null;
  nextTaskId: number | null;
  nextStatus: string | null;
  nextPeriod: string | null;
  nextDueSoon: boolean | null;
  overdue: number;
}

/**
 * Mijozlar x ishlar uchun kataklar. Optimizatsiya: har katak uchun alohida so'rov emas, bitta
 * GROUP BY (mijoz, ish) — 100 mijoz x 8 ish = 800 qator; vazifalar ix_task_client_period orqali olinadi.
 * INPS ustuni hisobot vazifasidan ham o'qiladi (generator INPS'ni bitta REPORT vazifa qiladi).
 */
export async function loadCells(db: Db, clientIds: number[], columns: WorkColumn[]) {
  const typeIds = columns.map((c) => c.routineTypeId);
  const aggs = clientIds.length
    ? await q<Agg>(
        db,
        `WITH t AS (
           SELECT t.client_id, w.id AS rid, t.id, t.period, t.status, t.is_overdue, t.is_due_soon
           FROM v_task_state t
           JOIN routine_work_type w ON w.id = ANY ($2::bigint[]) AND (
                (t.kind = 'ROUTINE' AND t.routine_type_id = w.id)
             OR (t.kind = 'REPORT' AND t.report_type_id = w.report_type_id))
           WHERE t.client_id = ANY ($1::bigint[]) AND t.status <> 'CANCELLED'
         ), f AS (
           SELECT client_id, rid, min(period) FILTER (WHERE status <> 'DONE') AS first_open FROM t GROUP BY 1, 2
         )
         SELECT t.client_id AS "clientId", t.rid AS "routineTypeId",
                min(t.period) AS "firstPeriod",
                -- Uzluksiz bajarilgan: birinchi ochiq vazifadan oldingi eng oxirgi DONE
                max(t.period) FILTER (WHERE t.status = 'DONE' AND (f.first_open IS NULL OR t.period < f.first_open)) AS "lastDonePeriod",
                (array_agg(t.id ORDER BY t.period) FILTER (WHERE t.status <> 'DONE'))[1] AS "nextTaskId",
                (array_agg(t.status ORDER BY t.period) FILTER (WHERE t.status <> 'DONE'))[1] AS "nextStatus",
                f.first_open AS "nextPeriod",
                (array_agg(t.is_due_soon ORDER BY t.period) FILTER (WHERE t.status <> 'DONE'))[1] AS "nextDueSoon",
                count(*) FILTER (WHERE t.is_overdue)::int AS overdue
         FROM t JOIN f USING (client_id, rid)
         GROUP BY t.client_id, t.rid, f.first_open`,
        [clientIds, typeIds],
      )
    : [];
  const baselines = clientIds.length
    ? await q<{ clientId: number; routineTypeId: number; doneThrough: string }>(
        db,
        `SELECT client_id AS "clientId", routine_type_id AS "routineTypeId", done_through AS "doneThrough"
         FROM client_routine_baseline WHERE client_id = ANY ($1::bigint[]) AND routine_type_id = ANY ($2::bigint[])`,
        [clientIds, typeIds],
      )
    : [];
  const raws = clientIds.length
    ? await q<{ clientId: number; routineTypeId: number; raw: string }>(
        db,
        `SELECT client_id AS "clientId", routine_type_id AS "routineTypeId", raw
         FROM client_routine_raw WHERE client_id = ANY ($1::bigint[]) AND routine_type_id = ANY ($2::bigint[])`,
        [clientIds, typeIds],
      )
    : [];
  const key = (c: number, r: number) => `${c}:${r}`;
  const aggMap = new Map(aggs.map((a) => [key(a.clientId, a.routineTypeId), a]));
  const baseMap = new Map(baselines.map((b) => [key(b.clientId, b.routineTypeId), b.doneThrough]));
  const rawMap = new Map(raws.map((x) => [key(x.clientId, x.routineTypeId), x.raw]));
  const now = currentPeriod();
  return (clientId: number, col: WorkColumn): WorkCell => ({
    ...computeCell(col, aggMap.get(key(clientId, col.routineTypeId)), baseMap.get(key(clientId, col.routineTypeId)) ?? null, now),
    raw: rawMap.get(key(clientId, col.routineTypeId)) ?? null,
  });
}

export function computeCell(col: WorkColumn, agg: Agg | undefined, baseline: string | null, now: string): WorkCell {
  if (!agg && !baseline) return { na: true, doneThrough: null, baseline: null, lag: 0, tone: null, next: null };
  const off = workOffset(col);
  const workMonth = (period: string) => addMonths(period, -off);
  // O'tgan oy ishi muddati o'tgan hisoblanadi (doimiy ish muddati oy oxiri)
  const dueLimit = addMonths(now, -1);
  // Tizimgacha bo'shliq: boshlang'ich nuqtadan keyin, birinchi vazifagacha bo'lgan oylar
  const gapEnd = agg ? addMonths(workMonth(agg.firstPeriod), -1) : dueLimit;
  const inGap = !!baseline && addMonths(baseline, 1) <= gapEnd;
  const gap = inGap ? monthsAfter(baseline!, gapEnd < dueLimit ? gapEnd : dueLimit) : 0;

  let doneThrough: string | null;
  let next: WorkCell['next'] = null;
  if (inGap) {
    doneThrough = baseline;
    next = { kind: 'BASELINE', month: monthOfPeriod(addMonths(baseline!, 1)) };
  } else {
    doneThrough = agg?.lastDonePeriod ? workMonth(agg.lastDonePeriod) : baseline;
    if (agg?.nextTaskId && agg.nextPeriod) {
      next = { kind: 'TASK', taskId: agg.nextTaskId, status: agg.nextStatus!, month: monthOfPeriod(workMonth(agg.nextPeriod)) };
    }
  }
  const lag = Math.max(0, gap) + (agg?.overdue ?? 0);
  // Ranglar 6.5 tartibida: mijozdan kutilmoqda > muddati o'tgan > 24 soatdan kam > bajarildi
  const tone: WorkTone | null =
    next?.kind === 'TASK' && next.status === 'WAITING_CLIENT'
      ? 'waiting'
      : lag > 0
        ? 'overdue'
        : next?.kind === 'TASK' && agg?.nextDueSoon
          ? 'soon'
          : !next
            ? 'done'
            : null;
  return {
    na: false,
    doneThrough: doneThrough ? monthOfPeriod(doneThrough) : null,
    baseline: baseline ? monthOfPeriod(baseline) : null,
    lag,
    tone,
    next,
  };
}

export async function loadWorks(db: Db, u: AuthUser, f: z.infer<typeof clientListQuery>) {
  const columns = await loadColumns(db);
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const w = clientListWhere(u, f, p);
  const total = (await one<{ n: number }>(db, `SELECT count(*) AS n FROM client c ${w}`, params))!.n;
  const clients = await q(
    db,
    `SELECT ${CLIENT} ${FROM} ${w} ORDER BY c.name_normalized LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`,
    params,
  );
  const cell = await loadCells(
    db,
    clients.map((c) => c.id),
    columns,
  );
  const pct = await sharePercent(db);
  // Ustunlar "Бухгалтер ишлари" fayli tartibida; oylik to'lov faqat rahbarga (presentClient)
  const items = clients.map((raw) => {
    const c = presentClient(raw, u, pct);
    return {
      clientId: c.id,
      stir: c.stir,
      name: c.name,
      taxType: c.taxType,
      taxTypeRaw: c.taxTypeRaw,
      status: c.status,
      note: c.note,
      accountantId: c.accountantId,
      accountantName: c.accountantName,
      monthlyFee: c.monthlyFee,
      accountantShare: c.accountantShare,
      bankKey: c.bankKey,
      employeeCount: c.employeeCount,
      mehnatCheckedAt: c.mehnatCheckedAt,
      mehnatLogin: c.mehnatLogin,
      hasMehnatPassword: c.hasMehnatPassword,
      cells: Object.fromEntries(columns.map((col) => [col.routineTypeId, cell(c.id, col)])),
    };
  });
  return { columns, items, total, page: f.page, pageSize: f.pageSize, month: monthOfPeriod(currentPeriod()), sharePercent: pct };
}

const intId = z.coerce.number().int().positive();
const pairParams = z.object({ clientId: intId, routineTypeId: intId });

export const worksRouter = Router();
worksRouter.use(requireAuth);

worksRouter.get('/', async (req, res) => {
  res.json(await loadWorks(pool, me(req), parse(clientListQuery, req.query)));
});

/**
 * Katakni bosish = keyingi oyni yopish. Tizimdagi oy bo'lsa vazifa "Bajarildi" (6.6 oqimi: audit, rahbarga
 * kechiktirilgan xabar, 5 soniyalik undo). Tizimgacha bo'lgan oy bo'lsa boshlang'ich nuqta bir oy suriladi.
 * TODO(tasdiqlash): tizimgacha bo'lgan oylarni mijozning buxgalteri ham yopa oladi deb olindi.
 */
worksRouter.post('/:clientId/:routineTypeId/advance', async (req, res) => {
  const u = me(req);
  const { clientId, routineTypeId } = parse(pairParams, req.params);
  const result = await tx(async (db) => {
    // Mijoz qatori qulflanadi: bir katakni ketma-ket tez bosish ikki marta bir oyni yopmasin
    const client = await loadClientForUser(db, clientId, u, true);
    const col = await loadColumn(db, routineTypeId);
    const cell = (await loadCells(db, [clientId], [col]))(clientId, col);
    if (!cell.next) throw new AppError(409, 'NOTHING_TO_ADVANCE', "Bu ish bo'yicha yopiladigan oy yo'q");
    // Oy yopildi: fayldagi tanilmagan matn endi kerak emas
    if (cell.raw) await db.query('DELETE FROM client_routine_raw WHERE client_id = $1 AND routine_type_id = $2', [clientId, routineTypeId]);
    if (cell.next.kind === 'TASK') {
      return { kind: 'TASK' as const, task: await markDone(db, cell.next.taskId, u, { source: 'WORKS' }) };
    }
    await db.query(
      `UPDATE client_routine_baseline SET prev_done_through = done_through, done_through = $3, updated_by = $4
       WHERE client_id = $1 AND routine_type_id = $2`,
      [clientId, routineTypeId, `${cell.next.month}-01`, u.id],
    );
    await audit(db, {
      actorId: u.id,
      entity: 'client_routine_baseline',
      entityId: `${clientId}:${routineTypeId}`,
      clientId,
      action: 'ADVANCE',
      before: { doneThrough: cell.baseline },
      after: { doneThrough: cell.next.month, work: col.name },
    });
    return { kind: 'BASELINE' as const, month: cell.next.month, workName: col.name, workNameRu: col.nameRu, clientName: client.name };
  });
  res.json(result);
});

/** Tizimgacha bo'lgan oyni yopishni 5 soniya ichida bekor qilish (vazifa uchun /tasks/:id/undo-done) */
worksRouter.post('/:clientId/:routineTypeId/undo-advance', async (req, res) => {
  const u = me(req);
  const { clientId, routineTypeId } = parse(pairParams, req.params);
  await tx(async (db) => {
    await loadClientForUser(db, clientId, u, true);
    const b = await one<{ doneThrough: string; prev: string | null; updatedBy: number | null; expired: boolean }>(
      db,
      `SELECT done_through AS "doneThrough", prev_done_through AS prev, updated_by AS "updatedBy",
              now() - updated_at > make_interval(secs => $3) AS expired
       FROM client_routine_baseline WHERE client_id = $1 AND routine_type_id = $2`,
      [clientId, routineTypeId, config.undoWindowSec],
    );
    if (!b?.prev) throw new AppError(409, 'NOT_UNDOABLE', "Bekor qiladigan amal yo'q");
    if (!isLeader(u) && b.updatedBy !== u.id) throw forbidden();
    if (b.expired) throw new AppError(409, 'UNDO_EXPIRED', "Bekor qilish vaqti (5 soniya) o'tib ketdi");
    await db.query(
      `UPDATE client_routine_baseline SET done_through = prev_done_through, prev_done_through = NULL, updated_by = $3
       WHERE client_id = $1 AND routine_type_id = $2`,
      [clientId, routineTypeId, u.id],
    );
    await audit(db, {
      actorId: u.id,
      entity: 'client_routine_baseline',
      entityId: `${clientId}:${routineTypeId}`,
      clientId,
      action: 'UNDO_ADVANCE',
      before: { doneThrough: monthOfPeriod(b.doneThrough) },
      after: { doneThrough: monthOfPeriod(b.prev) },
    });
  });
  res.json({ ok: true });
});

/**
 * Rahbar tizimgacha bo'lgan nuqtani kiritadi ("Бухгалтер ишлари" faylidagi sana). Tizimda vazifasi bor
 * oylar bu yerdan yopilmaydi: ular "Bajarildi" orqali (audit, bildirishnoma) — aks holda ikki manba bo'lardi.
 */
worksRouter.put('/:clientId/:routineTypeId/baseline', requireLeader, async (req, res) => {
  const u = me(req);
  const { clientId, routineTypeId } = parse(pairParams, req.params);
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Oy formati YYYY-MM').nullable() }), req.body);
  const cell = await tx(async (db) => {
    await loadClientForUser(db, clientId, u, true);
    const col = await loadColumn(db, routineTypeId);
    const before = await one<{ doneThrough: string }>(
      db,
      `SELECT done_through AS "doneThrough" FROM client_routine_baseline WHERE client_id = $1 AND routine_type_id = $2`,
      [clientId, routineTypeId],
    );
    if (month === null) {
      await db.query('DELETE FROM client_routine_baseline WHERE client_id = $1 AND routine_type_id = $2', [clientId, routineTypeId]);
    } else {
      const period = `${month}-01`;
      if (period > addMonths(currentPeriod(), -1)) {
        throw new AppError(400, 'BASELINE_FUTURE', "Faqat o'tgan oylarni kiritish mumkin");
      }
      const first = await one<{ p: string | null }>(
        db,
        `SELECT min(period) AS p FROM task
         WHERE client_id = $1 AND status <> 'CANCELLED'
           AND ((kind = 'ROUTINE' AND routine_type_id = $2) OR (kind = 'REPORT' AND report_type_id = $3))`,
        [clientId, routineTypeId, col.reportTypeId],
      );
      const firstWork = first?.p ? addMonths(first.p, -workOffset(col)) : null;
      if (firstWork && period >= firstWork) {
        throw new AppError(
          409,
          'BASELINE_IN_SYSTEM',
          `${monthOfPeriod(firstWork)} dan boshlab oylar tizimda vazifa sifatida bor: ularni "Bajarildi" qiling`,
          { firstMonth: monthOfPeriod(firstWork) },
        );
      }
      await db.query(
        `INSERT INTO client_routine_baseline (client_id, routine_type_id, done_through, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id, routine_type_id)
         DO UPDATE SET done_through = EXCLUDED.done_through, prev_done_through = NULL, updated_by = EXCLUDED.updated_by`,
        [clientId, routineTypeId, period, u.id],
      );
    }
    // Rahbar oyni aniqladi (yoki bo'shatdi): fayldagi tanilmagan matn o'rnini egalladi
    await db.query('DELETE FROM client_routine_raw WHERE client_id = $1 AND routine_type_id = $2', [clientId, routineTypeId]);
    if ((before?.doneThrough ?? null) !== (month ? `${month}-01` : null)) {
      await audit(db, {
        actorId: u.id,
        entity: 'client_routine_baseline',
        entityId: `${clientId}:${routineTypeId}`,
        clientId,
        action: 'SET_BASELINE',
        before: { doneThrough: before ? monthOfPeriod(before.doneThrough) : null },
        after: { doneThrough: month, work: col.name },
      });
    }
    return (await loadCells(db, [clientId], [col]))(clientId, col);
  });
  res.json(cell);
});
