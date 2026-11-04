import { DateTime } from 'luxon';
import { audit } from '../../common/audit';
import { normalizeName, normalizeStir, normalizeTaxType } from '../../common/normalize';
import { decryptSecret, encryptSecret } from '../../common/secretBox';
import { currentPeriod } from '../../common/time';
import { type Db, one, q } from '../../db';
import { createClient, recordTaxType } from '../clients';
import { reassignOpenTasks, reconcileClient } from '../generator';
import { markDone } from '../taskService';
import { type ImportReport, type ImportRowResult, toCsv } from './importer';
import { type RoutineTypeLite, type WorkColumnMap, cellText, detectWorkColumns, parseDate, sameCompany } from './parse';
import { applyPendingReportCells } from './reportCells';
import { insertReview } from './review';

// "Бухгалтер ишлари" faylini import qilish ("Buxgalter ishlari" sahifasi). Hisobot importi (importer.ts) kabi:
// dry-run tranzaksiya ROLLBACK bilan, avtomatik ajratib bo'lmaganlar jim taxmin qilinmaydi -> review.
// Qarorlar:
//  - Fayldagi bo'sh katak hech narsani o'chirmaydi (faqat to'ldirilgan qiymat yoziladi).
//  - Korxona nomi va soliq turi mavjud mijozda o'zgartirilmaydi: ularning manbai hisobot fayli/mijoz kartasi;
//    soliq turi farq qilsa review.
//  - Ish katagidagi sana = "shu oygacha bajarilgan" ish oyi. Tizimgacha bo'lgan oy -> client_routine_baseline;
//    tizimda vazifasi bor oylar -> o'sha oygacha vazifalar "Bajarildi" (bildirishnomasiz).
//  - V24 "boricha": tanilmagan ish katagi ("eri", "28,02,2025(14)") matni client_routine_raw'da saqlanib sahifada
//    ko'rinadi; soliq turi tanilmagan yangi qator ham mijoz bo'ladi (tax_type NULL). Mavjud mijozda tur faqat
//    aniqlanmagan bo'lsa fayldan to'ldiriladi.

export async function loadRoutineTypes(db: Db): Promise<RoutineTypeLite[]> {
  return q(
    db,
    `SELECT id, name, report_type_id AS "reportTypeId", sheet_aliases AS "sheetAliases"
     FROM routine_work_type WHERE active ORDER BY sort_order, id`,
  );
}

export async function detectWorksFile(db: Db, rows: unknown[][]): Promise<WorkColumnMap | null> {
  return detectWorkColumns(rows, await loadRoutineTypes(db));
}

const month1 = (iso: string) => `${iso.slice(0, 7)}-01`;
const addMonths = (period: string, n: number) => DateTime.fromISO(period).plus({ months: n }).toISODate()!;

export interface Accountant {
  id: number;
  words: string[];
}

/** Ism so'zlari: kirill/lotin farqisiz, x/h ("Хошим" = "Xoshim" = "Hoshim") va boshdagi ye/e ("Ерқин" = "Yerqin") bir xil */
const nameWords = (s: string) =>
  normalizeName(s)
    .replace(/x/g, 'h')
    .replace(/\bye/g, 'e')
    .split(' ')
    .filter((w) => w.length > 1);

export const toAccountant = (id: number, fullName: string): Accountant => ({ id, words: nameWords(fullName) });

/**
 * "Фазлиддин" / "Madaminov" / "Sanjar Madaminov" -> faol buxgalter: ism yoki familiya (tartib muhim emas).
 * Eng ko'p so'zi mos kelgan bitta xodim tanlanadi; teng bo'lsa AMBIGUOUS.
 */
export function matchAccountant(raw: string, list: Accountant[]): Accountant | null | 'AMBIGUOUS' {
  const words = nameWords(raw);
  let best: Accountant[] = [];
  let bestScore = 0;
  for (const a of list) {
    const score = words.filter((w) => a.words.includes(w)).length;
    if (score === 0 || score < bestScore) continue;
    if (score > bestScore) best = [];
    bestScore = score;
    best.push(a);
  }
  if (best.length === 0) return null;
  return best.length === 1 ? best[0] : 'AMBIGUOUS';
}

function parseBool(raw: string): boolean | null | undefined {
  const k = normalizeName(raw).replace(/[^a-z]/g, '');
  if (!k) return undefined;
  if (['bor', 'ha', 'est', 'yes', 'da'].includes(k)) return true;
  if (['yoq', 'yok', 'net', 'no', 'yuq'].includes(k)) return false;
  return null;
}

const parseIntStrict = (raw: string) => {
  const s = raw.replace(/[\s ]/g, '').replace(/,0+$|\.0+$/, '');
  return /^\d+$/.test(s) ? Number(s) : null;
};

export async function importWorks(
  db: Db,
  rows: unknown[][],
  map: WorkColumnMap,
  opts: { actorId: number | null; dryRun: boolean },
): Promise<ImportReport> {
  const routines = await loadRoutineTypes(db);
  const accountants = (
    await q<{ id: number; fullName: string }>(db, `SELECT id, full_name AS "fullName" FROM app_user WHERE role = 'ACCOUNTANT' AND active`)
  ).map((a) => toAccountant(a.id, a.fullName));
  const now = currentPeriod();
  const F = map.fields;
  const get = (row: unknown[], f: keyof typeof F) => (F[f] === undefined ? '' : cellText(row[F[f]!]).trim());
  const results: ImportRowResult[] = [];
  const seen = new Map<string, number>();
  let cellsDone = 0;

  for (let r = map.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const rawStir = get(row, 'stir');
    const name = get(row, 'name');
    if (!rawStir && !name) continue; // bo'sh qator
    // Sarlavha ostidagi ustun raqamlari qatori ("1 | 2 | 3 ...")
    if (/^\d{0,3}$/.test(rawStir) && /^\d*$/.test(name)) continue;
    const stir = normalizeStir(rawStir);
    const res: ImportRowResult = { row: r + 1, stir, name, action: 'SKIPPED', changes: [], review: [] };
    results.push(res);

    // V26 "boricha": STIR yaroqsiz yoki takroriy qator ham yoziladi — STIR'siz mijoz (nomi bo'yicha topiladi)
    let stirOk = /^(\d{9}|\d{14})$/.test(stir);
    if (!stirOk) {
      res.review.push(rawStir ? `STIR noto'g'ri: "${rawStir}"` : "STIR yo'q");
    } else if (seen.has(stir)) {
      // Ikkinchisi birinchi mijozning ma'lumotini ustidan yozib yubormasin: alohida, STIR'siz
      res.review.push(`STIR ${seen.get(stir)}-qatorda ham bor (boshqa firma STIRi bo'lishi mumkin)`);
      stirOk = false;
    } else {
      seen.set(stir, r + 1);
    }

    // --- Mijoz maydonlari ---
    const upd: Record<string, unknown> = {};
    const accRaw = get(row, 'accountant');
    let accountantId: number | null | undefined;
    if (accRaw) {
      const a = matchAccountant(accRaw, accountants);
      if (a === 'AMBIGUOUS') res.review.push(`Buxgalter "${accRaw}": bir nechta xodimga mos keladi`);
      else if (!a) res.review.push(`Buxgalter "${accRaw}" tizimda topilmadi (Xodimlar bo'limida qo'shing)`);
      else accountantId = a.id;
    }
    const feeRaw = get(row, 'monthlyFee');
    if (feeRaw) {
      const v = parseIntStrict(feeRaw);
      if (v === null) res.review.push(`Oylik to'lov tanilmadi: "${feeRaw}"`);
      else upd.monthlyFee = v;
    }
    const bankRaw = get(row, 'bankKey');
    const bank = parseBool(bankRaw);
    if (bank === null) res.review.push(`Bank-kalit tanilmadi: "${bankRaw}"`);
    else if (bank !== undefined) upd.bankKey = bank;
    const empRaw = get(row, 'employeeCount');
    if (empRaw) {
      const v = parseIntStrict(empRaw);
      if (v === null) res.review.push(`Xodim soni tanilmadi: "${empRaw}"`);
      else upd.employeeCount = v;
    }
    const checkedRaw = get(row, 'mehnatCheckedAt');
    if (checkedRaw) {
      const d = parseDate(checkedRaw);
      if (!d) res.review.push(`my.mehnat.uz sanasi tanilmadi: "${checkedRaw}"`);
      else upd.mehnatCheckedAt = d;
    }
    const login = get(row, 'mehnatLogin');
    if (login) upd.mehnatLogin = login;
    const password = get(row, 'mehnatPassword');
    const note = get(row, 'note');

    const find = (where: string, v: string) =>
      one<any>(
        db,
        `SELECT id, stir, name, tax_type AS "taxType", tax_type_raw AS "taxTypeRaw", accountant_id AS "accountantId", note, monthly_fee AS "monthlyFee",
                bank_key AS "bankKey", employee_count AS "employeeCount", to_char(mehnat_checked_at, 'YYYY-MM-DD') AS "mehnatCheckedAt",
                mehnat_login AS "mehnatLogin", mehnat_password_enc AS "mehnatPasswordEnc", in_works AS "inWorks"
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
    const taxRaw = get(row, 'taxType');
    const taxType = normalizeTaxType(taxRaw);
    let clientId: number;
    if (!existing) {
      if (!taxType) res.review.push(`Soliq turi aniqlanmadi${taxRaw ? `: "${taxRaw}"` : ''}. Mijoz qo'shildi, kartada tanlang — vazifalar o'zi chiqadi`);
      clientId = await createClient(
        db,
        {
          stir: stirOk ? stir : null,
          stirRaw: stirOk ? null : rawStir || null,
          name: name || rawStir,
          taxType,
          taxTypeRaw: taxType ? null : taxRaw || null,
          status: 'ACTIVE',
          accountantId: accountantId ?? null,
          note: note || null,
          monthlyFee: (upd.monthlyFee as number) ?? null,
          bankKey: (upd.bankKey as boolean) ?? null,
          employeeCount: (upd.employeeCount as number) ?? null,
          mehnatCheckedAt: (upd.mehnatCheckedAt as string) ?? null,
          mehnatLogin: (upd.mehnatLogin as string) ?? null,
          mehnatPassword: password || null,
          // Faqat shu bo'limda: Hisobot topshirishga hisobot jadvali bilan qo'shiladi (V25)
          inReports: false,
          inWorks: true,
        },
        opts.actorId,
      );
      res.action = 'NEW';
    } else {
      clientId = existing.id;
      if (!existing.inWorks) {
        // Hisobot jadvalidagi mijoz «Бухгалтер ишлари» faylida ham bor: endi ikkala bo'limda, joriy oy ishlari chiqadi (V25)
        await db.query('UPDATE client SET in_works = true WHERE id = $1', [clientId]);
        await audit(db, { actorId: opts.actorId, entity: 'client', entityId: clientId, clientId, action: 'IMPORT_UPDATE', before: { inWorks: false }, after: { inWorks: true } });
        await reconcileClient(db, clientId, opts.actorId);
        res.changes.push('inWorks');
        res.action = 'UPDATED';
      }
      if (!existing.taxType && taxType) {
        // "To'ldirilmagan" mijoz: tur fayldan aniqlandi (butun o'tmish uchun), saqlangan kataklar qo'llanadi
        await db.query('UPDATE client SET tax_type = $2, tax_type_raw = NULL WHERE id = $1', [clientId, taxType]);
        await recordTaxType(db, clientId, taxType, '2000-01-01', opts.actorId);
        await audit(db, { actorId: opts.actorId, entity: 'client', entityId: clientId, clientId, action: 'IMPORT_UPDATE', before: { taxType: null }, after: { taxType } });
        await reconcileClient(db, clientId, opts.actorId);
        cellsDone += (await applyPendingReportCells(db, clientId, opts.actorId)).cellsDone;
        res.changes.push('taxType');
        res.action = 'UPDATED';
      } else if (!existing.taxType) {
        res.review.push(`Soliq turi hali aniqlanmagan${taxRaw ? `: "${taxRaw}"` : ''} — kartada tanlang`);
      } else if (taxType && taxType !== existing.taxType) {
        res.review.push(`Soliq turi faylda ${taxType}, tizimda ${existing.taxType} (o'zgartirilmadi, mijoz kartasida tekshiring)`);
      } else if (!taxType && taxRaw) {
        res.review.push(`Soliq turi tanilmadi: "${taxRaw}" (tizimdagi ${existing.taxType} o'zgarmadi)`);
      }
      for (const k of Object.keys(upd)) {
        const before = k === 'monthlyFee' && existing[k] !== null ? Number(existing[k]) : existing[k];
        if (before === upd[k]) delete upd[k];
      }
      if (accountantId !== undefined && accountantId !== existing.accountantId) upd.accountantId = accountantId;
      // Izoh faqat bo'sh bo'lsa to'ldiriladi; farq qilsa tizimdagisi qoladi (izoh kamchilik emas — ogohlantirilmaydi)
      if (note && !existing.note) upd.note = note;
      // Shifrlangan parol har safar boshqacha (tasodifiy IV): ochib solishtiriladi
      const pwChanged = !!password && (!existing.mehnatPasswordEnc || decryptSecret(existing.mehnatPasswordEnc) !== password);
      if (Object.keys(upd).length || pwChanged) {
        await db.query(
          `UPDATE client SET
             monthly_fee = CASE WHEN $2 THEN $3::numeric ELSE monthly_fee END,
             bank_key = CASE WHEN $4 THEN $5::boolean ELSE bank_key END,
             employee_count = CASE WHEN $6 THEN $7::int ELSE employee_count END,
             mehnat_checked_at = CASE WHEN $8 THEN $9::date ELSE mehnat_checked_at END,
             mehnat_login = CASE WHEN $10 THEN $11 ELSE mehnat_login END,
             mehnat_password_enc = CASE WHEN $12 THEN $13 ELSE mehnat_password_enc END,
             accountant_id = CASE WHEN $14 THEN $15::bigint ELSE accountant_id END,
             note = CASE WHEN $16 THEN $17 ELSE note END
           WHERE id = $1`,
          [
            clientId,
            'monthlyFee' in upd, upd.monthlyFee ?? null,
            'bankKey' in upd, upd.bankKey ?? null,
            'employeeCount' in upd, upd.employeeCount ?? null,
            'mehnatCheckedAt' in upd, upd.mehnatCheckedAt ?? null,
            'mehnatLogin' in upd, upd.mehnatLogin ?? null,
            pwChanged, pwChanged ? encryptSecret(password) : null,
            'accountantId' in upd, upd.accountantId ?? null,
            'note' in upd, upd.note ?? null,
          ],
        );
        const keys = [...Object.keys(upd), ...(pwChanged ? ['mehnatPassword'] : [])];
        await audit(db, {
          actorId: opts.actorId,
          entity: 'client',
          entityId: clientId,
          clientId,
          action: 'IMPORT_UPDATE',
          before: Object.fromEntries(Object.keys(upd).map((k) => [k, existing[k] ?? null])),
          after: { ...upd, ...(pwChanged ? { mehnatPassword: '••••••' } : {}) },
        });
        // 6.8: buxgalter almashsa ochiq vazifalar yangisiga o'tadi
        if ('accountantId' in upd) await reassignOpenTasks(db, clientId, upd.accountantId as number, opts.actorId as number);
        res.action = 'UPDATED';
        res.changes.push(...keys);
      } else if (res.action !== 'UPDATED') {
        res.action = 'UNCHANGED';
      }
    }

    res.clientId = clientId;

    // --- Doimiy ishlar: "shu oygacha bajarilgan" ---
    const cellsBefore = cellsDone;
    for (const col of map.routines) {
      const raw = cellText(row[col.col]).trim();
      if (!raw) continue;
      const d = parseDate(raw);
      if (!d) {
        // Fayldagi matn sahifada boricha ko'rinadi; rahbar oyni kiritsa yoki keyingi faylda sana kelsa o'chadi
        res.review.push(`${col.name}: sana tanilmadi "${raw}"`);
        const saved = await db.query(
          `INSERT INTO client_routine_raw (client_id, routine_type_id, raw, imported_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id, routine_type_id) DO UPDATE SET raw = EXCLUDED.raw, imported_by = EXCLUDED.imported_by, imported_at = now()
           WHERE client_routine_raw.raw IS DISTINCT FROM EXCLUDED.raw`,
          [clientId, col.routineTypeId, raw, opts.actorId],
        );
        if (saved.rowCount) cellsDone++;
        continue;
      }
      await db.query('DELETE FROM client_routine_raw WHERE client_id = $1 AND routine_type_id = $2', [clientId, col.routineTypeId]);
      const rt = routines.find((x) => x.id === col.routineTypeId)!;
      const month = month1(d);
      // Vazifa davri = ish oyi (V36: INPS ham)
      const first = await one<{ p: string | null }>(
        db,
        `SELECT to_char(min(period), 'YYYY-MM-DD') AS p FROM task
         WHERE client_id = $1 AND status <> 'CANCELLED'
           AND ((kind = 'ROUTINE' AND routine_type_id = $2) OR (kind = 'REPORT' AND report_type_id = $3))`,
        [clientId, rt.id, rt.reportTypeId],
      );
      const firstWork = first?.p ?? null;
      // Tizimgacha bo'lgan oxirgi oy: fayldagi oy yoki (tizim davriga kirsa) birinchi vazifadan oldingi oy
      const baseline = firstWork && month >= firstWork ? addMonths(firstWork, -1) : month;
      if (baseline <= addMonths(now, -1)) {
        const b = await one<{ d: string }>(
          db,
          `SELECT to_char(done_through, 'YYYY-MM-DD') AS d FROM client_routine_baseline WHERE client_id = $1 AND routine_type_id = $2`,
          [clientId, rt.id],
        );
        if (b?.d !== baseline) {
          await db.query(
            `INSERT INTO client_routine_baseline (client_id, routine_type_id, done_through, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (client_id, routine_type_id)
             DO UPDATE SET done_through = EXCLUDED.done_through, prev_done_through = NULL, updated_by = EXCLUDED.updated_by`,
            [clientId, rt.id, baseline, opts.actorId],
          );
          await audit(db, {
            actorId: opts.actorId,
            entity: 'client_routine_baseline',
            entityId: `${clientId}:${rt.id}`,
            clientId,
            action: 'IMPORT_BASELINE',
            before: { doneThrough: b?.d?.slice(0, 7) ?? null },
            after: { doneThrough: baseline.slice(0, 7), work: rt.name },
          });
          cellsDone++;
        }
      }
      if (firstWork && month >= firstWork) {
        const open = await q<{ id: number }>(
          db,
          `SELECT id FROM task
           WHERE client_id = $1 AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT') AND period <= $4
             AND ((kind = 'ROUTINE' AND routine_type_id = $2) OR (kind = 'REPORT' AND report_type_id = $3))
           ORDER BY period`,
          [clientId, rt.id, rt.reportTypeId, month],
        );
        for (const t of open) {
          // Import paytida rahbarlarga ommaviy xabar yuborilmaydi
          await markDone(db, t.id, null, { notify: false, source: 'IMPORT' });
          cellsDone++;
        }
      }
    }
    if (cellsDone > cellsBefore) {
      if (res.action === 'UNCHANGED') res.action = 'UPDATED';
      res.changes.push('works');
    }
  }

  for (const r of results) {
    for (const msg of r.review) {
      await insertReview(db, { ref: `qator ${r.row}`, stir: r.stir || null, name: r.name, message: msg, clientId: r.clientId ?? null, section: 'WORKS' });
    }
  }
  if (!opts.dryRun) {
    await audit(db, {
      actorId: opts.actorId,
      entity: 'sheet_import',
      entityId: 'WORKS',
      action: 'IMPORT_WORKS',
      after: { rows: results.length, created: results.filter((r) => r.action === 'NEW').length, cellsDone },
    });
  }

  return {
    kind: 'WORKS',
    dryRun: opts.dryRun,
    period: now.slice(0, 7),
    columns: map.routines.map((c) => ({ header: c.header, code: c.name })),
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
