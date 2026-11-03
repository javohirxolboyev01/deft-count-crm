import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { me, requireAuth, requireLeader } from '../../common/auth';
import { audit } from '../../common/audit';
import { AppError, parse } from '../../common/errors';
import { periodFromMonth } from '../../common/time';
import { type Db, dryTx, one, pool, q, tx } from '../../db';
import { importTable } from './importer';
import { detectWorksFile, importWorks } from './worksImporter';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Katak matni. exceljs `cell.text` bo'sh birlashtirilgan katakda yiqiladi va sanani Date.toString() qiladi:
 * birlashtirilgan katak — asosiy katak qiymati, formula — natijasi, sana — 'YYYY-MM-DD'.
 */
function cellToText(cell: ExcelJS.Cell): string {
  const v: any = cell.isMerged ? cell.master.value : cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join('');
  if ('result' in v) {
    if (v.result instanceof Date) return v.result.toISOString().slice(0, 10);
    // Formula xatosi (#REF!): matni ko'rinsin, "[object Object]" emas
    if (v.result && typeof v.result === 'object' && 'error' in v.result) return String(v.result.error);
    return String(v.result ?? '');
  }
  if ('error' in v) return String(v.error);
  if ('text' in v) return String(v.text);
  return '';
}

export async function xlsxToRows(buf: Buffer, sheetName?: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new AppError(400, 'SHEET_NOT_FOUND', `Varaq topilmadi: ${sheetName}`);
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const arr: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      arr[col - 1] = cellToText(cell);
    });
    rows[n - 1] = arr;
  });
  return Array.from(rows, (r) => r ?? []);
}

export const sheetsRouter = Router();
sheetsRouter.use(requireAuth, requireLeader);

interface PreviousImport {
  fileName: string;
  importedAt: string;
  importedBy: string | null;
}

/**
 * Import: xlsx fayl (multipart "file"). dryRun=true standart.
 * kind — fayl qaysi sahifadan yuklanmoqda: REPORTS (Hisobot topshirish) yoki WORKS (Buxgalter ishlari).
 * Fayl turi sarlavhadan aniqlanadi; sahifaga mos kelmasa 400 WRONG_FILE_KIND (boshqa sahifaga yozib yubormaslik uchun).
 * Fayl mazmuni (SHA-256) avval import qilingan bo'lsa: dry-run javobida `alreadyImported`, haqiqiy importda 409
 * FILE_ALREADY_IMPORTED — bir xil faylni qayta yozish hech narsa qo'shmaydi, faqat chalg'itadi.
 * force=true: rahbar ataylab qayta yuklaydi (masalan import qoidasi o'zgargan: V24 "boricha" — oldin tushib qolgan
 * qatorlar endi yoziladi). Import idempotent: o'zgarmagan qatorlar UNCHANGED.
 * Haqiqiy importdan keyin shu fayldagi korxonalarning eski "Qo'lda tekshirish" yozuvlari yopiladi — ro'yxat
 * faqat oxirgi import holatini ko'rsatadi (yangi muammolar shu import yozganlari).
 */
sheetsRouter.post('/import', upload.single('file'), async (req, res) => {
  const u = me(req);
  const f = parse(
    z.object({
      dryRun: z.enum(['true', 'false']).default('true'),
      kind: z.enum(['REPORTS', 'WORKS']).optional(),
      month: z.string().optional(),
      sheet: z.string().optional(),
      force: z.enum(['true', 'false']).default('false'),
    }),
    req.query,
  );
  const dryRun = f.dryRun === 'true';
  if (!req.file) throw new AppError(400, 'BAD_FILE', 'Fayl tanlanmagan');
  if (!/\.xlsx$/i.test(req.file.originalname)) throw new AppError(400, 'BAD_FILE', 'Faqat .xlsx fayl');
  const fileHash = createHash('sha256').update(req.file.buffer).digest('hex');
  const previous = await one<PreviousImport>(
    pool,
    `SELECT f.file_name AS "fileName", f.imported_at AS "importedAt", u.full_name AS "importedBy"
     FROM sheet_import_file f LEFT JOIN app_user u ON u.id = f.imported_by WHERE f.file_hash = $1`,
    [fileHash],
  );
  if (previous && !dryRun && f.force !== 'true') throw new AppError(409, 'FILE_ALREADY_IMPORTED', 'Bu fayl allaqachon import qilingan', previous);
  const rows = await xlsxToRows(req.file.buffer, f.sheet);
  // Fayl turi sarlavhadan: "Бухгалтер ишлари" (doimiy ish ustunlari) -> Buxgalter ishlari, aks holda hisobot jadvali
  const works = await detectWorksFile(pool, rows);
  const detected = works ? 'WORKS' : 'REPORTS';
  if (f.kind && f.kind !== detected) {
    throw new AppError(400, 'WRONG_FILE_KIND', 'Fayl bu sahifaga tegishli emas', { detected, expected: f.kind });
  }
  const opts = { period: f.month ? periodFromMonth(f.month) : undefined, actorId: u.id, dryRun };
  const run = (db: Db) => (works ? importWorks(db, rows, works, opts) : importTable(db, rows, opts));
  const report = dryRun
    ? await dryTx(run)
    : await tx(async (db) => {
        const r = await run(db);
        // Shu import yozgan yozuvlar occurred_at = now() (tranzaksiya vaqti); eskilari undan oldin.
        // Faqat shu jadval bo'limidagilar: boshqa sahifa faylining kamchiliklariga tegilmaydi (V27)
        const stirs = [...new Set(r.rows.map((x) => x.stir).filter(Boolean))];
        const ids = [...new Set(r.rows.map((x) => x.clientId).filter(Boolean))];
        await db.query(
          `UPDATE sheet_sync_error SET resolved = true, resolved_by = $2, resolved_at = now()
           WHERE kind = 'IMPORT_REVIEW' AND NOT resolved AND occurred_at < now() AND section = $4
             AND (stir = ANY ($1::text[]) OR client_id = ANY ($3::bigint[]))`,
          [stirs, u.id, ids, detected],
        );
        await db.query(
          `INSERT INTO sheet_import_file (file_hash, file_name, period, imported_by, summary) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (file_hash) DO UPDATE SET file_name = EXCLUDED.file_name, period = EXCLUDED.period,
             imported_by = EXCLUDED.imported_by, imported_at = now(), summary = EXCLUDED.summary`,
          // multer nomni latin1 deb o'qiydi: kirill/o'zbekcha nomlar buzilmasin
          [fileHash, Buffer.from(req.file!.originalname, 'latin1').toString('utf8'), `${r.period}-01`, u.id, r.summary],
        );
        return r;
      });
  res.json({ ...report, alreadyImported: previous ?? null });
});

/** kind — sahifa: faqat shu jadval faylining kamchiliklari (berilmasa hammasi). Alohida ro'yxat yo'q: jadvaldagi ⚠ belgisi */
sheetsRouter.get('/review', async (req, res) => {
  const f = parse(z.object({ kind: z.enum(['REPORTS', 'WORKS']).optional() }), req.query);
  res.json(
    await q(
      pool,
      `SELECT e.id, e.occurred_at AS "occurredAt", e.ref, e.stir, e.message, coalesce(e.client_id, c.id) AS "clientId"
       FROM sheet_sync_error e LEFT JOIN client c ON c.stir = e.stir
       WHERE e.kind = 'IMPORT_REVIEW' AND NOT e.resolved AND ($1::text IS NULL OR e.section = $1)
       ORDER BY e.occurred_at DESC, e.id LIMIT 500`,
      [f.kind ?? null],
    ),
  );
});
