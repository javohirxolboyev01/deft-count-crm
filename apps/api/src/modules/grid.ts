import ExcelJS from 'exceljs';
import { Router } from 'express';
import { z } from 'zod';
import { isLeader, me, requireAuth } from '../common/auth';
import { parse } from '../common/errors';
import { normalizeName } from '../common/normalize';
import { addMonthsIso, currentPeriod, monthOf, periodFromMonth } from '../common/time';
import { type Db, pool, q, tx } from '../db';
import { CLIENT_STATUSES } from './clients';
import { getDueTime } from './generator';
import { markDone } from './taskService';

export type CellState = '1' | '0' | '!' | 'X';

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
            to_char(fn_due_at(g.source_period, rt.due_day, $2) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS "dueDate"
     FROM fn_grid_columns($1) g
     JOIN report_type rt ON rt.id = g.report_type_id
     WHERE g.source_period IS NOT NULL
     ORDER BY rt.sort_order, rt.id`,
    [period, dueTime],
  );
  const where: string[] = [];
  const params: unknown[] = [period];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (f.accountantId) where.push(`c.accountant_id = ${p(f.accountantId)}`);
  // Arxiv standart jadvalda ko'rinmaydi, faqat filtr bilan
  if (f.status) where.push(`c.status = ${p(f.status)}`);
  else where.push(`c.status <> 'ARCHIVED'`);
  if (f.search) where.push(`(c.name_normalized ILIKE ${p(`%${normalizeName(f.search)}%`)} OR c.stir LIKE ${p(`${f.search.replace(/\D/g, '') || '#'}%`)})`);
  if (f.clientIds) where.push(`c.id = ANY (${p(f.clientIds)}::bigint[])`);
  const cells = await q(
    db,
    `SELECT g.client_id AS "clientId", g.report_type_id AS "reportTypeId", g.tax_type AS "taxType",
            g.task_id AS "taskId", g.task_status AS "taskStatus", g.cell AS state,
            c.stir, c.name, c.status, c.note, c.tax_type_raw AS "taxTypeRaw", c.accountant_id AS "accountantId", a.full_name AS "accountantName"
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

  // Soliq turi aniqlanmagan mijoz (V24): vazifa yo'q, katakda fayldagi qiymat (client_report_raw) boricha
  const pendingIds = [...rows.values()].filter((r) => !r.taxType).map((r) => r.clientId);
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
  // Ko'rilayotgan oy = topshirish oyi, belgi holat oyiga (bir oy oldin) yoziladi; server faqat joriy va o'tgan holat
  // oyini qabul qiladi (clients.ts).
  const eventMonth = monthOf(addMonthsIso(period, -1));
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
  const u = me(req);
  const f = parse(
    z.object({
      month: z.string().optional(),
      accountantId: z.coerce.number().int().optional(),
      taxType: z.enum(['AOS', 'QQS', 'NONE']).optional(),
      status: z.enum(CLIENT_STATUSES).optional(),
      search: z.string().trim().optional(),
    }),
    req.query,
  );
  // Buxgalter faqat o'z mijozlarini ko'radi (serverda majburiy)
  const accountantId = isLeader(u) ? f.accountantId : u.id;
  res.json(await loadGrid(pool, periodFromMonth(f.month), { ...f, accountantId }));
});

// Ekrandagi sarlavhalar bilan bir xil qisqa nomlar va muddat sanasi ko'rsatilmaydigan ustunlar (Monthly.tsx)
const SHORT: Record<string, { uz: string; ru: string }> = {
  TOLOV_MANBAI: { uz: "To'lov manbai", ru: 'У источника' },
  PORUCHENYA_JSHDS: { uz: 'Poruchenya JSHDS', ru: 'Поручение НДФЛ' },
  FOYDA: { uz: 'FOYDA', ru: 'Прибыль' },
};
const NO_DUE_DATE = new Set(['INPS', 'PORUCHENYA_JSHDS', 'DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS', 'MOLIYAVIY_NATIJA', 'BALANS', 'STATISTIKA']);
const HEAD = {
  uz: { no: '№', stir: 'STIR', company: 'Korxona nomi', taxType: 'Soliq turi', note: "Qilinishi lozim bo'lgan ishlar" },
  ru: { no: '№', stir: 'ИНН', company: 'Название предприятия', taxType: 'Налоговый режим', note: 'Что необходимо сделать' },
};
const FILL = { done: 'FFDCFCE7', overdue: 'FFFEE2E2', na: 'FFF3F4F6', head: 'FF37A0AD' };

// Excel: butun jadval (filtrsiz), buxgalterga faqat o'z mijozlari. Katak qiymati import formatidagidek 1/0/X;
// muddati o'tgan katak "0" bo'lib qoladi, faqat qizil fon bilan ajraladi (rahbar qarori).
gridRouter.get('/export.xlsx', async (req, res) => {
  const u = me(req);
  const { month } = parse(z.object({ month: z.string().optional() }), req.query);
  const g = await loadGrid(pool, periodFromMonth(month), { accountantId: isLeader(u) ? undefined : u.id });
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
      r.stir,
      r.name,
      r.taxType ?? r.taxTypeRaw ?? '',
      ...g.columns.map((c: any) => {
        // Soliq turi aniqlanmagan: fayldagi qiymat boricha (qayta yuklansa o'sha natija)
        if (!r.taxType) return r.cells[c.reportTypeId]?.raw ?? '';
        const st = r.cells[c.reportTypeId]?.state as CellState | undefined;
        // Import formati: holat ustunida X = holat yo'q (0 qayta yuklansa belgi qo'yib yuboradi)
        if (r.cells[c.reportTypeId]?.noEvent) return 'X';
        return st === '!' ? '0' : (st ?? '');
      }),
      r.note ?? '',
    ]);
    g.columns.forEach((c: any, j: number) => {
      const st = (!r.taxType ? undefined : r.cells[c.reportTypeId]?.noEvent ? 'X' : r.cells[c.reportTypeId]?.state) as CellState | undefined;
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

// Katakchani bosish = "Bajarildi" (B4 mexanizmi, 5 soniyalik undo bilan).
// creates_accountant_task=false hisobot kataklarini ham mijozning buxgalteri/rahbar belgilay oladi (TODO(tasdiqlash)).
gridRouter.post('/cell/:taskId/done', async (req, res) => {
  const taskId = parse(z.coerce.number().int().positive(), req.params.taskId);
  res.json(await tx((db) => markDone(db, taskId, me(req), { source: 'GRID' })));
});
