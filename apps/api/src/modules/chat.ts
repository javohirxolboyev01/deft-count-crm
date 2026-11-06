import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { me, requireAuth } from '../common/auth';
import { AppError, forbidden, notFound, parse } from '../common/errors';
import { one, pool, q } from '../db';
import { emitToUser } from './events';
import { CHAT_FILE_MAX_BYTES, downloadFromTelegram, rememberUploaded, storageEnabled, uploadToTelegram } from './telegramStorage';

// Ichki chat: barcha rollar (rahbar, buxgalter, operator) bir-biri bilan 1:1 yozishadi.
// Real vaqt — mavjud SSE oqimi orqali (`chat-message`, `chat-read` hodisalari); xabar Telegram'ga yuborilmaydi.
// Fayllar (V43) Telegram yopiq kanalida saqlanadi — u faqat ombor, xodimlarga u yerdan hech narsa bormaydi.
export const chatRouter = Router();
chatRouter.use(requireAuth);

const ATTACHMENT = `CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
  'id', a.id, 'kind', a.kind, 'mime', a.mime, 'fileName', a.file_name, 'sizeBytes', a.size_bytes,
  'durationSec', a.duration_sec, 'width', a.width, 'height', a.height, 'waveform', a.waveform) END`;
const MSG = `m.id, m.sender_id AS "senderId", m.recipient_id AS "recipientId", m.body, m.created_at AS "createdAt",
             m.read_at AS "readAt", m.edited_at AS "editedAt", ${ATTACHMENT} AS attachment`;
const MSG_FROM = 'chat_message m LEFT JOIN chat_attachment a ON a.message_id = m.id';

const getMessage = (id: number) => one(pool, `SELECT ${MSG} FROM ${MSG_FROM} WHERE m.id = $1`, [id]);

const userId = (v: unknown) => parse(z.coerce.number().int().positive(), v);

/** Suhbatdoshlar: faol xodimlar (+ yozishmasi bor faolsizlantirilganlar), oxirgi xabar va o'qilmaganlar soni bilan */
chatRouter.get('/contacts', async (req, res) => {
  const u = me(req);
  const items = await q(
    pool,
    `WITH mine AS (
       SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other, m.*
       FROM chat_message m WHERE (sender_id = $1 OR recipient_id = $1) AND deleted_at IS NULL
     ), last AS (
       SELECT DISTINCT ON (other) other, mine.id, mine.body, mine.sender_id, mine.created_at, mine.read_at, a.kind AS attachment_kind
       FROM mine LEFT JOIN chat_attachment a ON a.message_id = mine.id ORDER BY other, mine.id DESC
     ), unread AS (
       SELECT sender_id AS other, count(*) AS n FROM chat_message
       WHERE recipient_id = $1 AND read_at IS NULL AND deleted_at IS NULL GROUP BY sender_id
     )
     SELECT u.id, u.full_name AS "fullName", u.role, u.active,
            coalesce(un.n, 0) AS unread,
            CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object(
              'id', l.id, 'body', l.body, 'senderId', l.sender_id, 'createdAt', l.created_at, 'readAt', l.read_at,
              'attachmentKind', l.attachment_kind
            ) END AS "lastMessage"
     FROM app_user u
     LEFT JOIN last l ON l.other = u.id
     LEFT JOIN unread un ON un.other = u.id
     WHERE u.id <> $1 AND (u.active OR l.id IS NOT NULL)
     ORDER BY l.id DESC NULLS LAST, u.full_name`,
    [u.id],
  );
  res.json(items);
});

/** Chatda fayl yuborish mumkinmi (Telegram ombori sozlanganmi) va chegara */
chatRouter.get('/config', (_req, res) => {
  res.json({ attachments: storageEnabled(), maxFileBytes: CHAT_FILE_MAX_BYTES });
});

chatRouter.get('/unread-count', async (req, res) => {
  const r = await one<{ n: number; chats: number }>(
    pool,
    `SELECT count(*) AS n, count(DISTINCT sender_id) AS chats FROM chat_message
     WHERE recipient_id = $1 AND read_at IS NULL AND deleted_at IS NULL`,
    [me(req).id],
  );
  res.json({ count: r!.n, chats: r!.chats });
});

/** Suhbat tarixi: eng yangisidan orqaga sahifalab (before = eng eski ko'rilgan xabar id'si) */
chatRouter.get('/with/:userId', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  const { before, limit } = parse(
    z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    req.query,
  );
  const rows = await q(
    pool,
    `SELECT ${MSG} FROM ${MSG_FROM}
     WHERE m.deleted_at IS NULL
       AND least(m.sender_id, m.recipient_id) = least($1::bigint, $2::bigint)
       AND greatest(m.sender_id, m.recipient_id) = greatest($1::bigint, $2::bigint)
       ${before ? 'AND m.id < $4' : ''}
     ORDER BY m.id DESC LIMIT $3`,
    before ? [u.id, other, limit + 1, before] : [u.id, other, limit + 1],
  );
  const hasMore = rows.length > limit;
  res.json({ items: rows.slice(0, limit).reverse(), hasMore });
});

async function assertRecipient(other: number, meId: number) {
  const target = await one<{ active: boolean }>(pool, 'SELECT active FROM app_user WHERE id = $1', [other]);
  if (!target?.active || other === meId) throw notFound('Foydalanuvchi');
}

function emitNew(msg: any, senderId: number, senderName: string) {
  const event = { ...msg, senderName };
  emitToUser(msg.recipientId, 'chat-message', event);
  // Yuboruvchining boshqa oynalari (tab) ham yangilansin
  emitToUser(senderId, 'chat-message', event);
}

chatRouter.post('/with/:userId', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  await assertRecipient(other, u.id);
  const ins = await one<{ id: number }>(
    pool,
    'INSERT INTO chat_message (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING id',
    [u.id, other, body],
  );
  const msg = await getMessage(ins!.id);
  emitNew(msg, u.id, u.fullName);
  res.status(201).json(msg);
});

// Ruxsat etilgan turlar (SVG/HTML yo'q — brauzerda skript bajarilmasin). MediaRecorder: Chrome — webm, Safari — mp4
// FILE (hujjat) — istalgan tur: brauzerda ochilmaydi, faqat yuklab olinadi
const KIND_MIMES: Record<string, string[] | null> = {
  FILE: null,
  IMAGE: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  VIDEO: ['video/mp4', 'video/webm', 'video/quicktime'],
  VIDEO_NOTE: ['video/mp4', 'video/webm'],
  VOICE: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/x-m4a', 'audio/aac'],
};
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg',
};
// Dumaloq video xabar Telegram'dagidek ko'pi bilan 60 soniya
const MAX_DURATION: Record<string, number> = { VIDEO_NOTE: 60, VOICE: 30 * 60 };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHAT_FILE_MAX_BYTES, files: 1 } });
const uploadOne = (req: any, res: any) =>
  new Promise<void>((resolve, reject) =>
    upload.single('file')(req, res, (err: any) => {
      if (err?.code === 'LIMIT_FILE_SIZE') {
        reject(new AppError(413, 'FILE_TOO_LARGE', 'Fayl juda katta', { maxBytes: CHAT_FILE_MAX_BYTES }));
      } else if (err) reject(new AppError(400, 'BAD_UPLOAD', err.message));
      else resolve();
    }),
  );

const optInt = z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().max(100_000).optional());

/** Fayl (rasm / video / ovozli / dumaloq video) + ixtiyoriy izoh. Fayl avval Telegram kanaliga, keyin bazaga */
chatRouter.post('/with/:userId/attachment', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  if (!storageEnabled()) throw new AppError(503, 'FILE_STORAGE_DISABLED', 'Fayl ombori sozlanmagan');
  await uploadOne(req, res);
  const file = req.file;
  if (!file?.size) throw new AppError(400, 'FILE_REQUIRED', 'Fayl tanlanmagan');
  const meta = parse(
    z.object({
      kind: z.enum(['IMAGE', 'VIDEO', 'VOICE', 'VIDEO_NOTE', 'FILE']),
      body: z.string().trim().max(4000).default(''),
      durationSec: optInt,
      width: optInt,
      height: optInt,
      // Ovozli xabar to'lqini: "3,10,31,..." (0..31, ≤ 100 ta)
      waveform: z
        .string()
        .regex(/^\d{1,2}(,\d{1,2}){0,99}$/)
        .transform((v) => v.split(',').map(Number))
        .refine((a) => a.every((n) => n <= 31))
        .optional(),
    }),
    req.body,
  );
  let mime = file.mimetype.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  // Brauzer turni buzib yuborsa (masalan, `codecs=a,b` dagi vergul tufayli text/plain) — kengaytmadan
  const byExt = EXT_MIME[file.originalname.split('.').pop()?.toLowerCase() ?? ''];
  if (meta.kind !== 'FILE' && byExt && (mime === 'text/plain' || mime === 'application/octet-stream')) mime = byExt;
  const allowed = KIND_MIMES[meta.kind];
  if (allowed && !allowed.includes(mime)) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Bu turdagi fayl qabul qilinmaydi', { mime, kind: meta.kind });
  }
  if (meta.durationSec && MAX_DURATION[meta.kind] && meta.durationSec > MAX_DURATION[meta.kind]) {
    throw new AppError(400, 'TOO_LONG', 'Yozuv juda uzun', { maxSec: MAX_DURATION[meta.kind] });
  }
  await assertRecipient(other, u.id);
  // multer nomni latin1 deb o'qiydi: kirill/o'zbekcha nomlar buzilmasin
  const fileName = Buffer.from(file.originalname || 'file', 'latin1').toString('utf8').slice(0, 200);
  // Kanaldagi izoh: faqat texnik belgi (ism va matn Telegram'ga yuborilmaydi)
  const stored = await uploadToTelegram(
    file.buffer,
    fileName,
    mime,
    `crm-chat ${meta.kind} u${u.id}→u${other}`,
    meta.kind === 'VIDEO_NOTE' ? { durationSec: meta.durationSec, length: meta.width } : undefined,
  );
  rememberUploaded(stored.fileId, file.buffer);

  const client = await pool.connect();
  let id: number;
  try {
    await client.query('BEGIN');
    const m = await one<{ id: number }>(
      client,
      'INSERT INTO chat_message (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING id',
      [u.id, other, meta.body],
    );
    id = m!.id;
    await client.query(
      `INSERT INTO chat_attachment (message_id, kind, mime, file_name, size_bytes, duration_sec, width, height,
                                    tg_file_id, tg_file_unique_id, tg_chat_id, tg_message_id, waveform)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, meta.kind, mime, fileName, file.size, meta.durationSec ?? null, meta.width ?? null, meta.height ?? null,
        stored.fileId, stored.fileUniqueId, stored.chatId, stored.messageId,
        meta.kind === 'VOICE' && meta.waveform ? meta.waveform : null],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const msg = await getMessage(id);
  emitNew(msg, u.id, u.fullName);
  res.status(201).json(msg);
});

/** Fayl mazmuni: faqat suhbat ishtirokchilariga, o'chirilgan xabarniki berilmaydi */
chatRouter.get('/files/:id', async (req, res) => {
  const u = me(req);
  const id = userId(req.params.id);
  const a = await one<{ kind: string; mime: string; file_name: string | null; tg_file_id: string }>(
    pool,
    `SELECT a.kind, a.mime, a.file_name, a.tg_file_id FROM chat_attachment a JOIN chat_message m ON m.id = a.message_id
     WHERE a.id = $1 AND m.deleted_at IS NULL AND (m.sender_id = $2 OR m.recipient_id = $2)`,
    [id, u.id],
  );
  if (!a) throw notFound('Fayl');
  const buf = await downloadFromTelegram(a.tg_file_id);
  const isFile = a.kind === 'FILE';
  // Hujjat brauzerda bajarilmasin (HTML/SVG ichidagi skript): faqat yuklab olish, sandbox
  res.setHeader('Content-Type', isFile ? 'application/octet-stream' : a.mime);
  if (isFile) res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Content-Length', String(buf.length));
  // Fayl o'zgarmaydi: brauzer qayta so'ramasin (private — umumiy proksi keshlamasin)
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `${isFile ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.file_name ?? 'file')}`);
  res.end(buf);
});

/** Suhbatdoshdan kelgan barcha xabarlarni o'qilgan qilish (suhbat ochilganda) */
chatRouter.post('/with/:userId/read', async (req, res) => {
  const u = me(req);
  const other = userId(req.params.userId);
  const r = await one<{ n: number; last: number | null }>(
    pool,
    `WITH upd AS (
       UPDATE chat_message SET read_at = now()
       WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL AND deleted_at IS NULL RETURNING id
     ) SELECT count(*) AS n, max(id) AS last FROM upd`,
    [u.id, other],
  );
  if (r!.n) {
    const event = { readerId: u.id, senderId: other, upToId: r!.last };
    emitToUser(other, 'chat-read', event); // yuboruvchida ✓✓
    emitToUser(u.id, 'chat-read', event); // o'z oynalarida badge kamayadi
  }
  res.json({ read: r!.n });
});

/** Faqat yuboruvchi o'z (o'chirilmagan) xabarini o'zgartiradi */
async function ownMessage(id: number, userId: number) {
  const m = await one<{ sender_id: number; recipient_id: number; has_file: boolean }>(
    pool,
    `SELECT sender_id, recipient_id, EXISTS (SELECT 1 FROM chat_attachment WHERE message_id = m.id) AS has_file
     FROM chat_message m WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!m || (m.sender_id !== userId && m.recipient_id !== userId)) throw notFound('Xabar');
  if (m.sender_id !== userId) throw forbidden();
  return m;
}

/** Ikkala tomonga: suhbat va ro'yxat qayta o'qiladi */
function emitUpdate(m: { sender_id: number; recipient_id: number }, data: unknown) {
  emitToUser(m.recipient_id, 'chat-update', data);
  emitToUser(m.sender_id, 'chat-update', data);
}

chatRouter.patch('/messages/:id', async (req, res) => {
  const u = me(req);
  const id = userId(req.params.id);
  const { body } = parse(z.object({ body: z.string().trim().max(4000) }), req.body);
  const m = await ownMessage(id, u.id);
  // Faylli xabarda izohni butunlay olib tashlash mumkin, matnli xabarda — yo'q
  if (!body && !m.has_file) parse(z.string().min(1), body);
  await pool.query(
    `UPDATE chat_message SET body = $2, edited_at = CASE WHEN body = $2 THEN edited_at ELSE now() END WHERE id = $1`,
    [id, body],
  );
  const msg = await getMessage(id);
  emitUpdate(m, { id, action: 'edit' });
  res.json(msg);
});

chatRouter.delete('/messages/:id', async (req, res) => {
  const u = me(req);
  const id = userId(req.params.id);
  const m = await ownMessage(id, u.id);
  await pool.query('UPDATE chat_message SET deleted_at = now() WHERE id = $1', [id]);
  emitUpdate(m, { id, action: 'delete' });
  res.json({ ok: true });
});
