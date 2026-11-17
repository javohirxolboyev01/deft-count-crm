import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { me, requireLeader } from '../common/auth';
import { notFound, parse } from '../common/errors';
import {
  downloadMedia,
  getDialog,
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
  tgStatus,
  unreadTotal,
} from './tgAccount';

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
