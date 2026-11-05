import ExcelJS from 'exceljs';
import { Router } from 'express';
import { z } from 'zod';
import { type AuthUser, me, requireAuth, requireLeader } from '../common/auth';
import { audit } from '../common/audit';
import { AppError, notFound, parse } from '../common/errors';
import { normalizeName } from '../common/normalize';
import { addMonthsIso, currentPeriod, monthOf, periodFromMonth } from '../common/time';
import { type Db, one, pool, q, tx } from '../db';
import { CLIENT_STATUSES } from './clients';
import { getDueTime } from './generator';
import { cancelPendingForTask } from './notifications';
import { type MarkDoneOptions, markDone, reopenDue, stopTimersForTask } from './taskService';

export type CellState = '1' | '0' | '!' | 'X';

const REOPEN_DUE = reopenDue('');
const REOPEN_DUE_T = reopenDue('t.');

export async function loadGrid(
  db: Db,
  period: string,
  f: { accountantId?: number; taxType?: string; status?: string; search?: string; clientIds?: number[] },
) {
  const dueTime = await getDueTime(db);
  // Barcha faol hisobotlar har oy ustun (V11); choraklik/yillik muddati o'z generatsiya davridan
  const columns = await q(
    db,
    `SELECT rt.id AS "reportTypeId", rt.code, rt.name, rt.name_ru AS "nameRu", rt.due_day AS "dueDay",
            rt.creates_accountant_task AS "createsAccountantTask",
            to_char(fn_report_due_at(g.source_period, rt.due_day, $2, rt.due_month_offset) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS "dueDate"
     FROM fn_grid_columns($1) g
     JOIN report_type rt ON rt.id = g.report_type_id
     WHERE g.source_period IS NOT NULL
     ORDER BY rt.sort_order, rt.id`,
    [period, dueTime],
  );
  // Faqat Hisobot topshirish bo'limidagi mijozlar (V25: «Бухгалтер ишлари» faylidan yuklanganlar bu yerda ko'rinmaydi)
  const where: string[] = ['c.in_reports'];
  const params: unknown[] = [period];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (f.accountantId) where.push(`c.accountant_id = ${p(f.accountantId)}`);
  // Jadval Excel faylidagidek: yuklangan har bir korxona ko'rinadi, Arxiv ham (holati katakda; rahbar qarori)
  if (f.status) where.push(`c.status = ${p(f.status)}`);
  if (f.search) where.push(`(c.name_normalized ILIKE ${p(`%${normalizeName(f.search)}%`)} OR c.stir LIKE ${p(`${f.search.replace(/\D/g, '') || '#'}%`)})`);
  if (f.clientIds) where.push(`c.id = ANY (${p(f.clientIds)}::bigint[])`);
  const cells = await q(
    db,
    `SELECT g.client_id AS "clientId", g.report_type_id AS "reportTypeId", g.tax_type AS "taxType",
            g.task_id AS "taskId", g.task_status AS "taskStatus", g.cell AS state,
            c.stir, c.stir_raw AS "stirRaw", c.name, c.status, c.note, c.tax_type_raw AS "taxTypeRaw", c.accountant_id AS "accountantId", a.full_name AS "accountantName"
     FROM fn_monthly_grid($1) g
     JOIN client c ON c.id = g.client_id
     LEFT JOIN app_user a ON a.id = c.accountant_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.name_normalized, g.report_type_id`,
    params,
  );
  const rows = new Map<number, any>();
  for (const c of cells) {
    // Soliq turi filtri davrdagi tur bo'yicha (tarixdan); NONE = aniqlanmagan
    if (f.taxType && (c.taxType ?? 'NONE') !== f.taxType) continue;
    let r = rows.get(c.clientId);
    if (!r) {
      r = {
        clientId: c.clientId,
        stir: c.stir,
        stirRaw: c.stir ? null : c.stirRaw,
        name: c.name,
        taxType: c.taxType,
        taxTypeRaw: c.taxType ? null : c.taxTypeRaw,
        status: c.status,
        note: c.note,
        accountantId: c.accountantId,
        accountantName: c.accountantName,
        cells: {} as Record<number, { state: CellState; taskId: number | null; taskStatus: string | null; noEvent?: boolean; markable?: boolean; raw?: string }>,
      };
      rows.set(c.clientId, r);
    }
    r.cells[c.reportTypeId] = { state: c.state, taskId: c.taskId, taskStatus: c.taskStatus };
  }

  // Fayldagi qiymat (client_report_raw) boricha: soliq turi aniqlanmagan mijozda hamma katak (V24, vazifa yo'q),
  // turi ma'lum mijozda — 1/0/X deb tanib bo'lmagan matn (rahbar 1/0/X tanlaguncha)
  const pendingIds = [...rows.keys()];
  if (pendingIds.length) {
    const raws = await q<{ clientId: number; reportTypeId: number; raw: string }>(
      db,
      `SELECT client_id AS "clientId", report_type_id AS "reportTypeId", raw FROM client_report_raw
       WHERE period = $1 AND client_id = ANY ($2::bigint[])`,
      [period, pendingIds],
    );
    for (const x of raws) {
      const cell = rows.get(x.clientId)?.cells[x.reportTypeId];
      if (cell) cell.raw = x.raw;
    }
  }

  // Qat'iy "—" faqat soliq turi / tugatilmoqda / mijoz istisnosi sabab. Holat bo'yicha hisobot (Dividend, Norezident)
  // holati belgilanmagan bo'lsa (NO_EVENT) — topshirilishi mumkin, katakda "0"; bosilsa belgi qo'yiladi (markable).
  // Holat belgisi o'z oyi katagida (V36: holat oyi = hisobot oyi, muddat keyingi oyda); server faqat joriy va o'tgan
  // holat oyini qabul qiladi (clients.ts).
  const eventMonth = monthOf(period);
  const cur = currentPeriod();
  const eventEditable = eventMonth === monthOf(cur) || eventMonth === monthOf(addMonthsIso(cur, -1));
  if (rows.size) {
    const ev = await q<{ clientId: number; reportTypeId: number }>(
      db,
      `SELECT client_id AS "clientId", report_type_id AS "reportTypeId"
       FROM fn_report_applicability($1) WHERE reason = 'NO_EVENT' AND client_id = ANY ($2::bigint[])`,
      [period, [...rows.keys()]],
    );
    for (const e of ev) {
      const cell = rows.get(e.clientId)?.cells[e.reportTypeId];
      if (!cell || cell.state !== 'X' || cell.raw !== undefined) continue;
      cell.state = '0';
      cell.noEvent = true;
      if (eventEditable) cell.markable = true;
    }
  }
  return { period: period.slice(0, 7), eventMonth: eventEditable ? eventMonth : null, columns, rows: [...rows.values()] };
}

export const gridRouter = Router();
gridRouter.use(requireAuth);

gridRouter.get('/', async (req, res) => {
  const f = parse(
    z.object({
      month: z.string().optional(),
      accountantId: z.coerce.number().int().optional(),
      taxType: z.enum(['AOS', 'QQS', 'YATT', 'NONE']).optional(),
      status: z.enum(CLIENT_STATUSES).optional(),
      search: z.string().trim().optional(),
    }),
    req.query,
  );
  // Hisobot topshirish buxgalterga biriktirilmaydi (rahbar qarori): hamma korxona hammaga ko'rinadi,
  // buxgalter faqat ko'radi — o'zgartirish yo'llari serverda yopiq (cell/done requireLeader)
  res.json(await loadGrid(pool, periodFromMonth(f.month), f));
});

// Ekrandagi sarlavhalar bilan bir xil qisqa nomlar va muddat sanasi ko'rsatilmaydigan ustunlar (Monthly.tsx)
const SHORT: Record<string, { uz: string; ru: string }> = {
  TOLOV_MANBAI: { uz: "To'lov manbai", ru: 'У источника' },
  PORUCHENYA_JSHDS: { uz: 'Poruchenya JSHDS', ru: 'Поручение НДФЛ' },
  FOYDA: { uz: 'FOYDA', ru: 'Прибыль' },
};
const NO_DUE_DATE = new Set(['INPS', 'PORUCHENYA_JSHDS', 'DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS']);
const HEAD = {
  uz: { no: '№', stir: 'STIR', company: 'Korxona nomi', taxType: 'Soliq turi', note: "Qilinishi lozim bo'lgan ishlar" },
  ru: { no: '№', stir: 'ИНН', company: 'Название предприятия', taxType: 'Налоговый режим', note: 'Что необходимо сделать' },
};
const FILL = { done: 'FFDCFCE7', overdue: 'FFFEE2E2', na: 'FFF3F4F6', head: 'FF37A0AD' };

// Excel: butun jadval (filtrsiz), buxgalterga ham hammasi. Katak qiymati import formatidagidek 1/0/X;
// muddati o'tgan katak "0" bo'lib qoladi, faqat qizil fon bilan ajraladi (rahbar qarori).
gridRouter.get('/export.xlsx', async (req, res) => {
  const u = me(req);
  const { month } = parse(z.object({ month: z.string().optional() }), req.query);
  const g = await loadGrid(pool, periodFromMonth(month), {});
  const lang = u.language === 'ru' ? 'ru' : 'uz';
  const h = HEAD[lang];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(g.period, { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });
  ws.columns = [
    { header: h.no, width: 5 },
    { header: h.stir, width: 12 },
    { header: h.company, width: 40 },
    { header: h.taxType, width: 10 },
    ...g.columns.map((c: any) => {
      const name = SHORT[c.code]?.[lang] ?? (lang === 'ru' ? c.nameRu : c.name);
      const due = !NO_DUE_DATE.has(c.code) && c.dueDate ? ' ' + c.dueDate.split('-').reverse().join('.') : '';
      return { header: name + due, width: 14 };
    }),
    { header: h.note, width: 50 },
  ];
  const head = ws.getRow(1);
  head.height = 32;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.head } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  g.rows.forEach((r: any, i: number) => {
    const row = ws.addRow([
      i + 1,
      r.stir ?? r.stirRaw ?? '',
      r.name,
      (r.taxType === 'YATT' ? 'YaTT' : r.taxType) ?? r.taxTypeRaw ?? '',
      ...g.columns.map((c: any) => {
        // Soliq turi aniqlanmagan: fayldagi qiymat boricha (qayta yuklansa o'sha natija)
        if (!r.taxType || r.cells[c.reportTypeId]?.raw !== undefined) return r.cells[c.reportTypeId]?.raw ?? '';
        const st = r.cells[c.reportTypeId]?.state as CellState | undefined;
        // Import formati: holat ustunida X = holat yo'q (0 qayta yuklansa belgi qo'yib yuboradi)
        if (r.cells[c.reportTypeId]?.noEvent) return 'X';
        return st === '!' ? '0' : (st ?? '');
      }),
      r.note ?? '',
    ]);
    g.columns.forEach((c: any, j: number) => {
      const st = (!r.taxType || r.cells[c.reportTypeId]?.raw !== undefined ? undefined : r.cells[c.reportTypeId]?.noEvent ? 'X' : r.cells[c.reportTypeId]?.state) as CellState | undefined;
      const cell = row.getCell(5 + j);
      cell.alignment = { horizontal: 'center' };
      const fill = st === '1' ? FILL.done : st === '!' ? FILL.overdue : st === 'X' ? FILL.na : null;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(4).alignment = { horizontal: 'center' };
    row.getCell(5 + g.columns.length).alignment = { wrapText: true, vertical: 'top' };
  });
  ws.eachRow((row) =>
    row.eachCell({ includeEmpty: true }, (cell) => {
      const thin = { style: 'thin' as const, color: { argb: 'FFD1D5DB' } };
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
    }),
  );

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="hisobot-${g.period}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Katakchani bosish = "Bajarildi" (B4 mexanizmi, 5 soniyalik undo bilan). Faqat rahbar: buxgalter
// Hisobot topshirish sahifasini faqat ko'radi (rahbar qarori), o'z vazifasini "Mening kunim"da yopadi.
gridRouter.post('/cell/:taskId/done', requireLeader, async (req, res) => {
  const taskId = parse(z.coerce.number().int().positive(), req.params.taskId);
  res.json(await tx((db) => markDone(db, taskId, me(req), { source: 'GRID' })));
});

/**
 * Excel kabi katak (rahbar qarori): istalgan katakka 1 / 0 / X, soliq turi qoidasi to'smaydi.
 * Tanlov client_report_cell'ga yoziladi (V30, keyingi oylarga ham o'tadi), vazifa shunga moslanadi:
 *   1 — vazifa (yo'q bo'lsa yaratiladi) "Bajarildi" (6.6: rahbarlarga xabar, 5 soniyalik undo)
 *   0 — vazifa ochiq (bajarilgan bo'lsa qayta ochiladi)
 *   X — vazifa bekor qilinadi (o'chirilmaydi, audit'da), bajarilgani ham
 * Keyingi oylar (joriy oygacha) yangi tanlovga moslanadi: ochiq vazifa bekor / yangisi yaratiladi, DONE tegilmaydi.
 * Excel importi ham shu yo'l bilan (u = null, xabarsiz): fayldagi qiymat jadvalda boricha ko'rinsin.
 */
export async function setGridCell(
  db: Db,
  u: AuthUser | null,
  c: { clientId: number; reportTypeId: number; month: string; value: '1' | '0' | 'X' },
  opts: Pick<MarkDoneOptions, 'source' | 'notify'> = {},
) {
  const actorId = u?.id ?? null;
  const source = opts.source ?? 'GRID';
  // Ustunning vazifa davri: oylik = ko'rilayotgan oy, choraklik/yillik = oxirgi generatsiya oyi
  const col = await one<{ sourcePeriod: string | null; code: string }>(
    db,
    `SELECT to_char(g.source_period, 'YYYY-MM-DD') AS "sourcePeriod", rt.code
     FROM fn_grid_columns($1) g JOIN report_type rt ON rt.id = g.report_type_id WHERE g.report_type_id = $2`,
    [periodFromMonth(c.month), c.reportTypeId],
  );
  if (!col?.sourcePeriod) throw notFound('Hisobot');
  const client = await one<{ taxType: string | null }>(
    db,
    'SELECT tax_type AS "taxType" FROM client WHERE id = $1 AND in_reports FOR UPDATE',
    [c.clientId],
  );
  if (!client) throw notFound('Mijoz');
  // Tur aniqlanmagan mijozda katakda fayldagi qiymat turadi (V24): avval soliq turi tanlanadi
  if (!client.taxType) throw new AppError(409, 'NO_TAX_TYPE', 'Avval soliq turini tanlang');
  const period = col.sourcePeriod;
  // Katakda turgan tanilmagan fayl matni endi tanlov bilan almashadi
  await db.query('DELETE FROM client_report_raw WHERE client_id = $1 AND report_type_id = $2 AND period = $3', [c.clientId, c.reportTypeId, periodFromMonth(c.month)]);
  const before = await one<{ applicable: boolean }>(
    db,
    'SELECT applicable FROM client_report_cell WHERE client_id = $1 AND report_type_id = $2 AND period = $3',
    [c.clientId, c.reportTypeId, period],
  );
  await db.query(
    `INSERT INTO client_report_cell (client_id, report_type_id, period, applicable, set_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_id, report_type_id, period) DO UPDATE SET applicable = EXCLUDED.applicable, set_by = EXCLUDED.set_by, set_at = now()`,
    [c.clientId, c.reportTypeId, period, c.value !== 'X', actorId],
  );
  await audit(db, {
    actorId,
    entity: 'client',
    entityId: c.clientId,
    clientId: c.clientId,
    action: 'REPORT_CELL',
    before: before ? { report: col.code, applicable: before.applicable } : null,
    after: { report: col.code, month: period.slice(0, 7), value: c.value, ...(source !== 'GRID' ? { source } : {}) },
  });

  const cur = currentPeriod();
  for (let p = period; p <= cur || p === period; p = addMonthsIso(p, 1)) {
    await syncReportTask(db, c.clientId, c.reportTypeId, p, actorId);
  }

  let task = await one<{ id: number; status: string }>(
    db,
    `SELECT id, status FROM task WHERE client_id = $1 AND kind = 'REPORT' AND report_type_id = $2 AND period = $3`,
    [c.clientId, c.reportTypeId, period],
  );
  if (c.value === 'X' && task?.status === 'DONE') {
    // Qo'lda X bajarilganini ham bekor qiladi (Exceldagidek: katakdagi qiymat almashadi)
    await cancelTask(db, task.id, c.clientId, 'MANUAL_X', actorId);
    task = undefined;
  }
  if (c.value === '0' && task?.status === 'DONE') await reopenDone(db, task.id, c.clientId, actorId, source);
  else if (c.value === '0' && task && task.status !== 'CANCELLED') await resetOpenDue(db, task.id, c.clientId, actorId, source);
  if (c.value === '1' && task && task.status !== 'DONE') {
    return { task: await markDone(db, task.id, u, { source, notify: opts.notify }) };
  }
  return { task: null };
}

/** Bitta (mijoz, hisobot, davr) vazifasini qo'llanishga moslash. Doimiy ishlarga tegmaydi (o'tgan oyga ish yaratmaslik uchun) */
async function syncReportTask(db: Db, clientId: number, reportTypeId: number, period: string, actorId: number | null) {
  const a = await one<{ applicable: boolean }>(
    db,
    'SELECT applicable FROM fn_report_applicability($1) WHERE client_id = $2 AND report_type_id = $3',
    [period, clientId, reportTypeId],
  );
  if (!a) return; // bu oy bu hisobot davri emas (choraklik/yillik)
  const t = await one<{ id: number; status: string }>(
    db,
    `SELECT id, status FROM task WHERE client_id = $1 AND kind = 'REPORT' AND report_type_id = $2 AND period = $3`,
    [clientId, reportTypeId, period],
  );
  if (!a.applicable) {
    if (t && ['TODO', 'IN_PROGRESS', 'WAITING_CLIENT'].includes(t.status)) await cancelTask(db, t.id, clientId, 'MANUAL_X', actorId);
    return;
  }
  if (t?.status === 'CANCELLED') {
    await db.query(
      `UPDATE task t SET status = 'TODO', prev_status = NULL, cancel_reason = NULL,
              assignee_id = CASE WHEN rt.creates_accountant_task THEN c.accountant_id END, ${REOPEN_DUE_T}
       FROM report_type rt, client c WHERE t.id = $1 AND rt.id = t.report_type_id AND c.id = t.client_id`,
      [t.id, await getDueTime(db)],
    );
    await audit(db, { actorId, entity: 'task', entityId: t.id, clientId, action: 'REOPEN_RECONCILE', after: { source: 'GRID' } });
  } else if (!t) {
    const dueTime = await getDueTime(db);
    const created = await one<{ id: number; title: string }>(
      db,
      `INSERT INTO task (client_id, kind, report_type_id, period, title, assignee_id, due_at, status, overdue_notified_at)
       SELECT c.id, 'REPORT', rt.id, $3, rt.name, CASE WHEN rt.creates_accountant_task THEN c.accountant_id END,
              fn_report_due_at($3, rt.due_day, $4, rt.due_month_offset), 'TODO',
              -- muddati allaqachon o'tgan bo'lsa "muddat o'tdi" xabari yuborilmaydi (generator bilan bir xil)
              CASE WHEN fn_report_due_at($3, rt.due_day, $4, rt.due_month_offset) < now() THEN now() END
       FROM client c, report_type rt WHERE c.id = $1 AND rt.id = $2
       RETURNING id, title`,
      [clientId, reportTypeId, period, dueTime],
    );
    await audit(db, { actorId, entity: 'task', entityId: created!.id, clientId, action: 'CREATE_RECONCILE', after: { kind: 'REPORT', title: created!.title, source: 'GRID' } });
  }
}

/** Katakda 1 -> 0: bajarilgan vazifa qayta ochiladi, rahbarga ketmagan "bajarildi" xabari bekor */
export async function reopenDone(db: Db, taskId: number, clientId: number, actorId: number | null, source: string) {
  // Muddat joriy qoidadan qayta hisoblanadi (V37): eski muddat bilan darhol "!" bo'lib qolmasin
  await db.query(
    `UPDATE task SET status = 'TODO', done_at = NULL, done_by = NULL, prev_status = NULL, ${REOPEN_DUE} WHERE id = $1`,
    [taskId, await getDueTime(db)],
  );
  await cancelPendingForTask(db, taskId, 'TASK_DONE');
  await audit(db, { actorId, entity: 'task', entityId: taskId, clientId, action: 'REOPEN', before: { status: 'DONE' }, after: { status: 'TODO', source } });
}

/**
 * Ochiq vazifa katagida 0: muddat qoidadan farq qilsa qoidaga qaytadi (V39). Eski muddat bilan qayta ochilgan
 * vazifa (V37 dan oldin) "!" bo'lib qolmasin — rahbar 0 tanlasa "○" bo'ladi (muddati haqiqatan o'tgan bo'lsa "!" qoladi).
 */
export async function resetOpenDue(db: Db, taskId: number, clientId: number, actorId: number | null, source: string) {
  const r = await one<{ old: Date | null; due: Date | null }>(
    db,
    `UPDATE task t SET ${reopenDue('t.')}
     FROM task o WHERE t.id = $1 AND o.id = t.id AND t.due_at IS DISTINCT FROM fn_task_rule_due_at(t.id, $2)
     RETURNING o.due_at AS old, t.due_at AS due`,
    [taskId, await getDueTime(db)],
  );
  if (r) await audit(db, { actorId, entity: 'task', entityId: taskId, clientId, action: 'RETIME', before: { dueAt: r.old }, after: { dueAt: r.due, source } });
}

export async function cancelTask(db: Db, taskId: number, clientId: number, reason: string, actorId: number | null) {
  const t = await one<{ status: string; title: string }>(db, 'SELECT status, title FROM task WHERE id = $1', [taskId]);
  await stopTimersForTask(db, taskId);
  // Bajarilgani ham (done_at faqat DONE holatda); oldingi holat audit'da qoladi
  await db.query(
    `UPDATE task SET prev_status = status, status = 'CANCELLED', cancel_reason = $2, done_at = NULL, done_by = NULL WHERE id = $1`,
    [taskId, reason],
  );
  await cancelPendingForTask(db, taskId, 'TASK_DONE');
  await audit(db, { actorId, entity: 'task', entityId: taskId, clientId, action: 'CANCEL_MANUAL_X', before: { status: t!.status }, after: { status: 'CANCELLED', title: t!.title } });
}

gridRouter.put('/cell', requireLeader, async (req, res) => {
  const body = parse(
    z.object({
      clientId: z.number().int().positive(),
      reportTypeId: z.number().int().positive(),
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Oy formati YYYY-MM'),
      value: z.enum(['1', '0', 'X']),
    }),
    req.body,
  );
  res.json(await tx((db) => setGridCell(db, me(req), body)));
});

/**
 * Shartnoma tugadi: mijoz Hisobot topshirish va Buxgalter ishlari jadvallaridan olib tashlanadi (faqat rahbar).
 * Qaror: mijoz o'chirilmaydi — in_reports = in_works = false (V25). Ma'lumot, tarix va audit qoladi; keyingi Excel
 * faylida yoki "Yangi mijoz"da shu STIR kelsa o'sha bo'limga qaytadi.
 * Ochiq vazifalari (barcha oylar, barcha turlar) bekor qilinadi, bajarilganlari tegilmaydi.
 * TODO(tasdiqlash): jadvallarning o'tgan oylarida ham ko'rinmaydi (bo'lim belgisi davrga bog'liq emas).
 */
gridRouter.delete('/clients/:clientId', requireLeader, async (req, res) => {
  const clientId = parse(z.coerce.number().int().positive(), req.params.clientId);
  const actorId = me(req).id;
  res.json(
    await tx(async (db) => {
      const client = await one<{ inWorks: boolean }>(db, 'SELECT in_works AS "inWorks" FROM client WHERE id = $1 AND in_reports FOR UPDATE', [clientId]);
      if (!client) throw notFound('Mijoz');
      await db.query('UPDATE client SET in_reports = false, in_works = false WHERE id = $1', [clientId]);
      await audit(db, {
        actorId, entity: 'client', entityId: clientId, clientId, action: 'CONTRACT_ENDED',
        before: { inReports: true, inWorks: client.inWorks }, after: { inReports: false, inWorks: false },
      });
      const cancelled = await q<{ id: number; title: string; prevStatus: string }>(
        db,
        `UPDATE task SET prev_status = status, status = 'CANCELLED', cancel_reason = 'CONTRACT_ENDED'
         WHERE client_id = $1 AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
         RETURNING id, title, prev_status AS "prevStatus"`,
        [clientId],
      );
      for (const t of cancelled) {
        await stopTimersForTask(db, t.id);
        await audit(db, {
          actorId, entity: 'task', entityId: t.id, clientId, action: 'CANCEL_CONTRACT_ENDED',
          before: { status: t.prevStatus }, after: { status: 'CANCELLED', title: t.title },
        });
      }
      return { clientId, cancelled: cancelled.length };
    }),
  );
});
