import { audit } from '../../common/audit';
import { AppError } from '../../common/errors';
import { normalizeName, normalizeStir, normalizeTaxType } from '../../common/normalize';
import { addMonthsIso, currentPeriod } from '../../common/time';
import { type Db, one, q } from '../../db';
import { createClient, recordTaxType } from '../clients';
import { type ReportTypeLite, cellText, detectColumns, hasSecret, parseCell, parseNote, sameCompany } from './parse';
import { applyPendingReportCells, applyReportCells, reconcileThroughNow, saveRawReportCells, saveUnknownReportCells } from './reportCells';
import { insertReview } from './review';

export interface ImportRowResult {
  row: number;
  stir: string;
  name: string;
  /** Yozilgan mijoz (kamchilik yozuvi unga bog'lanadi; STIR'siz mijoz ham, V26) */
  clientId?: number;
  action: 'NEW' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED';
  changes: string[];
  review: string[];
}

export interface ImportReport {
  /** Fayl turi sarlavhadan aniqlanadi: hisobot jadvali yoki "Бухгалтер ишлари" */
  kind: 'REPORTS' | 'WORKS';
  dryRun: boolean;
  period: string;
  columns: { header: string; code: string }[];
  /** Sarlavhasi tanilmagan ustunlar (ma'lumoti yuklanmadi) */
  ignoredColumns?: string[];
  summary: { total: number; created: number; updated: number; unchanged: number; skipped: number; review: number; cellsDone: number };
  rows: ImportRowResult[];
  csv: string;
}

export async function loadReportTypes(db: Db): Promise<ReportTypeLite[]> {
  return q(db, `SELECT id, code, sheet_aliases AS "sheetAliases" FROM report_type`);
}

const csvEsc = (v: unknown) => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(results: ImportRowResult[]) {
  const header = ['row', 'stir', 'name', 'action', 'changes', 'review'];
  const csv = [header, ...results.map((r) => [r.row, r.stir, r.name, r.action, r.changes.join('|'), r.review.join(' | ')])]
    .map((line) => line.map(csvEsc).join(','))
    .join('\n');
  return '\ufeff' + csv;
}

/**
 * Bir martalik import (B9 1-qism). Dry-run'da chaqiruvchi tranzaksiyani ROLLBACK qiladi:
 * hisobot aynan haqiqiy yozishdagi natija bo'ladi.
 * V24: jadval "boricha" — soliq turi tanilmagan qator ham mijoz bo'ladi (tax_type NULL, fayldagi matni va kataklari
 * saqlanadi, vazifa chiqmaydi); tur aniqlanganda kataklar o'zi qo'llanadi (reportCells.ts). Taxmin qilinmaydi.
 */
export async function importTable(
  db: Db,
  rows: unknown[][],
  opts: { period?: string; actorId: number | null; dryRun: boolean },
): Promise<ImportReport> {
  const types = await loadReportTypes(db);
  const map = detectColumns(rows, types);
  if (!map) throw new AppError(400, 'HEADER_NOT_FOUND', 'Jadval sarlavhasi topilmadi (STIR va hisobot ustunlari kerak)');
  const period = opts.period ?? map.period ?? currentPeriod();
  const nextPeriod = addMonthsIso(period, 1);
  const results: ImportRowResult[] = [];
  const seen = new Map<string, number>();
  let cellsDone = 0;

  for (let r = map.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const rawStir = cellText(row[map.stir]).trim();
    const name = map.name !== null ? cellText(row[map.name]).trim() : '';
    if (!rawStir && !name) continue; // bo'sh qator
    const stir = normalizeStir(rawStir);
    const res: ImportRowResult = { row: r + 1, stir, name, action: 'SKIPPED', changes: [], review: [] };
    results.push(res);

    // V26 "boricha": STIR yaroqsiz yoki takroriy qator ham yoziladi — STIR'siz mijoz (nomi bo'yicha topiladi),
    // fayldagi STIR matni stir_raw'da; rahbar kartada to'g'risini kiritadi
    let stirOk = /^(\d{9}|\d{14})$/.test(stir);
    if (!stirOk) {
      res.review.push(rawStir ? `STIR noto'g'ri: "${rawStir}"` : "STIR yo'q");
    } else if (seen.has(stir)) {
      // Bir faylda bir STIR ikki marta: qaysi biri to'g'riligi noma'lum, birinchisiga STIR beriladi
      res.review.push(`STIR ${seen.get(stir)}-qatorda ham bor (boshqa firma STIRi bo'lishi mumkin)`);
      stirOk = false;
    } else {
      seen.set(stir, r + 1);
    }

    const taxRaw = map.taxType !== null ? cellText(row[map.taxType]).trim() : '';
    const taxType = normalizeTaxType(taxRaw);
    let noteText = map.note !== null ? cellText(row[map.note]).trim() : '';
    if (hasSecret(noteText)) {
      res.review.push("Izohda login/parol bor: xavfsizlik uchun izohga yozilmadi (kerak bo'lsa kartaga qo'lda kiriting)");
      noteText = '';
    }
    const note = parseNote(noteText);
    if (note.review) res.review.push(note.review);
    // "01.11.2026 dan QQS to'lovchisi", ustunda AOS: fayl oyida eski tur, ko'rsatilgan sanadan yangisi (rejalashtiriladi)
    const planned =
      taxType && note.taxType && note.effectiveFrom && note.taxType !== taxType && note.effectiveFrom >= nextPeriod
        ? { taxType: note.taxType, from: note.effectiveFrom }
        : null;
    if (taxType && note.taxType && note.taxType !== taxType && !planned) {
      res.review.push(`Izohdagi soliq turi (${note.taxType}) "Soliq turi" ustunidagi (${taxType}) bilan mos emas`);
    }

    const find = (where: string, v: string) =>
      one<any>(
        db,
        `SELECT id, stir, name, tax_type AS "taxType", tax_type_raw AS "taxTypeRaw",
                to_char(tax_type_effective_from, 'YYYY-MM-DD') AS "taxTypeEffectiveFrom", status, note, in_reports AS "inReports"
         FROM client WHERE ${where} ORDER BY stir IS NULL DESC, id LIMIT 1 FOR UPDATE`,
        [v],
      );
    let existing = stirOk ? await find('stir = $1', stir) : null;
    if (existing && name && !sameCompany(name, existing.name)) {
      res.review.push(`STIR tizimda boshqa mijozga tegishli ("${existing.name}"). Nom o'zgargan bo'lsa kartada yangilang`);
      stirOk = false;
      existing = null;
    }
    // STIR'siz qator nomi bo'yicha: avval STIR'siz mijoz (qayta import), aks holda shu nomdagi yagona mijoz
    // (masalan faylda boshqa firmaning STIR'i yozilgan, firma esa tizimda o'z STIR'i bilan bor) — dublikat bo'lmasin
    if (!stirOk) {
      existing = await find(
        `name_normalized = $1 AND (stir IS NULL OR NOT EXISTS (
           SELECT 1 FROM client x WHERE x.name_normalized = client.name_normalized AND x.id <> client.id))`,
        normalizeName(name || rawStir),
      );
      // Natija: qaysi mijozga yozilgani aniq ko'rinsin (rahbar kartada tekshiradi)
      res.review.push(existing?.stir ? `Nomi bo'yicha tizimdagi mijozga bog'landi (STIR ${existing.stir}) — tekshiring` : "STIR'siz qo'shildi — kartada to'g'ri STIRni kiriting");
    }
    if (!taxType && taxRaw && existing?.taxType) {
      res.review.push(`Soliq turi tanilmadi: "${taxRaw}" (tizimdagi ${existing.taxType} o'zgarmadi)`);
    }

    let clientId: number;
    let taxBecameKnown = false;
    // res.clientId — kamchilik yozuvi mijozga bog'lanadi (pastda, clientId aniqlangach)
    if (!existing) {
      clientId = await createClient(
        db,
        {
          stir: stirOk ? stir : null,
          stirRaw: stirOk ? null : rawStir || null,
          name: name || rawStir,
          taxType,
          taxTypeRaw: taxType ? null : taxRaw || null,
          taxTypeEffectiveFrom: note.taxType === taxType ? note.effectiveFrom : null,
          status: note.status ?? 'ACTIVE',
          note: note.note,
          accountantId: null,
          contactPerson: null,
          phone: null,
          // Faqat shu bo'limda: Buxgalter ishlariga «Бухгалтер ишлари» fayli bilan qo'shiladi (V25)
          inReports: true,
          inWorks: false,
        },
        opts.actorId,
      );
      res.action = 'NEW';
      if (!taxType) res.review.push(`Soliq turi aniqlanmadi${taxRaw ? `: "${taxRaw}"` : ''}. Mijoz qo'shildi, kartada tanlang — vazifalar o'zi chiqadi`);
    } else {
      clientId = existing.id;
      const upd: Record<string, unknown> = {};
      if (name && name !== existing.name) upd.name = name;
      if (taxType && taxType !== existing.taxType) upd.taxType = taxType;
      if (!taxType && !existing.taxType && (taxRaw || null) !== existing.taxTypeRaw && taxRaw) upd.taxTypeRaw = taxRaw;
      if (note.status && note.status !== existing.status) upd.status = note.status;
      if (note.note && note.note !== existing.note) upd.note = note.note;
      const eff = note.taxType === taxType ? note.effectiveFrom : null;
      if (eff && eff !== existing.taxTypeEffectiveFrom) upd.taxTypeEffectiveFrom = eff;
      if (!existing.inReports) {
        // Buxgalter ishlaridagi mijoz hisobot jadvalida ham bor: endi ikkala bo'limda, ma'lumot bitta (V25)
        await db.query('UPDATE client SET in_reports = true WHERE id = $1', [clientId]);
        upd.inReports = true;
      }
      if (Object.keys(upd).length) {
        await db.query(
          `UPDATE client SET name = coalesce($2, name), name_normalized = coalesce($3, name_normalized),
             tax_type = coalesce($4, tax_type), status = coalesce($5, status), note = coalesce($6, note),
             tax_type_effective_from = coalesce($7, tax_type_effective_from),
             tax_type_raw = CASE WHEN $4 IS NOT NULL THEN NULL ELSE coalesce($8, tax_type_raw) END
           WHERE id = $1`,
          [
            clientId,
            upd.name ?? null,
            upd.name ? normalizeName(String(upd.name)) : null,
            upd.taxType ?? null,
            upd.status ?? null,
            upd.note ?? null,
            upd.taxTypeEffectiveFrom ?? null,
            upd.taxTypeRaw ?? null,
          ],
        );
        if (upd.taxType || upd.taxTypeEffectiveFrom) {
          // Birinchi marta aniqlangan tur butun o'tmish uchun (createClient kabi)
          const from = (upd.taxTypeEffectiveFrom as string) ?? (existing.taxType ? period : '2000-01-01');
          await recordTaxType(db, clientId, taxType!, from, opts.actorId);
        }
        taxBecameKnown = !existing.taxType && !!upd.taxType;
        await audit(db, {
          actorId: opts.actorId,
          entity: 'client',
          entityId: clientId,
          clientId,
          action: 'IMPORT_UPDATE',
          before: Object.fromEntries(Object.keys(upd).map((k) => [k, existing[k] ?? null])),
          after: upd,
        });
        res.action = 'UPDATED';
        res.changes = Object.keys(upd);
      } else {
        res.action = 'UNCHANGED';
      }
      if (!taxType && !existing.taxType) res.review.push(`Soliq turi hali aniqlanmagan${taxRaw ? `: "${taxRaw}"` : ''} — kartada tanlang`);
    }
    res.clientId = clientId;
    if (planned) {
      const has = await one(db, 'SELECT 1 FROM client_tax_type_history WHERE client_id = $1 AND effective_from = $2 AND tax_type = $3', [clientId, planned.from, planned.taxType]);
      if (!has) {
        await recordTaxType(db, clientId, planned.taxType, planned.from, opts.actorId);
        await db.query('UPDATE client SET tax_type = $2, tax_type_effective_from = $3 WHERE id = $1', [clientId, planned.taxType, planned.from]);
        await audit(db, { actorId: opts.actorId, entity: 'client', entityId: clientId, clientId, action: 'IMPORT_TAX_PLANNED', after: { taxType: planned.taxType, from: planned.from } });
        res.changes.push(`taxType→${planned.taxType}:${planned.from}`);
        if (res.action === 'UNCHANGED') res.action = 'UPDATED';
      }
    }

    const values = map.reports.map((c) => ({ reportTypeId: c.reportTypeId, code: c.code, raw: cellText(row[c.col]).trim() }));
    const known = await one<{ t: string | null }>(db, 'SELECT fn_client_tax_type($1, fn_period_end($2)) AS t', [clientId, period]);
    if (!known?.t) {
      // Tur noma'lum: kataklar jadvalda fayldagidek ko'rinadi, tur tanlanganda qo'llanadi
      await saveRawReportCells(db, clientId, period, values, opts.actorId);
      continue;
    }
    // Import davridan joriy oygacha vazifalar (joriy oydan farq qilishi mumkin)
    await reconcileThroughNow(db, clientId, opts.actorId, period);
    if (taxBecameKnown) cellsDone += (await applyPendingReportCells(db, clientId, opts.actorId)).cellsDone;
    const applied = await applyReportCells(db, { clientId, period, taxType: known.t, actorId: opts.actorId }, values);
    await db.query('DELETE FROM client_report_raw WHERE client_id = $1 AND period = $2', [clientId, period]);
    await saveUnknownReportCells(db, clientId, period, values, opts.actorId);
    cellsDone += applied.cellsDone;
    res.changes.push(...applied.changes);
    res.review.push(...applied.review);
    if (applied.marksChanged && res.action === 'UNCHANGED') res.action = 'UPDATED';

    // Hamma hisobot "X": mijoz amalda topshirmaydi — holatini rahbar hal qiladi (jim o'zgartirilmaydi)
    const status = note.status ?? existing?.status ?? 'ACTIVE';
    const filled = values.filter((v) => v.raw);
    if (status === 'ACTIVE' && filled.length >= 3 && filled.every((v) => parseCell(v.raw) === 'X')) {
      res.review.push("Barcha hisobotlar X: mijoz Nol hisobot yoki Arxiv emasmi? (holat o'zgartirilmadi, doimiy ishlar chiqaveradi)");
    }
  }

  // Qo'lda tekshirish ro'yxati (dry-run'da ROLLBACK bilan yo'qoladi)
  for (const r of results) {
    for (const msg of r.review) {
      await insertReview(db, { ref: `qator ${r.row}`, stir: r.stir || null, name: r.name, message: msg, clientId: r.clientId ?? null, section: 'REPORTS' });
    }
  }
  if (!opts.dryRun) {
    await audit(db, {
      actorId: opts.actorId,
      entity: 'sheet_import',
      entityId: period,
      action: 'IMPORT',
      after: { rows: results.length, created: results.filter((r) => r.action === 'NEW').length },
    });
  }

  return {
    kind: 'REPORTS',
    dryRun: opts.dryRun,
    period: period.slice(0, 7),
    columns: map.reports.map((c) => ({ header: c.header, code: c.code })),
    ignoredColumns: map.ignored,
    summary: {
      total: results.length,
      created: results.filter((r) => r.action === 'NEW').length,
      updated: results.filter((r) => r.action === 'UPDATED').length,
      unchanged: results.filter((r) => r.action === 'UNCHANGED').length,
      skipped: results.filter((r) => r.action === 'SKIPPED').length,
      review: results.filter((r) => r.review.length > 0).length,
      cellsDone,
    },
    rows: results,
    csv: toCsv(results),
  };
}
