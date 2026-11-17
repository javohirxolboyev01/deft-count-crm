import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { activeUser, me, requireLeader } from '../common/auth';
import { AppError, forbidden, notFound, parse } from '../common/errors';
import { config } from '../config';
import {
  deleteMsgs,
  downloadMedia,
  editText,
  forward,
  getDialog,
  listFolders,
  listPinned,
  listDialogs,
  listMessages,
  loginCancel,
  loginCode,
  loginPassword,
  loginStart,
  logout,
  markRead,
  profilePhoto,
  ready,
  sendText,
  setPinned,
  streamInfo,
  streamRange,
  tgStatus,
  translate,
  unreadTotal,
} from './tgAccount';
import { UPLOAD_MAX_BYTES, dropUpload, receiveUpload, sendUploaded } from './tgUpload';

// «Telegram» bo'limi (V53): firma akkaunti. Ko'rish va yozish — rahbar va buxgalterlar (app.ts: requireStaff),
// ulash/uzish — faqat rahbar. Operatorga yopiq (mijozlar bilan yozishma buxgalteriya ishi).
export const tgRouter = Router();

const peerId = (v: unknown) => parse(z.string().regex(/^-?\d{1,20}$/), v);

tgRouter.get('/status', async (_req, res) => {
  await ready();
  res.json(tgStatus());
});

// Kod/parol tanlab ko'rishdan himoya (Telegram ham cheklaydi, lekin akkauntni xavfga qo'ymaslik uchun oldinroq)
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Juda ko\'p urinish', details: null },
});

tgRouter.post('/login/start', requireLeader, loginLimiter, async (req, res) => {
  const { phone } = parse(
    z.object({ phone: z.string().transform((s) => s.replace(/[^\d+]/g, '')).pipe(z.string().regex(/^\+\d{9,15}$/)) }),
    req.body,
  );
  res.json(await loginStart(phone, me(req).id));
});

tgRouter.post('/login/code', requireLeader, loginLimiter, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().min(4).max(8)) }), req.body);
  res.json(await loginCode(code, me(req).id));
});

tgRouter.post('/login/password', requireLeader, loginLimiter, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(256) }), req.body);
  res.json(await loginPassword(password, me(req).id));
});

tgRouter.post('/login/cancel', requireLeader, (req, res) => {
  loginCancel(me(req).id);
  res.json({ ok: true });
});

tgRouter.post('/logout', requireLeader, async (req, res) => {
  await logout(me(req).id);
  res.json({ ok: true });
});

tgRouter.get('/unread', (_req, res) => {
  res.json({ count: unreadTotal() });
});

tgRouter.get('/dialogs', async (_req, res) => {
  await ready();
  res.json(listDialogs());
});

tgRouter.get('/dialogs/:peerId', async (req, res) => {
  const d = getDialog(peerId(req.params.peerId));
  if (!d) throw notFound('Chat');
  res.json(d);
});

tgRouter.get('/dialogs/:peerId/messages', async (req, res) => {
  const { before, limit } = parse(
    z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    }),
    req.query,
  );
  res.json(await listMessages(peerId(req.params.peerId), before, limit));
});

tgRouter.post('/dialogs/:peerId/messages', async (req, res) => {
  const u = me(req);
  const { text, replyTo } = parse(
    z.object({ text: z.string().trim().min(1).max(4096), replyTo: z.number().int().positive().optional() }),
    req.body,
  );
  res.status(201).json(await sendText(peerId(req.params.peerId), text, u.id, u.fullName, replyTo));
});

const msgIds = (max: number) => z.array(z.number().int().positive()).min(1).max(max).transform((a) => [...new Set(a)]);
const msgId = (v: unknown) => parse(z.coerce.number().int().positive(), v);

// Telegram jildlari (papkalar): qaysi chat qaysi jildga kirishi brauzerda hisoblanadi
tgRouter.get('/folders', async (_req, res) => {
  await ready();
  res.json(await listFolders());
});

tgRouter.patch('/dialogs/:peerId/messages/:msgId', async (req, res) => {
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(4096) }), req.body);
  res.json(await editText(peerId(req.params.peerId), msgId(req.params.msgId), text, me(req).id));
});

tgRouter.post('/dialogs/:peerId/messages/delete', async (req, res) => {
  const { ids, revoke } = parse(z.object({ ids: msgIds(100), revoke: z.boolean().default(false) }), req.body);
  res.json(await deleteMsgs(peerId(req.params.peerId), ids, revoke, me(req).id));
});

tgRouter.get('/dialogs/:peerId/pinned', async (req, res) => {
  res.json(await listPinned(peerId(req.params.peerId)));
});

tgRouter.post('/dialogs/:peerId/messages/:msgId/pin', async (req, res) => {
  const { unpin } = parse(z.object({ unpin: z.boolean().default(false) }), req.body ?? {});
  res.json(await setPinned(peerId(req.params.peerId), msgId(req.params.msgId), unpin, me(req).id));
});

// Uzatish: ko'pi bilan 5 ta chatga birdan — ommaviy tarqatish akkauntni bloklatadi
tgRouter.post('/dialogs/:peerId/forward', async (req, res) => {
  const { ids, to } = parse(
    z.object({ ids: msgIds(100), to: z.array(z.string().regex(/^-?\d{1,20}$/)).min(1).max(5).transform((a) => [...new Set(a)]) }),
    req.body,
  );
  res.json(await forward(peerId(req.params.peerId), ids, to, me(req).id));
});

tgRouter.post('/dialogs/:peerId/translate', async (req, res) => {
  const { ids, to } = parse(z.object({ ids: msgIds(20), to: z.enum(['uz', 'ru', 'en']) }), req.body);
  res.json(await translate(peerId(req.params.peerId), ids, to));
});

// ---------------- Fayl yuborish (tgUpload.ts: serverda ham, bazada ham saqlanmaydi) ----------------

// Ommaviy yuborishdan himoya: bir xodim 15 daqiqada ko'pi bilan 150 ta fayl
const uploadLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 150,
  keyGenerator: (req) => `u${me(req).id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Juda ko\'p fayl', details: null },
});

// Tana — faylning o'zi (application/octet-stream: express.json uni o'qimaydi), ma'lumot — query'da
tgRouter.post('/upload', uploadLimiter, async (req, res) => {
  const q = parse(
    z.object({
      kind: z.enum(['PHOTO', 'VIDEO', 'FILE']),
      name: z.string().trim().min(1).max(200).transform((s) => s.replace(/[\\/\u0000-\u001f]/g, '_')),
      mime: z.string().trim().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).default('application/octet-stream'),
      w: z.coerce.number().int().min(0).max(10000).optional(),
      h: z.coerce.number().int().min(0).max(10000).optional(),
      duration: z.coerce.number().min(0).max(86400).optional(),
    }),
    req.query,
  );
  if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) throw new AppError(415, 'VALIDATION', 'Fayl application/octet-stream bo\'lishi kerak');
  // Sarlavhadagi hajm katta bo'lsa — fayl qabul qilinmaydi (oqim ichida ham tekshiriladi)
  if (Number(req.headers['content-length'] ?? 0) > UPLOAD_MAX_BYTES) throw new AppError(413, 'TG_FILE_TOO_LARGE', 'Fayl juda katta', { maxBytes: UPLOAD_MAX_BYTES });
  const video = q.kind === 'VIDEO' ? { w: q.w ?? 0, h: q.h ?? 0, duration: q.duration ?? 0 } : null;
  res.status(201).json(await receiveUpload(req, { userId: me(req).id, kind: q.kind, name: q.name, mime: q.mime.toLowerCase(), video }));
});

tgRouter.delete('/upload/:id', (req, res) => {
  dropUpload(parse(z.string().uuid(), req.params.id), me(req).id);
  res.json({ ok: true });
});

tgRouter.post('/dialogs/:peerId/send-media', async (req, res) => {
  const { uploads, caption, replyTo } = parse(
    z.object({
      uploads: z.array(z.string().uuid()).min(1).max(10),
      caption: z.string().trim().max(1024).default(''),
      replyTo: z.number().int().positive().optional(),
    }),
    req.body,
  );
  res.status(201).json(await sendUploaded(peerId(req.params.peerId), uploads, caption, replyTo, me(req)));
});

tgRouter.post('/dialogs/:peerId/read', async (req, res) => {
  await markRead(peerId(req.params.peerId));
  res.json({ ok: true });
});

// Fayl serverda saqlanmaydi: har so'rovda Telegram'dan olinib to'g'ridan-to'g'ri beriladi (brauzer keshlaydi)
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const INLINE_MIMES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(ogg|mpeg|mp4|x-m4a|aac|webm))$/;

tgRouter.get('/dialogs/:peerId/media/:msgId', async (req, res) => {
  const msgId = parse(z.coerce.number().int().positive(), req.params.msgId);
  const thumb = req.query.thumb === '1';
  const r = await downloadMedia(peerId(req.params.peerId), msgId, MEDIA_MAX_BYTES, thumb);
  if (!r) throw notFound('Fayl');
  const mime = (r.info.mime ?? 'application/octet-stream').toLowerCase();
  // Rasm/video/ovoz brauzerda ochiladi; qolgani (hujjat, SVG, HTML...) faqat yuklab olinadi va skript bajarilmaydi
  const inline = INLINE_MIMES.test(mime) || r.info.kind === 'PHOTO';
  res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
  if (!inline) res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Content-Length', String(r.buf.length));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const name = r.info.fileName ?? `telegram-${msgId}`;
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(r.buf);
});

// ---------------- Video/ovoz oqimi ----------------
// <video src> so'rovga Authorization sarlavhasini qo'sha olmaydi: CRM ichidan qisqa muddatli imzoli havola olinadi
// (faqat shu xabar uchun, xodim nomidan). Har so'rovda xodim faolligi va roli bazadan qayta tekshiriladi.
const STREAM_AUD = 'tg-stream';

tgRouter.get('/dialogs/:peerId/media/:msgId/link', (req, res) => {
  const p = peerId(req.params.peerId);
  const m = parse(z.coerce.number().int().positive(), req.params.msgId);
  const token = jwt.sign({ sub: String(me(req).id), p, m }, config.jwtAccessSecret, { expiresIn: '6h', audience: STREAM_AUD });
  res.json({ url: `/api/tg-stream/${token}` });
});

export const tgStreamRouter = Router();

tgStreamRouter.get('/:token', async (req, res) => {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(req.params.token, config.jwtAccessSecret, { audience: STREAM_AUD }) as jwt.JwtPayload;
  } catch {
    throw new AppError(401, 'TOKEN_INVALID', 'Havola eskirgan');
  }
  // Oddiy kirish tokeni bilan bir xil tekshiruv: faolsizlantirilgan xodim yoki operator — yo'q
  const u = await activeUser(Number(payload.sub));
  if (u.role !== 'LEADER' && u.role !== 'ACCOUNTANT') throw forbidden();
  const p = String(payload.p);
  const msg = Number(payload.m);
  const info = await streamInfo(p, msg);
  const size = info.size;
  const mime = info.mime.toLowerCase();
  const inline = /^(video|audio)\//.test(mime);
  const dl = req.query.dl === '1';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', inline && !dl ? mime : 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=21600');
  if (!inline || dl) res.setHeader('Content-Security-Policy', 'sandbox');
  // ?dl=1 — yuklab olish (hajm cheklovisiz: fayl Telegram'dan bo'lak-bo'lak oqib o'tadi, serverda to'planmaydi)
  if (dl) {
    const name = info.fileName ?? `telegram-${msg}${mime.startsWith('video/') ? '.mp4' : ''}`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  // Bitta Range javobida ko'pi bilan 2 MB: brauzer keyingisini o'zi so'raydi (sakrash tez bo'ladi)
  const MAX = 2 * 1024 * 1024;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else start = Math.max(0, size - Number(range[2]));
    if (start >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    end = Math.min(end, start + MAX - 1);
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  // Range'siz so'rov (yuklab olish): butun fayl, bo'lak-bo'lak
  res.setHeader('Content-Length', String(end - start + 1));
  let aborted = false;
  req.on('close', () => (aborted = true));
  try {
    for await (const part of streamRange(p, msg, start, end)) {
      if (aborted) break;
      if (!res.write(part)) await new Promise((r) => res.once('drain', r));
    }
  } catch (e) {
    // Sarlavhalar ketib bo'lgan: ulanish yopiladi, brauzer qayta so'raydi
    if (!res.headersSent) throw e;
    console.error('Telegram oqimi uzildi:', (e as any)?.errorMessage ?? e);
    res.destroy();
    return;
  }
  res.end();
});

/** Profil rasmi (kichik). ?v= — rasm versiyasi: rasm almashsa brauzer yangisini oladi */
tgRouter.get('/photo/:peerId', async (req, res) => {
  const buf = await profilePhoto(peerId(req.params.peerId));
  if (!buf) {
    // Rasm yo'q — brauzer qayta-qayta so'ramasin
    res.setHeader('Cache-Control', 'private, max-age=3600');
    throw notFound('Rasm');
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.end(buf);
});
