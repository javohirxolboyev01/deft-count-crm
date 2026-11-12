import crypto from 'node:crypto';
import express, { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { type AuthUser, isLeader, me, requireAuth, requireLeader, requireRole, requireStaff } from '../common/auth';
import { AppError, notFound, parse } from '../common/errors';
import { normalizeName } from '../common/normalize';
import { nowTz } from '../common/time';
import { config } from '../config';
import { type Db, one, pool, q, tx } from '../db';
import { loadClientForUser } from './clients';
import { CHAT_FILE_MAX_BYTES, downloadFromTelegram, uploadToTelegram } from './telegramStorage';

// IP telefoniya qo'ng'iroqlar jurnali (V46, rahbar tasdiqlagan "a" variant: jurnal + statistika, CRM'dan qo'ng'iroq yo'q).
// Ofisdagi Asterisk CDR'ni faylga (cdr_csv) yozadi; pbx-agent yangi qatorlarni shu yerga yuboradi.
// Yo'nalish, xodim va tashqi raqamni server aniqlaydi; mijoz/lead o'qishda telefon bo'yicha topiladi (fn_phone_keys).

/** cdr_csv ustunlari (agent nom bilan yuboradi) */
const cdrFields = z.object({
  accountcode: z.string().optional(),
  src: z.string().default(''),
  dst: z.string().default(''),
  dcontext: z.string().optional(),
  clid: z.string().optional(),
  channel: z.string().default(''),
  dstchannel: z.string().default(''),
  lastapp: z.string().optional(),
  lastdata: z.string().optional(),
  start: z.string(),
  answer: z.string().default(''),
  end: z.string().default(''),
  duration: z.string().default('0'),
  billsec: z.string().default('0'),
  disposition: z.string().default(''),
  amaflags: z.string().optional(),
  uniqueid: z.string().optional(),
  userfield: z.string().optional(),
});
export type CdrFields = z.infer<typeof cdrFields>;

const ingestBody = z.object({
  records: z
    .array(z.object({ key: z.string().min(8).max(128), fields: cdrFields }))
    .max(500),
});

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
/** Tashqi raqam: kamida 7 raqam (ichki raqamlar 2–5 xonali) */
const isExternal = (s: string) => digits(s).length >= 7;
const looksLikeExt = (s: string) => /^\d{2,5}$/.test(s);
/** 'PJSIP/101-0000002a' / 'SIP/101-..' / 'Local/101@from-internal-..;1' -> '101' */
export function channelPeer(ch: string): string | null {
  const m = ch.match(/^(?:PJSIP|SIP|IAX2|Local)\/([^-/@;]+)/i);
  return m ? m[1] : null;
}

export interface ResolvedCall {
  direction: 'IN' | 'OUT' | 'INTERNAL' | 'UNKNOWN';
  ext: string | null;
  peerExt: string | null;
  externalNumber: string | null;
}

/**
 * CDR qatoridan yo'nalish va ichki raqam. Avval xodimlarga biriktirilgan ichki raqamlar (knownExts) qidiriladi,
 * keyin "qisqa raqam" qoidasi — raqam hali biriktirilmagan bo'lsa ham to'g'ri yo'nalish yoziladi.
 */
export function resolveCall(f: Pick<CdrFields, 'src' | 'dst' | 'channel' | 'dstchannel'>, knownExts: Set<string>): ResolvedCall {
  const pick = (cands: (string | null)[]) =>
    cands.find((c): c is string => !!c && knownExts.has(c)) ?? cands.find((c): c is string => !!c && looksLikeExt(c)) ?? null;
  const srcExt = pick([channelPeer(f.channel), f.src]);
  const dstExt = pick([channelPeer(f.dstchannel), f.dst]);
  const srcOut = isExternal(f.src) ? f.src : null;
  const dstOut = isExternal(f.dst) ? f.dst : null;
  const key = (n: string) => digits(n).slice(-9);

  if (srcOut) return { direction: 'IN', ext: dstExt, peerExt: null, externalNumber: key(srcOut) };
  if (dstOut) return { direction: 'OUT', ext: srcExt, peerExt: null, externalNumber: key(dstOut) };
  if (srcExt && dstExt) return { direction: 'INTERNAL', ext: srcExt, peerExt: dstExt, externalNumber: null };
  return { direction: 'UNKNOWN', ext: srcExt ?? dstExt, peerExt: null, externalNumber: null };
}

/** 'YYYY-MM-DD HH:mm:ss' (CDR zonasida) -> ISO; bo'sh -> null */
function cdrTime(s: string): string | null {
  if (!s.trim()) return null;
  const d = DateTime.fromFormat(s.trim(), 'yyyy-MM-dd HH:mm:ss', { zone: config.pbx.cdrTimezone });
  return d.isValid ? d.toISO() : null;
}

const toInt = (s: string) => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function tokenOk(req: Request) {
  const expected = config.pbx.ingestToken;
  const h = req.headers.authorization;
  const got = h?.startsWith('Bearer ') ? h.slice(7) : '';
  if (!expected || !got) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function ingestCalls(db: Db, records: z.infer<typeof ingestBody>['records']) {
  const users = await q<{ id: number; ext: string }>(
    db,
    `SELECT id, phone_ext AS ext FROM app_user WHERE phone_ext IS NOT NULL AND deleted_at IS NULL`,
  );
  const byExt = new Map(users.map((u) => [u.ext, u.id]));
  const known = new Set(byExt.keys());
  let inserted = 0;
  let skipped = 0;
  for (const { key, fields: f } of records) {
    const started = cdrTime(f.start);
    if (!started) {
      skipped++;
      continue;
    }
    const r = resolveCall(f, known);
    const res = await db.query(
      `INSERT INTO call_log (source_key, uniqueid, direction, src, dst, external_number, ext, user_id, peer_ext, peer_user_id,
                             started_at, answered_at, ended_at, duration_sec, billsec, disposition, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (source_key) DO NOTHING`,
      [
        key,
        f.uniqueid || null,
        r.direction,
        f.src || null,
        f.dst || null,
        r.externalNumber,
        r.ext,
        r.ext ? (byExt.get(r.ext) ?? null) : null,
        r.peerExt,
        r.peerExt ? (byExt.get(r.peerExt) ?? null) : null,
        started,
        cdrTime(f.answer),
        cdrTime(f.end),
        toInt(f.duration),
        toInt(f.billsec),
        f.disposition.trim().toUpperCase() || 'UNKNOWN',
        JSON.stringify(f),
      ],
    );
    if (res.rowCount) inserted++;
    else skipped++;
  }
  // Agent tirikligi (rahbar sozlamada ko'radi): bo'sh paket ham "aloqa bor" degani
  await db.query(
    `INSERT INTO setting (key, value) VALUES ('pbx.last_seen', to_jsonb(now()))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  return { inserted, skipped };
}

/** Xodimga ichki raqam biriktirilganda: shu raqamdagi egasiz qo'ng'iroqlar unga yoziladi (users.ts) */
export async function backfillCallUser(db: Db, userId: number, ext: string) {
  await db.query(`UPDATE call_log SET user_id = $1 WHERE ext = $2 AND user_id IS NULL`, [userId, ext]);
  await db.query(`UPDATE call_log SET peer_user_id = $1 WHERE peer_ext = $2 AND peer_user_id IS NULL`, [userId, ext]);
}

// ---------- O'qish ----------

const CALL = `cl.id, cl.direction, cl.src, cl.dst, cl.external_number AS "externalNumber", cl.ext,
  cl.user_id AS "userId", u.full_name AS "userName", cl.peer_user_id AS "peerUserId", pu.full_name AS "peerUserName",
  cl.started_at AS "startedAt", cl.answered_at AS "answeredAt", cl.duration_sec AS "durationSec", cl.billsec,
  cl.disposition, rec.id AS "recordingId", rec.size_bytes AS "recordingBytes"`;
const CALL_FROM = `call_log cl
  LEFT JOIN app_user u ON u.id = cl.user_id
  LEFT JOIN app_user pu ON pu.id = cl.peer_user_id
  LEFT JOIN LATERAL (SELECT r.id, r.size_bytes FROM call_recording r
                     WHERE cl.uniqueid IS NOT NULL AND r.uniqueid = cl.uniqueid ORDER BY r.id LIMIT 1) rec ON true`;
/** Ro'yxatda tashqi raqamga mos mijoz va lead (bittadan) */
const MATCH = `
  LEFT JOIN LATERAL (SELECT c.id, c.name, c.accountant_id FROM client c
                     WHERE cl.external_number IS NOT NULL AND fn_phone_keys(c.phone) @> ARRAY[cl.external_number]
                     ORDER BY c.id LIMIT 1) mc ON true
  LEFT JOIN LATERAL (SELECT l.id, l.name, l.status FROM lead l
                     WHERE cl.external_number IS NOT NULL AND fn_phone_keys(l.phone) @> ARRAY[cl.external_number]
                     ORDER BY l.id LIMIT 1) ml ON true`;
const MATCH_COLS = `mc.id AS "mcId", mc.name AS "mcName", mc.accountant_id AS "mcAcc", ml.id AS "mlId", ml.name AS "mlName", ml.status AS "mlStatus"`;

/** Audio yozuv faqat rahbarga (rahbar qarori, V48): boshqalarga yozuv borligi ham ko'rsatilmaydi */
function stripRecording(u: AuthUser, row: Record<string, any>) {
  if (isLeader(u)) return row;
  const { recordingId: _r, recordingBytes: _b, ...rest } = row;
  return rest;
}

/** Mos mijoz/lead faqat ko'rishga ruxsati bo'lganga (CLAUDE.md 4: buxgalter o'z mijozi, lead — rahbar/operator) */
function present(u: AuthUser, row: Record<string, any>) {
  const { mcId, mcName, mcAcc, mlId, mlName, mlStatus, ...rest } = stripRecording(u, row);
  const seeClient = mcId && u.role !== 'OPERATOR' && (isLeader(u) || mcAcc === u.id);
  const seeLead = mlId && (isLeader(u) || (u.role === 'OPERATOR' && !['WON', 'CONVERTED'].includes(mlStatus)));
  return {
    ...rest,
    client: seeClient ? { id: mcId, name: mcName } : null,
    lead: seeLead ? { id: mlId, name: mlName } : null,
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD');
const range = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
function rangeOf(f: z.infer<typeof range>) {
  const today = nowTz();
  return {
    from: f.from ?? today.startOf('month').toISODate()!,
    to: f.to ?? today.toISODate()!,
  };
}

export const callsRouter = Router();

// Agent: Bearer PBX_INGEST_TOKEN (xodim JWT emas). Token sozlanmagan bo'lsa endpoint "yo'q"
callsRouter.post('/ingest', async (req, res) => {
  if (!config.pbx.ingestToken) throw notFound('Endpoint');
  if (!tokenOk(req)) throw new AppError(401, 'UNAUTHORIZED', 'Token noto\'g\'ri');
  const body = parse(ingestBody, req.body);
  res.json(await tx((db) => ingestCalls(db, body.records)));
});

// Audio yozuv (V48): tana — faylning o'zi (Content-Type audio/*), X-Source-Path — ombordagi nisbiy yo'l (URL-kodlangan).
// Telegram yuklash chegarasi 50 MB; ilovada eshitish 20 MB gacha (getFile), kattasi kanalda saqlanadi.
const RECORDING_MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_MIME = /^audio\/[a-z0-9.+-]+$/i;

/** Asterisk UNIQUEID ('1762750800.123') fayl nomidan: oxirgi moslik */
export function uniqueidFromName(name: string): string | null {
  const m = name.match(/\d{9,11}\.\d+/g);
  return m ? m[m.length - 1] : null;
}

callsRouter.post('/recordings', express.raw({ type: () => true, limit: RECORDING_MAX_BYTES }), async (req, res) => {
  if (!config.pbx.ingestToken) throw notFound('Endpoint');
  if (!tokenOk(req)) throw new AppError(401, 'UNAUTHORIZED', 'Token noto\'g\'ri');
  const sourcePath = parse(z.string().min(1).max(500), decodeURIComponent(String(req.headers['x-source-path'] ?? '')));
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_MIME.test(mime)) throw new AppError(400, 'BAD_FILE', 'Faqat audio fayl');
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new AppError(400, 'BAD_FILE', 'Fayl bo\'sh');
  const dup = await one(pool, 'SELECT id FROM call_recording WHERE source_path = $1', [sourcePath]);
  if (dup) return res.json({ id: dup.id, duplicate: true });
  // Agent WAV'ni OGG'ga siqsa nomi o'zgaradi (X-File-Name); takrordan himoya asl yo'l bo'yicha
  const fileName =
    parse(z.string().max(255), decodeURIComponent(String(req.headers['x-file-name'] ?? ''))).split('/').pop() ||
    sourcePath.split('/').pop()!;
  const uniqueid = (req.headers['x-uniqueid'] ? String(req.headers['x-uniqueid']) : null) || uniqueidFromName(fileName);
  // Kanal faqat rahbarlar uchun: izohda fayl nomi (sana, raqam) — kanalda ham qidirib topiladi
  const stored = await uploadToTelegram(buf, fileName, mime, fileName.slice(0, 1000), undefined, config.telegram.callsChatId);
  const row = await one(
    pool,
    `INSERT INTO call_recording (source_path, uniqueid, file_name, mime, size_bytes, tg_file_id, tg_file_unique_id, tg_chat_id, tg_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_path) DO NOTHING RETURNING id`,
    [sourcePath, uniqueid, fileName, mime, buf.length, stored.fileId, stored.fileUniqueId, stored.chatId, stored.messageId],
  );
  res.json({ id: row?.id ?? null, duplicate: !row });
});

callsRouter.use(requireAuth);

// Eshitish: faqat rahbar
callsRouter.get('/recordings/:id', requireLeader, async (req, res) => {
  const id = parse(z.coerce.number().int(), req.params.id);
  const r = await one<{ mime: string; file_name: string; size_bytes: number; tg_file_id: string }>(
    pool,
    'SELECT mime, file_name, size_bytes, tg_file_id FROM call_recording WHERE id = $1',
    [id],
  );
  if (!r) throw notFound('Yozuv');
  if (r.size_bytes > CHAT_FILE_MAX_BYTES) {
    throw new AppError(409, 'RECORDING_TOO_LARGE', 'Yozuv 20 MB dan katta: Telegram kanalida oching');
  }
  const buf = await downloadFromTelegram(r.tg_file_id);
  res.setHeader('Content-Type', r.mime);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.file_name)}`);
  res.end(buf);
});

// Jurnal: rahbar hammasini (filtr bilan), boshqa xodim faqat o'z qo'ng'iroqlarini
callsRouter.get('/', async (req, res) => {
  const u = me(req);
  const f = parse(
    range.extend({
      userId: z.union([z.coerce.number().int(), z.literal('none')]).optional(),
      direction: z.enum(['IN', 'OUT', 'INTERNAL', 'UNKNOWN']).optional(),
      missed: z.enum(['true', 'false']).optional(),
      search: z.string().trim().optional(),
      company: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const { from, to } = rangeOf(f);
  const params: unknown[] = [from, to];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [`cl.started_at >= $1::date`, `cl.started_at < $2::date + 1`];
  if (!isLeader(u)) where.push(`(cl.user_id = ${p(u.id)} OR cl.peer_user_id = $${params.length})`);
  else if (f.userId === 'none') where.push('cl.user_id IS NULL');
  else if (f.userId) where.push(`(cl.user_id = ${p(f.userId)} OR cl.peer_user_id = $${params.length})`);
  if (f.direction) where.push(`cl.direction = ${p(f.direction)}`);
  if (f.missed === 'true') where.push(`cl.disposition <> 'ANSWERED'`);
  if (f.search && digits(f.search)) where.push(`cl.external_number LIKE ${p(`%${digits(f.search).slice(-9)}%`)}`);
  // Firma nomi bo'yicha: telefoni shu qo'ng'iroq raqamiga mos mijoz/lead (o'qishda, fn_phone_keys). Qidiruv doirasi
  // jurnaldagi "Kim (mijoz)" ko'rinishi bilan bir xil (present): rahbar — hammasi, buxgalter — o'z mijozlari, operator — lidlar
  if (f.company) {
    const like = p(`%${f.company.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const norm = p(`%${normalizeName(f.company)}%`);
    const conds: string[] = [];
    if (u.role !== 'OPERATOR') {
      conds.push(`EXISTS (SELECT 1 FROM client c WHERE (c.name ILIKE ${like} OR c.name_normalized LIKE ${norm})
        AND fn_phone_keys(c.phone) @> ARRAY[cl.external_number] ${isLeader(u) ? '' : `AND c.accountant_id = ${p(u.id)}`})`);
    }
    if (isLeader(u) || u.role === 'OPERATOR') {
      conds.push(`EXISTS (SELECT 1 FROM lead l WHERE (l.name ILIKE ${like} OR l.name_normalized LIKE ${norm})
        AND fn_phone_keys(l.phone) @> ARRAY[cl.external_number] ${isLeader(u) ? '' : `AND l.status NOT IN ('WON', 'CONVERTED')`})`);
    }
    where.push(`cl.external_number IS NOT NULL AND (${conds.join(' OR ')})`);
  }
  const w = where.join(' AND ');
  const total = (await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM call_log cl WHERE ${w}`, params))!.n;
  const rows = await q(
    pool,
    `SELECT ${CALL}, ${MATCH_COLS} FROM ${CALL_FROM} ${MATCH} WHERE ${w}
     ORDER BY cl.started_at DESC, cl.id DESC LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`,
    params,
  );
  res.json({ items: rows.map((r) => present(u, r)), total, page: f.page, pageSize: f.pageSize, from, to });
});

// Xodimlar bo'yicha statistika (rahbar)
callsRouter.get('/stats', requireLeader, async (req, res) => {
  const { from, to } = rangeOf(parse(range, req.query));
  const rows = await q(
    pool,
    `SELECT cl.user_id AS "userId", u.full_name AS "userName", u.phone_ext AS ext,
            count(*)::int AS total,
            count(*) FILTER (WHERE cl.direction = 'OUT')::int AS outgoing,
            count(*) FILTER (WHERE cl.direction = 'OUT' AND cl.disposition = 'ANSWERED')::int AS "outgoingAnswered",
            count(*) FILTER (WHERE cl.direction = 'IN')::int AS incoming,
            count(*) FILTER (WHERE cl.direction = 'IN' AND cl.disposition <> 'ANSWERED')::int AS missed,
            count(*) FILTER (WHERE cl.direction = 'INTERNAL')::int AS internal,
            count(*) FILTER (WHERE cl.disposition = 'ANSWERED')::int AS answered,
            coalesce(sum(cl.billsec), 0)::int AS "talkSec"
     FROM call_log cl LEFT JOIN app_user u ON u.id = cl.user_id
     WHERE cl.started_at >= $1::date AND cl.started_at < $2::date + 1
     GROUP BY cl.user_id, u.full_name, u.phone_ext
     ORDER BY (cl.user_id IS NULL), u.full_name`,
    [from, to],
  );
  // Grafiklar uchun (rahbar analitikasi): kunlar va hafta kuni × soat kesimida. Vaqt — sessiya zonasi (Asia/Tashkent)
  const daily = await q(
    pool,
    `SELECT to_char(cl.started_at::date, 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE cl.direction = 'OUT')::int AS outgoing,
            count(*) FILTER (WHERE cl.direction = 'IN' AND cl.disposition = 'ANSWERED')::int AS "incomingAnswered",
            count(*) FILTER (WHERE cl.direction = 'IN' AND cl.disposition <> 'ANSWERED')::int AS missed,
            count(*) FILTER (WHERE cl.direction = 'INTERNAL')::int AS internal,
            coalesce(sum(cl.billsec), 0)::int AS "talkSec"
     FROM call_log cl
     WHERE cl.started_at >= $1::date AND cl.started_at < $2::date + 1
     GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  // Faqat tashqi qo'ng'iroqlar (mijoz/lead bilan): ichki suhbatlar yuklama xaritasini buzmasin
  const hourly = await q(
    pool,
    `SELECT extract(isodow FROM cl.started_at)::int AS dow, extract(hour FROM cl.started_at)::int AS hour,
            count(*)::int AS total,
            count(*) FILTER (WHERE cl.direction = 'IN' AND cl.disposition <> 'ANSWERED')::int AS missed
     FROM call_log cl
     WHERE cl.started_at >= $1::date AND cl.started_at < $2::date + 1 AND cl.direction IN ('IN', 'OUT')
     GROUP BY 1, 2`,
    [from, to],
  );
  res.json({ from, to, rows, daily, hourly });
});

// Ulanish holati (rahbar, sozlamada): agent oxirgi marta qachon yozdi, qaysi ichki raqamlar xodimga biriktirilmagan
callsRouter.get('/status', requireLeader, async (_req, res) => {
  const seen = await one<{ value: string }>(pool, `SELECT value #>> '{}' AS value FROM setting WHERE key = 'pbx.last_seen'`);
  const last = await one<{ at: string | null; total: number }>(pool, `SELECT max(started_at) AS at, count(*)::int AS total FROM call_log`);
  const unassigned = await q(
    pool,
    `SELECT ext, count(*)::int AS calls, max(started_at) AS "lastAt" FROM call_log
     WHERE ext IS NOT NULL AND user_id IS NULL GROUP BY ext ORDER BY count(*) DESC LIMIT 50`,
  );
  res.json({
    enabled: !!config.pbx.ingestToken,
    lastSeenAt: seen?.value ?? null,
    lastCallAt: last?.at ?? null,
    total: last?.total ?? 0,
    unassignedExts: unassigned,
  });
});

async function callsByPhone(u: AuthUser, phone: string | null, limit: number) {
  const rows = await q(
    pool,
    `SELECT ${CALL} FROM ${CALL_FROM}
     WHERE cl.external_number = ANY(fn_phone_keys($1)) ORDER BY cl.started_at DESC, cl.id DESC LIMIT $2`,
    [phone, limit],
  );
  const stats = await one(
    pool,
    `SELECT count(*)::int AS total, coalesce(sum(billsec), 0)::int AS "talkSec", max(started_at) AS "lastAt"
     FROM call_log WHERE external_number = ANY(fn_phone_keys($1))`,
    [phone],
  );
  return { phone, items: rows.map((r) => stripRecording(u, r)), ...stats };
}

const limitQ = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

// Mijoz kartasi: buxgalter faqat o'z mijozi (loadClientForUser), operatorga yopiq
callsRouter.get('/client/:id', requireStaff, async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const { limit } = parse(limitQ, req.query);
  const c = await loadClientForUser(pool, id, u);
  res.json(await callsByPhone(u, c.phone ?? null, limit));
});

// Lead: rahbar va operator (mijozga o'tgan lead operatorga "yo'q", leads.ts bilan bir xil)
callsRouter.get('/lead/:id', requireRole('LEADER', 'OPERATOR'), async (req, res) => {
  const u = me(req);
  const id = parse(z.coerce.number().int(), req.params.id);
  const { limit } = parse(limitQ, req.query);
  const l = await one<{ phone: string | null }>(
    pool,
    `SELECT phone FROM lead WHERE id = $1 ${isLeader(u) ? '' : `AND status NOT IN ('WON', 'CONVERTED')`}`,
    [id],
  );
  if (!l) throw notFound('Firma');
  res.json(await callsByPhone(u, l.phone, limit));
});
