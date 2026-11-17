import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { type AuthUser, isLeader, me, requireAuth, requireLeader, requireRole } from '../common/auth';
import { audit, diff } from '../common/audit';
import { AppError, notFound, parse } from '../common/errors';
import { headerKey, normalizeName, normalizeStir } from '../common/normalize';
import { nowTz } from '../common/time';
import { type Db, dryTx, one, pool, q, tx } from '../db';
import { clientInput, createClient } from './clients';
import { notifyLeaders } from './notifications';
import { xlsxToRows } from './sheets/routes';

// Sotuv operatori: yangi firmalarga qo'ng'iroq, natija va izoh. Operator faqat shu bo'limni ko'radi.
// Qaror: operator bitta (rahbar tasdiqladi), shuning uchun lead operatorga biriktirilmaydi —
// operator barcha ochiq lead'larni ko'radi, "kim gaplashdi" lead_call.user_id'dan olinadi.
// TODO(tasdiqlash): ikkinchi operator qo'shilsa, lead.operator_id va taqsimlash kerak bo'ladi.

const OPEN = ['NEW', 'NO_ANSWER', 'CALL_LATER', 'MEETING'] as const;
const CLOSED = ['HAS_ACCOUNTANT', 'REJECTED'] as const;
const RESULTS = ['NO_ANSWER', 'CALL_LATER', 'MEETING', 'HAS_ACCOUNTANT', 'REJECTED', 'WON'] as const;
/** Keyingi qo'ng'iroq kuni majburiy natijalar */
const NEEDS_DATE = ['CALL_LATER', 'MEETING'];
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

const LEAD = `l.id, l.stir, l.name, l.director, l.phone, l.address, l.registered_at AS "registeredAt", l.status,
  l.next_call_date AS "nextCallDate", l.last_call_at AS "lastCallAt", l.transferred_at AS "transferredAt",
  l.converted_client_id AS "convertedClientId", l.created_at AS "createdAt", l.source,
  (SELECT count(*) FROM lead_call c WHERE c.lead_id = l.id)::int AS "callCount",
  (SELECT c.comment FROM lead_call c WHERE c.lead_id = l.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS "lastComment"`;

/** Mijozga o'tgan lead operatorga "yo'q" (rahbar qarori: o'tkazilgandan keyin operator u bilan gaplashmaydi) */
const operatorHidden = (u: AuthUser) => (isLeader(u) ? '' : `AND l.status NOT IN ('WON', 'CONVERTED')`);

async function loadLead(db: Db, id: number, u: AuthUser, lock = false) {
  const l = await one(db, `SELECT ${LEAD} FROM lead l WHERE l.id = $1 ${operatorHidden(u)} ${lock ? 'FOR UPDATE OF l' : ''}`, [id]);
  if (!l) throw notFound('Firma');
  return l;
}

const today = () => nowTz().toISODate()!;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD');

export const leadsRouter = Router();
leadsRouter.use(requireAuth, requireRole('LEADER', 'OPERATOR'));

// ---------- Ro'yxat ----------
// view: today — bugun qo'ng'iroq qilinadiganlar (yangi + kuni kelgan/o'tgan), open, closed, won, converted, all
leadsRouter.get('/', async (req, res) => {
  const u = me(req);
  const f = parse(
    z.object({
      view: z.enum(['today', 'open', 'closed', 'won', 'converted', 'all']).default('today'),
      status: z.enum([...OPEN, ...CLOSED, 'WON', 'CONVERTED']).optional(),
      search: z.string().trim().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  if (!isLeader(u) && (f.view === 'won' || f.view === 'converted' || f.status === 'WON' || f.status === 'CONVERTED')) {
    throw new AppError(403, 'FORBIDDEN', 'Ruxsat yo\'q');
  }
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = ['true'];
  if (f.view === 'today') where.push(`l.status IN (${list(OPEN)}) AND (l.next_call_date IS NULL OR l.next_call_date <= ${p(today())})`);
  if (f.view === 'open') where.push(`l.status IN (${list(OPEN)})`);
  if (f.view === 'closed') where.push(`l.status IN (${list(CLOSED)})`);
  if (f.view === 'won') where.push(`l.status = 'WON'`);
  if (f.view === 'converted') where.push(`l.status = 'CONVERTED'`);
  if (f.status) where.push(`l.status = ${p(f.status)}`);
  if (f.search) {
    const digits = f.search.replace(/\D/g, '');
    where.push(`(l.name_normalized ILIKE ${p(`%${normalizeName(f.search)}%`)}
      ${digits.length >= 3 ? `OR l.stir LIKE ${p(`${digits}%`)} OR regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g') LIKE ${p(`%${digits}%`)}` : ''})`);
  }
  const w = `WHERE ${where.join(' AND ')} ${operatorHidden(u)}`;
  const total = (await one<{ n: number }>(pool, `SELECT count(*) AS n FROM lead l ${w}`, params))!.n;
  // Kuni o'tganlar birinchi, keyin bugungilar, keyin hali gaplashilmagan yangilar
  const order =
    f.view === 'today' || f.view === 'open'
      ? // Qo'lda qo'shilgan nomzodda ro'yxatdan o'tgan sana yo'q: qo'shilgan kuni bo'yicha (oxirida qolib ketmasin)
        'l.next_call_date ASC NULLS LAST, coalesce(l.registered_at, l.created_at::date) DESC, l.id'
      : 'coalesce(l.last_call_at, l.created_at) DESC, l.id DESC';
  const items = await q(pool, `SELECT ${LEAD} FROM lead l ${w} ORDER BY ${order} LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`, params);
  res.json({ items, total, page: f.page, pageSize: f.pageSize });
});

// ---------- Statistika: nechta va qanday gaplashdi ----------
leadsRouter.get('/stats', async (_req, res) => {
  const calls = await one(
    pool,
    `SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS day,
            count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS week,
            count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS month,
            count(DISTINCT lead_id) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS "dayFirms"
     FROM lead_call`,
  );
  const byResult = Object.fromEntries(
    (
      await q<{ result: string; n: number }>(
        pool,
        `SELECT result, count(*)::int AS n FROM lead_call WHERE created_at >= date_trunc('month', now()) GROUP BY result`,
      )
    ).map((r) => [r.result, r.n]),
  );
  const byStatus = Object.fromEntries(
    (await q<{ status: string; n: number }>(pool, `SELECT status, count(*)::int AS n FROM lead GROUP BY status`)).map((r) => [r.status, r.n]),
  );
  const due = await one<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM lead WHERE status IN (${list(OPEN)}) AND (next_call_date IS NULL OR next_call_date <= $1)`,
    [today()],
  );
  // Operator o'tkazilgan firmalar sonini (o'z natijasini) ko'radi, ro'yxatini emas
  res.json({ calls, byResult, byStatus, dueToday: due!.n });
});

// ---------- Excel import (rahbar) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

interface LeadRow {
  stir: string;
  name: string;
  director: string | null;
  phone: string | null;
  address: string | null;
  registeredAt: string | null;
}

/** 998901234567 / 901234567 -> +998901234567; boshqasi raqamlar holicha */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 12 && d.startsWith('998')) return `+${d}`;
  if (d.length === 9) return `+998${d}`;
  return d;
}

/** '07.10.2026' yoki '2026-10-07' -> '2026-10-07' */
function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Sarlavha matnidan ustunlarni aniqlash (indeksdan emas): ИНН/STIR, Название/Korxona nomi, Директор,
 * har qanday "Телефон" ustuni (bir nechta bo'lishi mumkin), Адрес/Manzil, Дата регистрации.
 */
export function parseLeadRows(rows: unknown[][]) {
  const cell = (r: unknown[], i: number) => String(r[i] ?? '').trim();
  const headerIdx = rows.findIndex((r) => r.some((c) => ['INN', 'STIR'].includes(headerKey(String(c ?? '')))));
  if (headerIdx < 0) throw new AppError(400, 'HEADER_NOT_FOUND', 'Sarlavha topilmadi (ИНН/STIR ustuni kerak)');
  const keys = rows[headerIdx].map((c) => headerKey(String(c ?? '')));
  const find = (...names: string[]) => keys.findIndex((k) => names.some((n) => k === n || k.startsWith(n)));
  const col = {
    stir: find('INN', 'STIR'),
    name: find('NAZVANIE', 'KORXONANOMI', 'NOMI', 'NAIMENOVANIE'),
    director: find('DIREKTOR', 'RAHBAR', 'RUKOVODITEL'),
    address: find('ADRES', 'MANZIL'),
    registeredAt: find('DATAREGISTRATSII', 'ROYXATDAN'),
    phones: keys.flatMap((k, i) => (k.includes('TELEFON') ? [i] : [])),
  };
  if (col.name < 0) throw new AppError(400, 'HEADER_NOT_FOUND', 'Sarlavha topilmadi (Название/nomi ustuni kerak)');
  const parsed: (LeadRow & { row: number })[] = [];
  const invalid: { row: number; stir: string; name: string; reason: string }[] = [];
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const row = headerIdx + i + 2;
    const rawStir = cell(r, col.stir);
    const name = cell(r, col.name);
    if (!rawStir && !name) return; // bo'sh qator
    const stir = normalizeStir(rawStir);
    if (!/^(\d{9}|\d{14})$/.test(stir)) return void invalid.push({ row, stir: rawStir, name, reason: 'BAD_STIR' });
    if (!name) return void invalid.push({ row, stir, name, reason: 'NO_NAME' });
    const phones = [...new Set(col.phones.map((i) => normalizePhone(cell(r, i))).filter(Boolean))];
    parsed.push({
      row,
      stir,
      name,
      director: col.director >= 0 ? cell(r, col.director) || null : null,
      phone: phones.length ? phones.join(', ') : null,
      address: col.address >= 0 ? cell(r, col.address) || null : null,
      registeredAt: col.registeredAt >= 0 ? parseDate(cell(r, col.registeredAt)) : null,
    });
  });
  return { parsed, invalid };
}

/** Import: yangi STIR qo'shiladi; mavjud lead yoki allaqachon mijozimiz bo'lgan firma o'tkazib yuboriladi (o'zgarmaydi) */
async function importLeads(db: Db, rows: unknown[][], actorId: number) {
  const { parsed, invalid } = parseLeadRows(rows);
  const out: { row: number; stir: string; name: string; action: 'NEW' | 'EXISTING_LEAD' | 'EXISTING_CLIENT' | 'DUPLICATE_ROW' }[] = [];
  const seen = new Set<string>();
  let withoutPhone = 0;
  for (const r of parsed) {
    if (seen.has(r.stir)) {
      out.push({ row: r.row, stir: r.stir, name: r.name, action: 'DUPLICATE_ROW' });
      continue;
    }
    seen.add(r.stir);
    if (await one(db, 'SELECT 1 FROM client WHERE stir = $1', [r.stir])) {
      out.push({ row: r.row, stir: r.stir, name: r.name, action: 'EXISTING_CLIENT' });
      continue;
    }
    const ins = await db.query(
      `INSERT INTO lead (stir, name, name_normalized, director, phone, address, registered_at, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (stir) DO NOTHING`,
      [r.stir, r.name, normalizeName(r.name), r.director, r.phone, r.address, r.registeredAt, actorId],
    );
    out.push({ row: r.row, stir: r.stir, name: r.name, action: ins.rowCount ? 'NEW' : 'EXISTING_LEAD' });
    if (ins.rowCount && !r.phone) withoutPhone++;
  }
  const count = (a: string) => out.filter((r) => r.action === a).length;
  const summary = {
    total: parsed.length + invalid.length,
    created: count('NEW'),
    existingLead: count('EXISTING_LEAD'),
    existingClient: count('EXISTING_CLIENT'),
    duplicateRow: count('DUPLICATE_ROW'),
    invalid: invalid.length,
    withoutPhone,
  };
  if (summary.created) await audit(db, { actorId, entity: 'lead', entityId: null, action: 'IMPORT_LEADS', after: summary });
  return { summary, rows: out, invalid };
}

leadsRouter.post('/import', requireLeader, upload.single('file'), async (req, res) => {
  const u = me(req);
  const { dryRun } = parse(z.object({ dryRun: z.enum(['true', 'false']).default('true') }), req.query);
  if (!req.file) throw new AppError(400, 'BAD_FILE', 'Fayl tanlanmagan');
  if (!/\.xlsx$/i.test(req.file.originalname)) throw new AppError(400, 'BAD_FILE', 'Faqat .xlsx fayl');
  const rows = await xlsxToRows(req.file.buffer);
  const run = (db: Db) => importLeads(db, rows, u.id);
  res.json({ dryRun: dryRun === 'true', ...(dryRun === 'true' ? await dryTx(run) : await tx(run)) });
});

// ---------- Qo'lda qo'shish (rahbar va operator): boshqa saytlardan topilgan yangi firma ----------
leadsRouter.post('/', async (req, res) => {
  const u = me(req);
  const body = parse(
    z.object({
      name: z.string().trim().min(1, 'Korxona nomini kiriting').max(300),
      director: z.string().trim().max(200).nullable().optional(),
      phone: z.string().trim().min(1, 'Telefon raqamini kiriting').max(200),
      stir: z.string().trim().max(20).nullable().optional(),
    }),
    req.body,
  );
  const stir = body.stir ? normalizeStir(body.stir) : null;
  if (stir && !/^(\d{9}|\d{14})$/.test(stir)) throw new AppError(400, 'BAD_STIR', 'STIR 9 yoki 14 xonali bo\'lishi kerak');
  const phones = [...new Set(body.phone.split(',').map((p) => normalizePhone(p)).filter((p): p is string => !!p))];
  if (!phones.length || phones.some((p) => p.replace(/\D/g, '').length < 9)) throw new AppError(400, 'BAD_PHONE', 'Telefon raqami to\'liq emas');
  const lead = await tx(async (db) => {
    if (stir) {
      if (await one(db, 'SELECT 1 FROM client WHERE stir = $1', [stir])) throw new AppError(409, 'EXISTING_CLIENT', 'Bu STIR bilan firma allaqachon mijozimiz');
      if (await one(db, 'SELECT 1 FROM lead WHERE stir = $1', [stir])) throw new AppError(409, 'EXISTING_LEAD', 'Bu STIR bilan firma nomzodlar ro\'yxatida bor');
    }
    // Shu raqam bilan nomzod yoki mijoz bor bo'lsa — takror kiritilmaydi (operator bir firmaga ikki marta qo'ng'iroq qilmasin)
    const keys = phones.join(', ');
    const client = await one<{ name: string }>(db, `SELECT name FROM client WHERE deleted_at IS NULL AND fn_phone_keys(phone) && fn_phone_keys($1) LIMIT 1`, [keys]);
    if (client) throw new AppError(409, 'EXISTING_CLIENT', `Bu raqam mijozimizga tegishli: ${client.name}`);
    const dup = await one<{ name: string }>(db, `SELECT name FROM lead WHERE fn_phone_keys(phone) && fn_phone_keys($1) LIMIT 1`, [keys]);
    if (dup) throw new AppError(409, 'EXISTING_LEAD', `Bu raqam bilan nomzod bor: ${dup.name}`);
    const ins = await one<{ id: number }>(
      db,
      `INSERT INTO lead (stir, name, name_normalized, director, phone, source, imported_by)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL', $6) RETURNING id`,
      [stir, body.name, normalizeName(body.name), body.director || null, phones.join(', '), u.id],
    );
    await audit(db, { actorId: u.id, entity: 'lead', entityId: ins!.id, action: 'CREATE', after: { name: body.name, director: body.director || null, phone: phones.join(', '), stir } });
    return loadLead(db, ins!.id, u);
  });
  res.status(201).json(lead);
});

// ---------- Bitta firma ----------
leadsRouter.get('/:id', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const lead = await loadLead(pool, id, u);
  const calls = await q(
    pool,
    `SELECT c.id, c.result, c.comment, c.next_call_date AS "nextCallDate", c.created_at AS "createdAt", u.full_name AS "userName"
     FROM lead_call c JOIN app_user u ON u.id = c.user_id WHERE c.lead_id = $1 ORDER BY c.created_at DESC, c.id DESC`,
    [id],
  );
  res.json({ ...lead, calls });
});

/** Operator raqam topib kiritadi (fayldagi firmalarning ko'pida telefon yo'q), direktor/manzilni tuzatadi */
leadsRouter.patch('/:id', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const body = parse(
    z.object({
      phone: z.string().trim().max(200).nullable().optional(),
      director: z.string().trim().max(200).nullable().optional(),
      address: z.string().trim().max(500).nullable().optional(),
    }),
    req.body,
  );
  const lead = await tx(async (db) => {
    const before = await loadLead(db, id, u, true);
    await db.query(
      `UPDATE lead SET phone = CASE WHEN $2 THEN $3 ELSE phone END, director = CASE WHEN $4 THEN $5 ELSE director END,
         address = CASE WHEN $6 THEN $7 ELSE address END WHERE id = $1`,
      [id, body.phone !== undefined, body.phone || null, body.director !== undefined, body.director || null, body.address !== undefined, body.address || null],
    );
    const d = diff(before, body);
    if (d.changed) await audit(db, { actorId: u.id, entity: 'lead', entityId: id, action: 'UPDATE', before: d.before, after: d.after });
    return loadLead(db, id, u);
  });
  res.json(lead);
});

/** Rahbar: nomzodni butunlay o'chiradi (qo'ng'iroq natijalari CASCADE bilan). Mijozga aylantirilgani o'chirilmaydi — mijoz tarixi */
leadsRouter.delete('/:id', requireLeader, async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  await tx(async (db) => {
    const lead = await loadLead(db, id, u, true);
    if (lead.status === 'CONVERTED') throw new AppError(409, 'LEAD_CONVERTED', 'Firma allaqachon mijozga aylantirilgan');
    await db.query('DELETE FROM lead WHERE id = $1', [id]);
    await audit(db, {
      actorId: u.id,
      entity: 'lead',
      entityId: id,
      action: 'DELETE',
      before: { name: lead.name, stir: lead.stir, director: lead.director, phone: lead.phone, status: lead.status, callCount: lead.callCount },
    });
  });
  res.status(204).end();
});

/** Qo'ng'iroq natijasi: lead holati shu natijaga o'tadi. "Mijoz bo'ldi" (WON) — rahbarlarga xabar, operatordan yopiladi */
leadsRouter.post('/:id/calls', async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const body = parse(
    z.object({
      result: z.enum(RESULTS),
      comment: z.string().trim().max(2000).nullable().optional(),
      nextCallDate: isoDate.nullable().optional(),
    }),
    req.body,
  );
  if (NEEDS_DATE.includes(body.result) && !body.nextCallDate) {
    throw new AppError(400, 'NEXT_CALL_REQUIRED', 'Keyingi qo\'ng\'iroq kunini tanlang');
  }
  // Yopiq natijalarda keyingi qo'ng'iroq bo'lmaydi
  const next = (OPEN as readonly string[]).includes(body.result) ? (body.nextCallDate ?? null) : null;
  if (next && next < today()) throw new AppError(400, 'NEXT_CALL_PAST', 'Keyingi qo\'ng\'iroq kuni o\'tib ketgan');
  const lead = await tx(async (db) => {
    const before = await loadLead(db, id, u, true);
    if (before.status === 'CONVERTED') throw new AppError(409, 'LEAD_CONVERTED', 'Firma allaqachon mijozga aylantirilgan');
    await db.query(
      `INSERT INTO lead_call (lead_id, user_id, result, comment, next_call_date) VALUES ($1, $2, $3, $4, $5)`,
      [id, u.id, body.result, body.comment || null, next],
    );
    await db.query(
      `UPDATE lead SET status = $2::text, next_call_date = $3, last_call_at = now(),
         transferred_at = CASE WHEN $2::text = 'WON' THEN now() END WHERE id = $1`,
      [id, body.result, next],
    );
    await audit(db, {
      actorId: u.id,
      entity: 'lead',
      entityId: id,
      action: 'CALL',
      before: { status: before.status, nextCallDate: before.nextCallDate },
      after: { status: body.result, nextCallDate: next, comment: body.comment || null },
    });
    if (body.result === 'WON' && before.status !== 'WON') {
      await notifyLeaders(db, {
        kind: 'LEAD_WON',
        payload: { leadId: id, leadName: before.name, stir: before.stir, actorName: u.fullName, comment: body.comment || null },
        exceptUserId: u.id,
      });
    }
    return one(db, `SELECT ${LEAD} FROM lead l WHERE l.id = $1`, [id]);
  });
  res.status(201).json(lead);
});

/** Rahbar: firmani mijozga aylantiradi (soliq turi, buxgalter tanlanadi). Shu oydan vazifalar odatdagidek chiqadi */
leadsRouter.post('/:id/convert', requireLeader, async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const input = parse(clientInput, req.body);
  const clientId = await tx(async (db) => {
    const lead = await loadLead(db, id, u, true);
    if (lead.status === 'CONVERTED') throw new AppError(409, 'LEAD_CONVERTED', 'Firma allaqachon mijozga aylantirilgan');
    // Bo'limlar «Mijozlar»dagi kabi (V51): Hisobot topshirishda har doim, Buxgalter ishlarida — rahbar tanlasa
    const cid = await createClient(db, { ...input, inReports: true, inWorks: input.inWorks ?? false }, u.id);
    await db.query(
      `UPDATE lead SET status = 'CONVERTED', next_call_date = NULL, converted_client_id = $2,
         transferred_at = coalesce(transferred_at, now()) WHERE id = $1`,
      [id, cid],
    );
    await audit(db, { actorId: u.id, entity: 'lead', entityId: id, clientId: cid, action: 'CONVERT', before: { status: lead.status }, after: { status: 'CONVERTED', clientId: cid } });
    return cid;
  });
  res.status(201).json({ clientId });
});
