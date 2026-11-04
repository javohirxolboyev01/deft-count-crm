import { Router } from 'express';
import { z } from 'zod';
import { type AuthUser, isLeader, me, requireAuth } from '../common/auth';
import { audit, diff } from '../common/audit';
import { AppError, forbidden, notFound, parse } from '../common/errors';
import { normalizeName, normalizeStir, normalizeTaxType } from '../common/normalize';
import { decryptSecret, encryptSecret } from '../common/secretBox';
import { addMonthsIso, currentPeriod, monthOf } from '../common/time';
import { type Db, one, pool, q, tx } from '../db';
import { reassignOpenTasks, reconcileClient } from './generator';
import { applyPendingReportCells } from './sheets/reportCells';
import { resolveReviewOnSave } from './sheets/review';

export const CLIENT = `c.id, c.stir, c.name, c.contact_person AS "contactPerson", c.phone, c.tax_type AS "taxType",
  c.stir_raw AS "stirRaw", c.tax_type_raw AS "taxTypeRaw", c.tax_type_effective_from AS "taxTypeEffectiveFrom", c.accountant_id AS "accountantId",
  a.full_name AS "accountantName", c.status, c.note, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
  c.monthly_fee AS "monthlyFee", c.bank_key AS "bankKey", c.employee_count AS "employeeCount",
  c.mehnat_checked_at AS "mehnatCheckedAt", c.mehnat_login AS "mehnatLogin",
  (c.mehnat_password_enc IS NOT NULL) AS "hasMehnatPassword"`;
export const FROM = `FROM client c LEFT JOIN app_user a ON a.id = c.accountant_id`;

/** Buxgalter ulushi foizi (sozlamada, standart 30) */
export async function sharePercent(db: Db): Promise<number> {
  const r = await one<{ value: unknown }>(db, `SELECT value FROM setting WHERE key = 'accountant_share_percent'`);
  return typeof r?.value === 'number' ? r.value : 30;
}

/**
 * Javobga chiqarish: ulush hisoblanadi (saqlanmaydi); oylik to'lovni faqat rahbar ko'radi,
 * buxgalter faqat o'z ulushini (TODO(tasdiqlash): rahbar qarori, 2026-10-28).
 */
export function presentClient<T extends { monthlyFee?: number | null }>(c: T, u: AuthUser, pct: number) {
  const accountantShare = c.monthlyFee == null ? null : Math.round((c.monthlyFee * pct) / 100);
  return { ...c, monthlyFee: isLeader(u) ? c.monthlyFee : undefined, accountantShare };
}

/** Audit uchun: ochiq parol hech qachon audit_log'ga tushmaydi, faqat "o'zgardi" belgisi */
function auditSafe<T extends { mehnatPassword?: string | null }>(body: T) {
  const { mehnatPassword, ...rest } = body;
  return mehnatPassword === undefined ? rest : { ...rest, mehnatPassword: mehnatPassword ? '••••••' : null };
}

/** Mijozlar ro'yxati filtri: /clients va /works bir xil qoidada (buxgalter faqat o'z mijozlari, serverda) */
export const CLIENT_STATUSES = ['ACTIVE', 'ZERO_REPORT', 'LIQUIDATING', 'ARCHIVED'] as const;

export const clientListQuery = z.object({
  search: z.string().trim().optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  // NONE: soliq turi aniqlanmagan ("to'ldirilmagan") mijozlar
  taxType: z.enum(['AOS', 'QQS', 'YATT', 'NONE']).optional(),
  accountantId: z.union([z.coerce.number().int(), z.literal('none')]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
});

export function clientListWhere(u: AuthUser, f: z.infer<typeof clientListQuery>, p: (v: unknown) => string, opts: { includeArchived?: boolean } = {}) {
  const where: string[] = [];
  if (!isLeader(u)) where.push(`c.accountant_id = ${p(u.id)}`); // serverda cheklov
  if (f.search) {
    const s = normalizeName(f.search);
    const digits = f.search.replace(/\D/g, '');
    where.push(`(c.name_normalized ILIKE ${p(`%${s}%`)} ${digits.length >= 3 ? `OR c.stir LIKE ${p(`${digits}%`)}` : ''})`);
  }
  // Arxiv standart ro'yxatda ko'rinmaydi, faqat filtr bilan
  if (f.status) where.push(`c.status = ${p(f.status)}`);
  else if (!opts.includeArchived) where.push(`c.status <> 'ARCHIVED'`);
  if (f.taxType === 'NONE') where.push('c.tax_type IS NULL');
  else if (f.taxType) where.push(`c.tax_type = ${p(f.taxType)}`);
  if (f.accountantId === 'none') where.push('c.accountant_id IS NULL');
  else if (f.accountantId) where.push(`c.accountant_id = ${p(f.accountantId)}`);
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

const stirSchema = z
  .string()
  .transform(normalizeStir)
  .refine((s) => /^(\d{9}|\d{14})$/.test(s), 'STIR 9 (yoki JShShIR 14) raqamdan iborat bo\'lishi kerak');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD');
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Oy formati: 2026-10');

export const clientInput = z.object({
  stir: stirSchema,
  name: z.string().trim().min(1).max(300),
  contactPerson: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  // Faqat ikki qiymat (CLAUDE.md "Asosiy qoida")
  taxType: z.enum(['AOS', 'QQS', 'YATT']),
  taxTypeEffectiveFrom: isoDate.nullable().optional(),
  accountantId: z.number().int().positive().nullable().optional(),
  status: z.enum(CLIENT_STATUSES).default('ACTIVE'),
  note: z.string().max(5000).nullable().optional(),
  // "Бухгалтер ишлари" fayli ustunlari
  monthlyFee: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  bankKey: z.boolean().nullable().optional(),
  employeeCount: z.number().int().min(0).max(100_000).nullable().optional(),
  mehnatCheckedAt: isoDate.nullable().optional(),
  mehnatLogin: z.string().trim().max(200).nullable().optional(),
  // Faqat yoziladi (javobda qaytmaydi); bo'sh satr = o'chirish
  mehnatPassword: z.string().max(200).nullable().optional(),
});

async function assertAccountant(db: Db, id: number | null | undefined) {
  if (!id) return;
  const u = await one(db, `SELECT id FROM app_user WHERE id = $1 AND role = 'ACCOUNTANT' AND active`, [id]);
  if (!u) throw new AppError(400, 'INVALID_ACCOUNTANT', 'Buxgalter topilmadi yoki faol emas');
}

export async function loadClientForUser(db: Db, id: number, user: AuthUser, lock = false) {
  const c = await one(db, `SELECT ${CLIENT} ${FROM} WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`, [id]);
  if (!c) throw notFound('Mijoz');
  if (!isLeader(user) && c.accountantId !== user.id) throw notFound('Mijoz'); // boshqaning mijozi "yo'q"
  return c;
}

/** Soliq turi tarixini yozish (bir sana uchun bitta yozuv) */
export async function recordTaxType(db: Db, clientId: number, taxType: string, effectiveFrom: string, actorId: number | null) {
  await db.query(
    `INSERT INTO client_tax_type_history (client_id, tax_type, effective_from, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, effective_from) DO UPDATE SET tax_type = EXCLUDED.tax_type, created_by = EXCLUDED.created_by`,
    [clientId, taxType, effectiveFrom, actorId],
  );
}

/**
 * Tanilmagan soliq turi endi tanilsa (masalan V33'dan "ЯТТ" / "YaTT" = YATT): fayldagi matn (tax_type_raw) bo'yicha
 * tur o'zi qo'yiladi — rahbar kartada birinchi marta tanlagandek (boshidan, kataklar qo'llanadi, audit). Ilova ishga
 * tushganda chaqiriladi; idempotent (faqat tax_type NULL va matni tanilgan mijozlar).
 */
export async function adoptRecognizedTaxTypes() {
  const pending = await q<{ id: number; raw: string }>(
    pool,
    'SELECT id, tax_type_raw AS raw FROM client WHERE tax_type IS NULL AND tax_type_raw IS NOT NULL ORDER BY id',
  );
  let adopted = 0;
  for (const c of pending) {
    const taxType = normalizeTaxType(c.raw);
    if (!taxType) continue;
    await tx(async (t) => {
      await t.query('UPDATE client SET tax_type = $2, tax_type_raw = NULL WHERE id = $1 AND tax_type IS NULL', [c.id, taxType]);
      await recordTaxType(t, c.id, taxType, '2000-01-01', null);
      await audit(t, {
        actorId: null, entity: 'client', entityId: c.id, clientId: c.id, action: 'UPDATE',
        before: { taxType: null, taxTypeRaw: c.raw }, after: { taxType, source: 'RECOGNIZED' },
      });
      await resolveReviewOnSave(t, c.id, ['taxType'], false, null);
      await reconcileClient(t, c.id, null);
      await applyPendingReportCells(t, c.id, null);
    });
    adopted++;
  }
  return adopted;
}

/**
 * Import uchun soliq turi null bo'lishi mumkin (fayldagi qiymat tanilmadi, V24): mijoz "to'ldirilmagan",
 * vazifa chiqmaydi, fayldagi matn tax_type_raw'da. Formadan qo'shishda tur majburiy (clientInput).
 */
type NewClient = Omit<z.infer<typeof clientInput>, 'taxType' | 'stir'> & {
  /** null: importda STIR yo'q/noto'g'ri/takroriy (V26), fayldagi matn stirRaw'da */
  stir: string | null;
  stirRaw?: string | null;
  taxType: 'AOS' | 'QQS' | 'YATT' | null;
  taxTypeRaw?: string | null;
  /** V25: qaysi bo'limda (import faqat o'z bo'limini qo'yadi; forma va lead — ikkalasi) */
  inReports?: boolean;
  inWorks?: boolean;
};

export async function createClient(db: Db, input: NewClient, actorId: number | null) {
  await assertAccountant(db, input.accountantId);
  const c = await one(
    db,
    `INSERT INTO client (stir, name, name_normalized, contact_person, phone, tax_type, tax_type_effective_from,
                         accountant_id, status, note, monthly_fee, bank_key, employee_count, mehnat_checked_at,
                         mehnat_login, mehnat_password_enc, tax_type_raw, in_reports, in_works, stir_raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
    [
      input.stir,
      input.name,
      normalizeName(input.name),
      input.contactPerson ?? null,
      input.phone ?? null,
      input.taxType,
      input.taxTypeEffectiveFrom ?? null,
      input.accountantId ?? null,
      input.status,
      input.note ?? null,
      input.monthlyFee ?? null,
      input.bankKey ?? null,
      input.employeeCount ?? null,
      input.mehnatCheckedAt ?? null,
      input.mehnatLogin || null,
      input.mehnatPassword ? encryptSecret(input.mehnatPassword) : null,
      input.taxType ? null : input.taxTypeRaw ?? null,
      input.inReports ?? true,
      input.inWorks ?? true,
      input.stir ? null : input.stirRaw ?? null,
    ],
  );
  // Boshlang'ich tur: "qachondan" berilmasa, butun o'tmish uchun amal qiladi
  if (input.taxType) await recordTaxType(db, c.id, input.taxType, input.taxTypeEffectiveFrom ?? '2000-01-01', actorId);
  await audit(db, { actorId, entity: 'client', entityId: c.id, clientId: c.id, action: 'CREATE', after: auditSafe(input) });
  // Oy o'rtasida qo'shilgan mijozga joriy oy vazifalari darhol yaratiladi
  await reconcileClient(db, c.id, actorId);
  return c.id as number;
}

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

clientsRouter.get('/', async (req, res) => {
  const u = me(req);
  const f = parse(clientListQuery, req.query);
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const w = clientListWhere(u, f, p);
  const total = (await one<{ n: number }>(pool, `SELECT count(*) AS n FROM client c ${w}`, params))!.n;
  const items = await q(
    pool,
    `SELECT ${CLIENT},
       (SELECT count(*) FROM task t WHERE t.client_id = c.id AND t.period = ${p(currentPeriod())}
          AND t.status IN ('TODO','IN_PROGRESS','WAITING_CLIENT'))::int AS "openTasks",
       (SELECT count(*) FROM task t WHERE t.client_id = c.id AND t.status IN ('TODO','IN_PROGRESS','WAITING_CLIENT')
          AND t.due_at < now())::int AS "overdueTasks"
     ${FROM} ${w} ORDER BY c.name_normalized LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`,
    params,
  );
  const pct = await sharePercent(pool);
  res.json({ items: items.map((c) => presentClient(c, u, pct)), total, page: f.page, pageSize: f.pageSize });
});

clientsRouter.get('/:id', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const c = presentClient(await loadClientForUser(pool, id, u), u, await sharePercent(pool));
  const taxHistory = await q(
    pool,
    `SELECT h.id, h.tax_type AS "taxType", h.effective_from AS "effectiveFrom", h.created_at AS "createdAt",
            u.full_name AS "createdByName"
     FROM client_tax_type_history h LEFT JOIN app_user u ON u.id = h.created_by
     WHERE h.client_id = $1 ORDER BY h.effective_from DESC`,
    [id],
  );
  // "Holat bo'yicha" hisobotlar (V20): belgilangan holat oylari bilan; applicable — mijozning hozirgi soliq turiga
  const events = await q(
    pool,
    `SELECT rt.id AS "reportTypeId", rt.code, rt.name, rt.name_ru AS "nameRu", rt.due_day AS "dueDay",
            CASE $2 WHEN 'AOS' THEN rt.applies_to_aos WHEN 'YATT' THEN rt.applies_to_yatt ELSE rt.applies_to_qqs END AS applicable,
            coalesce((SELECT array_agg(ev.month ORDER BY ev.month DESC) FROM client_report_event ev
                      WHERE ev.client_id = $1 AND ev.report_type_id = rt.id), '{}') AS months
     FROM report_type rt WHERE rt.active AND rt.requires_event_flag ORDER BY rt.sort_order, rt.id`,
    [id, c.taxType],
  );
  // Fayldagi "X": mijoz soliq turidan qat'i nazar topshirmaydigan hisobotlar (V17)
  const reportExclusions = await q(
    pool,
    `SELECT e.report_type_id AS "reportTypeId", rt.code, rt.name, rt.name_ru AS "nameRu",
            to_char(e.effective_from, 'YYYY-MM') AS "effectiveFrom"
     FROM client_report_exclusion e JOIN report_type rt ON rt.id = e.report_type_id
     WHERE e.client_id = $1 ORDER BY rt.sort_order, rt.id`,
    [id],
  );
  res.json({ ...c, taxHistory, events, reportExclusions });
});

clientsRouter.get('/:id/history', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  await loadClientForUser(pool, id, u);
  // Buxgalter tarix orqali ham oylik to'lovni ko'rmasin
  const hide = (col: string) => (isLeader(u) ? `l.${col}` : `CASE WHEN jsonb_typeof(l.${col}) = 'object' THEN l.${col} - 'monthlyFee' ELSE l.${col} END`);
  res.json(
    await q(
      pool,
      `SELECT l.id, l.entity, l.entity_id AS "entityId", l.action, ${hide('before')} AS before, ${hide('after')} AS after, l.at,
              u.full_name AS "actorName"
       FROM audit_log l LEFT JOIN app_user u ON u.id = l.actor_id
       WHERE l.client_id = $1 ORDER BY l.at DESC, l.id DESC LIMIT 200`,
      [id],
    ),
  );
});

/**
 * Yangi mijoz (faqat rahbar). section — qaysi sahifadan qo'shilmoqda: mijoz faqat o'sha bo'limga tushadi
 * (Excel import qoidasi bilan bir xil, V25). Berilmasa (eski chaqiruvlar) — ikkala bo'limda.
 * Shu STIR boshqa bo'limda allaqachon bo'lsa — yangi mijoz yaratilmaydi: o'sha mijoz bu bo'limga ham qo'shiladi
 * (ma'lumot bitta), javob 200 va joined: true. Shu bo'limda bo'lsa — 409 DUPLICATE.
 */
clientsRouter.post('/', async (req, res) => {
  const u = me(req);
  if (!isLeader(u)) throw forbidden();
  const input = parse(clientInput.extend({ section: z.enum(['REPORTS', 'WORKS']).optional() }), req.body);
  const { section, ...data } = input;
  const result = await tx(async (db) => {
    const existing = section
      ? await one<{ id: number; inReports: boolean; inWorks: boolean }>(
          db,
          'SELECT id, in_reports AS "inReports", in_works AS "inWorks" FROM client WHERE stir = $1 FOR UPDATE',
          [data.stir],
        )
      : undefined;
    if (existing) {
      const col = section === 'REPORTS' ? 'in_reports' : 'in_works';
      const already = section === 'REPORTS' ? existing.inReports : existing.inWorks;
      if (already) throw new AppError(409, 'DUPLICATE', 'Bu STIR bilan mijoz shu bo\'limda allaqachon bor', { clientId: existing.id });
      await db.query(`UPDATE client SET ${col} = true WHERE id = $1`, [existing.id]);
      await audit(db, {
        actorId: u.id, entity: 'client', entityId: existing.id, clientId: existing.id, action: 'UPDATE',
        before: { [section === 'REPORTS' ? 'inReports' : 'inWorks']: false }, after: { [section === 'REPORTS' ? 'inReports' : 'inWorks']: true },
      });
      // Bo'lim vazifalari joriy oydan chiqadi
      await reconcileClient(db, existing.id, u.id);
      return { id: existing.id, joined: true };
    }
    const sections = section ? { inReports: section === 'REPORTS', inWorks: section === 'WORKS' } : {};
    return { id: await createClient(db, { ...data, ...sections }, u.id), joined: false };
  });
  const body = { ...presentClient(await loadClientForUser(pool, result.id, u), u, await sharePercent(pool)), joined: result.joined };
  res.status(result.joined ? 200 : 201).json(body);
});

clientsRouter.patch('/:id', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const body = parse(clientInput.partial().omit({ status: true }).extend({
    status: z.enum(CLIENT_STATUSES).optional(),
    // Rahbar kartani to'liq saqladi: "tekshiring" yozuvlari ko'rib chiqilgan (V28)
    reviewed: z.boolean().optional(),
  }), req.body);
  // TODO(tasdiqlash): buxgalter aloqa ma'lumotlari, izoh, bank-kalit va my.mehnat.uz ma'lumotlarini o'zgartira oladi;
  // oylik to'lov, soliq turi, holat, buxgalter — faqat rahbar
  const ACCOUNTANT_FIELDS = ['contactPerson', 'phone', 'note', 'bankKey', 'employeeCount', 'mehnatCheckedAt', 'mehnatLogin', 'mehnatPassword'];
  if (!isLeader(u) && Object.keys(body).some((k) => k !== 'reviewed' && !ACCOUNTANT_FIELDS.includes(k))) throw forbidden();
  // Parol diff'ga kirmaydi (oldingi qiymat ochilmaydi): berilgan bo'lsa har doim yoziladi
  const pwChanged = body.mehnatPassword !== undefined;

  await tx(async (db) => {
    const before = await loadClientForUser(db, id, u, true);
    const { mehnatPassword: _pw, reviewed, ...rest } = body;
    const d = diff(before, rest);
    // Tuzatilgan kamchiliklar o'zi yopiladi (V28); "tekshiring" yozuvlari o'zgarish bo'lmasa ham, rahbar saqlasa
    await resolveReviewOnSave(db, id, [...Object.keys(d.after), ...(pwChanged ? ['mehnatPassword'] : [])], !!reviewed && isLeader(u), u.id);
    if (!d.changed && !pwChanged) return;
    if (body.accountantId !== undefined) await assertAccountant(db, body.accountantId);

    const taxChanged = body.taxType !== undefined && body.taxType !== before.taxType;
    // Soliq turi o'zgarsa "qachondan" majburiy emas: berilmasa joriy oyning 1-kuni. Birinchi marta aniqlanayotgan
    // tur (import "to'ldirilmagan" mijozi) esa butun o'tmish uchun: fayldan saqlangan o'tgan oy kataklari ham qo'llansin
    const firstTax = taxChanged && !before.taxType;
    const effectiveFrom = body.taxTypeEffectiveFrom ?? (firstTax ? '2000-01-01' : taxChanged ? currentPeriod() : undefined);

    await db.query(
      `UPDATE client SET
         stir = coalesce($2, stir), stir_raw = CASE WHEN $2 IS NOT NULL THEN NULL ELSE stir_raw END, name = coalesce($3, name), name_normalized = coalesce($4, name_normalized),
         contact_person = CASE WHEN $5 THEN $6 ELSE contact_person END,
         phone = CASE WHEN $7 THEN $8 ELSE phone END,
         tax_type = coalesce($9, tax_type),
         tax_type_raw = CASE WHEN $9 IS NOT NULL THEN NULL ELSE tax_type_raw END,
         tax_type_effective_from = CASE WHEN $10 THEN $11::date ELSE tax_type_effective_from END,
         accountant_id = CASE WHEN $12 THEN $13::bigint ELSE accountant_id END,
         status = coalesce($14, status),
         note = CASE WHEN $15 THEN $16 ELSE note END,
         monthly_fee = CASE WHEN $17 THEN $18::numeric ELSE monthly_fee END,
         bank_key = CASE WHEN $19 THEN $20::boolean ELSE bank_key END,
         employee_count = CASE WHEN $21 THEN $22::int ELSE employee_count END,
         mehnat_checked_at = CASE WHEN $23 THEN $24::date ELSE mehnat_checked_at END,
         mehnat_login = CASE WHEN $25 THEN $26 ELSE mehnat_login END,
         mehnat_password_enc = CASE WHEN $27 THEN $28 ELSE mehnat_password_enc END
       WHERE id = $1`,
      [
        id,
        body.stir ?? null,
        body.name ?? null,
        body.name ? normalizeName(body.name) : null,
        body.contactPerson !== undefined,
        body.contactPerson ?? null,
        body.phone !== undefined,
        body.phone ?? null,
        body.taxType ?? null,
        // Birinchi tur "boshidan": kartada sana ko'rinmasin (tarixda 2000-01-01 = "boshidan")
        effectiveFrom !== undefined && !(firstTax && !body.taxTypeEffectiveFrom),
        effectiveFrom ?? null,
        body.accountantId !== undefined,
        body.accountantId ?? null,
        body.status ?? null,
        body.note !== undefined,
        body.note ?? null,
        body.monthlyFee !== undefined,
        body.monthlyFee ?? null,
        body.bankKey !== undefined,
        body.bankKey ?? null,
        body.employeeCount !== undefined,
        body.employeeCount ?? null,
        body.mehnatCheckedAt !== undefined,
        body.mehnatCheckedAt ?? null,
        body.mehnatLogin !== undefined,
        body.mehnatLogin || null,
        pwChanged,
        body.mehnatPassword ? encryptSecret(body.mehnatPassword) : null,
      ],
    );
    if (taxChanged || (body.taxTypeEffectiveFrom && body.taxType)) {
      await recordTaxType(db, id, body.taxType ?? before.taxType, effectiveFrom!, u.id);
    }
    const pwAudit = pwChanged ? auditSafe({ mehnatPassword: body.mehnatPassword }) : {};
    await audit(db, {
      actorId: u.id,
      entity: 'client',
      entityId: id,
      clientId: id,
      action: 'UPDATE',
      before: { ...d.before, ...(pwChanged && before.hasMehnatPassword ? { mehnatPassword: '••••••' } : {}) },
      after: { ...d.after, ...pwAudit },
    });

    // 6.8: buxgalter almashsa ochiq vazifalar yangisiga o'tadi
    if (body.accountantId !== undefined && body.accountantId !== before.accountantId) {
      await reassignOpenTasks(db, id, body.accountantId, u.id);
    }
    // Soliq turi yoki holat o'zgarsa joriy davr vazifalari moslashtiriladi
    if (taxChanged || body.taxTypeEffectiveFrom !== undefined || (body.status && body.status !== before.status)) {
      await reconcileClient(db, id, u.id);
    }
    // Tur endi ma'lum: fayldan saqlangan kataklar (1 -> Bajarildi, X -> istisno) vazifalarga o'zi qo'llanadi
    if (firstTax) await applyPendingReportCells(db, id, u.id);
  });
  res.json(presentClient(await loadClientForUser(pool, id, u), u, await sharePercent(pool)));
});

/** my.mehnat.uz parolini ochish: rahbar yoki mijozning buxgalteri; har ochish audit_log'da (qiymatsiz) */
clientsRouter.post('/:id/mehnat-password/reveal', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const password = await tx(async (db) => {
    await loadClientForUser(db, id, u);
    const r = await one<{ enc: string | null }>(db, 'SELECT mehnat_password_enc AS enc FROM client WHERE id = $1', [id]);
    if (!r?.enc) throw notFound('Parol');
    await audit(db, { actorId: u.id, entity: 'client', entityId: id, clientId: id, action: 'REVEAL_MEHNAT_PASSWORD' });
    return decryptSecret(r.enc);
  });
  res.json({ password });
});

// ---------- Holat belgisi (dividend, norezident; V20) ----------
// Belgi = holat bo'lgan oy = hisobot katagi oyi (V36), muddati keyingi oyda. Faqat joriy yoki o'tgan oy: shu oy davri
// darhol moslanadi (reconcile). Eskiroq oylar uchun reconcile butun davrni (doimiy ishlar bilan) qayta yaratib yuborishi mumkin edi.
// Belgini rahbar ham, mijozning buxgalteri ham qo'yadi (firma egasi tasdiqladi).
const eventParams = z.object({
  id: z.coerce.number().int(),
  reportTypeId: z.coerce.number().int(),
  month: monthSchema,
});

async function eventTarget(db: Db, raw: unknown, u: AuthUser) {
  const p = parse(eventParams, raw);
  const now = monthOf(currentPeriod());
  if (p.month !== now && p.month !== monthOf(addMonthsIso(currentPeriod(), -1))) {
    throw new AppError(400, 'EVENT_MONTH', "Faqat joriy yoki o'tgan oy holatini belgilash mumkin");
  }
  await loadClientForUser(db, p.id, u, true);
  const rt = await one<{ code: string }>(db, 'SELECT code FROM report_type WHERE id = $1 AND requires_event_flag AND active', [p.reportTypeId]);
  if (!rt) throw notFound('Hisobot');
  return { ...p, code: rt.code };
}

clientsRouter.put('/:id/events/:reportTypeId/:month', async (req, res) => {
  const u = me(req);
  await tx(async (db) => {
    const e = await eventTarget(db, req.params, u);
    const r = await db.query(
      `INSERT INTO client_report_event (client_id, report_type_id, month, marked_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [e.id, e.reportTypeId, e.month, u.id],
    );
    if (r.rowCount) {
      await audit(db, { actorId: u.id, entity: 'client', entityId: e.id, clientId: e.id, action: 'EVENT_MARK', after: { report: e.code, month: e.month } });
      await reconcileClient(db, e.id, u.id, `${e.month}-01`);
    }
  });
  res.json({ ok: true });
});

clientsRouter.delete('/:id/events/:reportTypeId/:month', async (req, res) => {
  const u = me(req);
  await tx(async (db) => {
    const e = await eventTarget(db, req.params, u);
    const r = await db.query('DELETE FROM client_report_event WHERE client_id = $1 AND report_type_id = $2 AND month = $3', [e.id, e.reportTypeId, e.month]);
    if (r.rowCount) {
      await audit(db, { actorId: u.id, entity: 'client', entityId: e.id, clientId: e.id, action: 'EVENT_UNMARK', before: { report: e.code, month: e.month } });
      await reconcileClient(db, e.id, u.id, `${e.month}-01`);
    }
  });
  res.json({ ok: true });
});

// ---------- Topshirilmaydigan hisobot belgisi ("X", V17) ----------
// Belgi fayl importidan keladi; rahbar olib tashlasa joriy oydan hisobot yana soliq turi bo'yicha chiqadi.
clientsRouter.delete('/:id/report-exclusions/:reportTypeId', async (req, res) => {
  const u = me(req);
  if (!isLeader(u)) throw forbidden();
  const id = parse(z.coerce.number().int(), req.params.id);
  const reportTypeId = parse(z.coerce.number().int(), req.params.reportTypeId);
  await tx(async (db) => {
    await loadClientForUser(db, id, u, true);
    const r = await one<{ code: string }>(
      db,
      `DELETE FROM client_report_exclusion e USING report_type rt
       WHERE e.client_id = $1 AND e.report_type_id = $2 AND rt.id = e.report_type_id RETURNING rt.code`,
      [id, reportTypeId],
    );
    if (r) {
      await audit(db, { actorId: u.id, entity: 'client', entityId: id, clientId: id, action: 'REPORT_INCLUDE', before: { report: r.code } });
      await reconcileClient(db, id, u.id);
    }
  });
  res.json({ ok: true });
});
