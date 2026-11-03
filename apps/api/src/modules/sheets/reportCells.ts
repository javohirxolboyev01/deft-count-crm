import { audit } from '../../common/audit';
import { addMonthsIso, currentPeriod } from '../../common/time';
import { type Db, q } from '../../db';
import { reconcileClient } from '../generator';
import { markDone } from '../taskService';
import { parseCell } from './parse';

// Hisobot faylidagi bitta mijoz qatorining kataklarini (1/0/X) tizimga qo'llash. Ikki joydan chaqiriladi:
//  - import paytida (soliq turi ma'lum bo'lsa);
//  - soliq turi keyin aniqlanganda (karta yoki keyingi fayl): saqlab qo'yilgan kataklar (client_report_raw).
// Shunda "fayldagi qiymat keyin o'zi to'ladi" qoidasi bitta joyda.

export interface RawReportCell {
  reportTypeId: number;
  code: string;
  raw: string;
}

/** import davridan joriy oygacha (shu ham) barcha oylar: o'tgan oy fayli joriy oy vazifalariga ham ta'sir qiladi */
export function periodsThroughNow(period: string): string[] {
  const now = currentPeriod();
  const out = [period];
  for (let p = addMonthsIso(period, 1); p <= now; p = addMonthsIso(p, 1)) out.push(p);
  return out;
}

export async function reconcileThroughNow(db: Db, clientId: number, actorId: number | null, period: string) {
  for (const p of periodsThroughNow(period)) await reconcileClient(db, clientId, actorId, p);
}

/**
 * Kataklarni qo'llaydi. Qaytaradi: nechta vazifa "Bajarildi" bo'ldi, belgilar o'zgardimi, review xabarlari.
 * Chaqiruvchi davr vazifalarini avval reconcile qilgan bo'lishi kerak.
 */
export async function applyReportCells(
  db: Db,
  ctx: { clientId: number; period: string; taxType: string; actorId: number | null },
  values: RawReportCell[],
) {
  const { clientId, period, actorId } = ctx;
  const changes: string[] = [];
  const review: string[] = [];
  let cellsDone = 0;
  const eventTypes = new Set(
    (await q<{ id: number }>(db, 'SELECT id FROM report_type WHERE requires_event_flag')).map((r) => Number(r.id)),
  );
  // Katak qiymatlari: 1 = DONE, 0 = ochiq, X = qo'llanmaydi. Soliq turiga zid qiymatlar -> review
  const loadCells = () =>
    q<any>(
      db,
      `SELECT report_type_id AS "reportTypeId", applicable, task_id AS "taskId", task_status AS "taskStatus"
       FROM fn_monthly_grid($1) WHERE client_id = $2`,
      [period, clientId],
    );
  let cells = await loadCells();

  // Rahbar qarori: soliq turi bo'yicha topshiriladigan katakda X -> mijoz bu hisobotni doimiy topshirmaydi
  // (client_report_exclusion, shu davrdan). Belgilangan hisobotda 0/1 -> belgi olinadi. Keyin davr qayta moslanadi.
  const excluded = new Set(
    (await q<{ id: number }>(db, 'SELECT report_type_id AS id FROM client_report_exclusion WHERE client_id = $1', [clientId])).map((e) => Number(e.id)),
  );
  // Holat bo'yicha hisobot (dividend, norezident; V20): katakda 0/1 = holat bo'lgan -> o'tgan oy (holat oyi) belgisi
  // qo'yiladi; X = holat yo'q -> belgi olinadi. Bunday ustundagi X doimiy "topshirmaydi" belgisi emas.
  const eventMonth = addMonthsIso(period, -1).slice(0, 7);
  const events = new Set(
    (await q<{ id: number }>(db, 'SELECT report_type_id AS id FROM client_report_event WHERE client_id = $1 AND month = $2', [clientId, eventMonth])).map((e) => Number(e.id)),
  );
  let marksChanged = false;
  for (const col of values) {
    const v = parseCell(col.raw);
    const cell = cells.find((c) => c.reportTypeId === col.reportTypeId);
    if (!cell || v === null || v === '') continue;
    if (eventTypes.has(col.reportTypeId)) {
      if (v !== 'X' && !events.has(col.reportTypeId)) {
        await db.query(
          `INSERT INTO client_report_event (client_id, report_type_id, month, marked_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [clientId, col.reportTypeId, eventMonth, actorId],
        );
        await audit(db, { actorId, entity: 'client', entityId: clientId, clientId, action: 'EVENT_MARK', after: { report: col.code, month: eventMonth, source: 'IMPORT' } });
        changes.push(`${col.code}:${eventMonth}`);
        marksChanged = true;
      } else if (v === 'X' && events.has(col.reportTypeId)) {
        await db.query('DELETE FROM client_report_event WHERE client_id = $1 AND report_type_id = $2 AND month = $3', [clientId, col.reportTypeId, eventMonth]);
        await audit(db, { actorId, entity: 'client', entityId: clientId, clientId, action: 'EVENT_UNMARK', before: { report: col.code, month: eventMonth }, after: { source: 'IMPORT' } });
        changes.push(`${col.code}:X`);
        marksChanged = true;
      }
      continue;
    }
    if (v === 'X' && cell.applicable) {
      await db.query(
        `INSERT INTO client_report_exclusion (client_id, report_type_id, effective_from, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id, report_type_id) DO UPDATE SET effective_from = least(client_report_exclusion.effective_from, EXCLUDED.effective_from)`,
        [clientId, col.reportTypeId, period, actorId],
      );
      await audit(db, { actorId, entity: 'client', entityId: clientId, clientId, action: 'REPORT_EXCLUDE', after: { report: col.code, from: period.slice(0, 7), source: 'IMPORT' } });
      changes.push(`${col.code}=X`);
      marksChanged = true;
    } else if (v !== 'X' && !cell.applicable && excluded.has(col.reportTypeId)) {
      await db.query('DELETE FROM client_report_exclusion WHERE client_id = $1 AND report_type_id = $2', [clientId, col.reportTypeId]);
      await audit(db, { actorId, entity: 'client', entityId: clientId, clientId, action: 'REPORT_INCLUDE', before: { report: col.code }, after: { source: 'IMPORT' } });
      changes.push(`${col.code}≠X`);
      marksChanged = true;
    }
  }
  if (marksChanged) {
    // Belgi import oyidan boshlab amal qiladi: joriy oygacha har oy moslanadi (aks holda joriy oyda
    // endi topshirilmaydigan hisobot ochiq qolardi)
    await reconcileThroughNow(db, clientId, actorId, period);
    cells = await loadCells();
  }

  for (const col of values) {
    const v = parseCell(col.raw);
    if (v === null) {
      review.push(`${col.code}: tanib bo'lmaydigan qiymat "${col.raw}"`);
      continue;
    }
    if (v === '') continue;
    const cell = cells.find((c) => c.reportTypeId === col.reportTypeId);
    if (!cell) {
      if (v === '1') review.push(`${col.code}: hisobot turi faol emas, lekin "1" qo'yilgan`);
      continue;
    }
    if (v !== 'X' && !cell.applicable) {
      review.push(`${col.code}: jadvalda "${v}", lekin ${ctx.taxType} bo'yicha topshirilmaydi (X bo'lishi kerak)`);
    } else if (v === '1' && cell.taskId && cell.taskStatus !== 'DONE') {
      // Import paytida rahbarlarga ommaviy xabar yuborilmaydi
      await markDone(db, cell.taskId, null, { notify: false, source: 'IMPORT' });
      cellsDone++;
    } else if (v === '0' && cell.taskStatus === 'DONE') {
      review.push(`${col.code}: jadvalda 0, tizimda allaqachon bajarilgan`);
    }
  }
  return { cellsDone, marksChanged, changes, review };
}

/** Soliq turi aniqlanmagan mijozning fayldagi kataklari: jadvalda ko'rsatish uchun saqlanadi */
export async function saveRawReportCells(db: Db, clientId: number, period: string, values: RawReportCell[], actorId: number | null) {
  for (const v of values) {
    if (!v.raw) continue; // bo'sh katak hech narsani o'chirmaydi
    await db.query(
      `INSERT INTO client_report_raw (client_id, report_type_id, period, raw, imported_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id, report_type_id, period) DO UPDATE SET raw = EXCLUDED.raw, imported_by = EXCLUDED.imported_by, imported_at = now()`,
      [clientId, v.reportTypeId, period, v.raw, actorId],
    );
  }
}

/**
 * Soliq turi endi aniqlandi (karta yoki fayl): oldin saqlangan fayl kataklari vazifalarga qo'llanadi va o'chiriladi.
 * Hal bo'lmagan qiymatlar qo'lda tekshirish ro'yxatiga tushadi. Kelajak oylar kataklari o'z oyi kelguncha turadi.
 */
export async function applyPendingReportCells(db: Db, clientId: number, actorId: number | null) {
  const client = await q<{ taxType: string | null; stir: string; name: string }>(
    db,
    'SELECT tax_type AS "taxType", stir, name FROM client WHERE id = $1',
    [clientId],
  );
  const c = client[0];
  if (!c?.taxType) return { cellsDone: 0 };
  const rows = await q<RawReportCell & { period: string }>(
    db,
    `SELECT r.report_type_id AS "reportTypeId", rt.code, r.raw, to_char(r.period, 'YYYY-MM-DD') AS period
     FROM client_report_raw r JOIN report_type rt ON rt.id = r.report_type_id
     WHERE r.client_id = $1 AND r.period <= $2 ORDER BY r.period, rt.sort_order`,
    [clientId, currentPeriod()],
  );
  let cellsDone = 0;
  for (const period of [...new Set(rows.map((r) => r.period))]) {
    await reconcileThroughNow(db, clientId, actorId, period);
    const r = await applyReportCells(db, { clientId, period, taxType: c.taxType, actorId }, rows.filter((x) => x.period === period));
    cellsDone += r.cellsDone;
    for (const msg of r.review) {
      await db.query(
        `INSERT INTO sheet_sync_error (kind, ref, stir, message) VALUES ('IMPORT_REVIEW', $1, $2, $3)`,
        [period.slice(0, 7), c.stir, `${c.name}: ${msg}`],
      );
    }
    await db.query('DELETE FROM client_report_raw WHERE client_id = $1 AND period = $2', [clientId, period]);
  }
  if (rows.length) {
    await audit(db, { actorId, entity: 'client', entityId: clientId, clientId, action: 'APPLY_IMPORT_CELLS', after: { cells: rows.length, done: cellsDone } });
  }
  return { cellsDone };
}
