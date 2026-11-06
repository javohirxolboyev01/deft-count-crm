import { config } from '../config';
import { AppError } from '../common/errors';

// Chat fayllari ombori — Telegram yopiq kanali (rahbar qarori, V43).
// Oddiy Bot API cheklovi: yuklash 50 MB, lekin getFile orqali yuklab olish 20 MB gacha —
// shuning uchun chatdagi fayl chegarasi 20 MB (CHAT_FILE_MAX_BYTES).
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const api = (method: string) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

export const storageEnabled = () => Boolean(config.telegram.token && config.telegram.storageChatId);

export interface StoredFile {
  fileId: string;
  fileUniqueId: string;
  chatId: string;
  messageId: number;
}

const unavailable = () => new AppError(503, 'FILE_STORAGE_UNAVAILABLE', 'Fayl ombori (Telegram) vaqtincha ishlamayapti');

/**
 * Dumaloq video xabar kanalda ham dumaloq ko'rinsin: sendVideoNote (Telegram talabi — kvadrat MP4, ≤ 60 s;
 * brauzer shunday yozadi). Telegram qabul qilmasa (masalan, Firefox'dagi webm) — null, oddiy hujjat bo'lib saqlanadi.
 */
async function sendVideoNote(buf: Buffer, fileName: string, mime: string, durationSec?: number, length?: number): Promise<StoredFile | null> {
  const form = new FormData();
  form.set('chat_id', config.telegram.storageChatId);
  form.set('disable_notification', 'true');
  if (durationSec) form.set('duration', String(durationSec));
  if (length) form.set('length', String(Math.min(640, length)));
  form.set('video_note', new Blob([buf], { type: mime }), fileName);
  try {
    const r = await fetch(api('sendVideoNote'), { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    const data: any = await r.json();
    const f = data?.result?.video_note;
    if (!data?.ok || !f?.file_id) {
      console.warn('Telegram sendVideoNote qabul qilmadi, hujjat sifatida saqlanadi:', data?.description);
      return null;
    }
    return { fileId: f.file_id, fileUniqueId: f.file_unique_id, chatId: String(data.result.chat.id), messageId: data.result.message_id };
  } catch (e) {
    console.warn('Telegram sendVideoNote:', (e as Error).message);
    return null;
  }
}

/**
 * Faylni kanalga yuklash. Odatda hujjat sifatida: sendPhoto/sendVideo faylni siqadi (sifat tushadi),
 * disable_content_type_detection — Telegram faylni o'zgartirmasin. Dumaloq video (MP4) — sendVideoNote.
 */
export async function uploadToTelegram(
  buf: Buffer,
  fileName: string,
  mime: string,
  caption: string,
  videoNote?: { durationSec?: number; length?: number },
): Promise<StoredFile> {
  if (!storageEnabled()) throw new AppError(503, 'FILE_STORAGE_DISABLED', 'Fayl ombori sozlanmagan');
  if (videoNote && mime === 'video/mp4') {
    const note = await sendVideoNote(buf, fileName, mime, videoNote.durationSec, videoNote.length);
    if (note) return note;
  }
  const form = new FormData();
  form.set('chat_id', config.telegram.storageChatId);
  form.set('caption', caption);
  form.set('disable_notification', 'true');
  form.set('disable_content_type_detection', 'true');
  form.set('document', new Blob([buf], { type: mime }), fileName);
  let data: any;
  try {
    const r = await fetch(api('sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    data = await r.json();
  } catch (e) {
    console.error('Telegram fayl yuklash:', (e as Error).message);
    throw unavailable();
  }
  const msg = data?.result;
  // disable_content_type_detection bo'lsa ham GIF animation bo'lib qaytishi mumkin
  const f = msg?.document ?? msg?.animation ?? msg?.video ?? msg?.audio ?? msg?.voice;
  if (!data?.ok || !f?.file_id) {
    console.error('Telegram fayl yuklash:', data?.description ?? 'javob noto\'g\'ri');
    throw unavailable();
  }
  return { fileId: f.file_id, fileUniqueId: f.file_unique_id, chatId: String(msg.chat.id), messageId: msg.message_id };
}

// getFile havolasi kamida 1 soat amal qiladi: har so'rovda qayta so'ramaslik uchun 50 daqiqa eslab qolamiz
const pathCache = new Map<string, { path: string; until: number }>();

async function filePath(fileId: string): Promise<string> {
  const c = pathCache.get(fileId);
  if (c && c.until > Date.now()) return c.path;
  const r = await fetch(api('getFile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await r.json();
  if (!data?.ok || !data.result?.file_path) throw new Error(data?.description ?? 'getFile');
  if (pathCache.size > 1000) pathCache.clear();
  pathCache.set(fileId, { path: data.result.file_path, until: Date.now() + 50 * 60_000 });
  return data.result.file_path;
}

// Telegram'dan olingan fayllar uchun vaqtinchalik xotira (RAM, diskka yozilmaydi; server qayta ishga tushsa tozalanadi).
// Telegram serveriga ulanish sekin/beqaror bo'lishi mumkin (1 MB ≈ 3–5 s): bir marta ochilgan fayl ikkinchi marta darhol beriladi.
const MEM_LIMIT = 150 * 1024 * 1024;
const mem = new Map<string, Buffer>(); // qo'shilish tartibi = LRU tartibi
let memBytes = 0;
// Bir faylni bir vaqtda bir nechta so'rov ochsa — Telegram'dan bir marta olinadi
const inflight = new Map<string, Promise<Buffer>>();

function remember(fileId: string, buf: Buffer) {
  if (buf.length > MEM_LIMIT / 4) return;
  mem.set(fileId, buf);
  memBytes += buf.length;
  for (const [k, v] of mem) {
    if (memBytes <= MEM_LIMIT) break;
    mem.delete(k);
    memBytes -= v.length;
  }
}

async function fetchOnce(fileId: string): Promise<Buffer> {
  const path = await filePath(fileId);
  const r = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${path}`, {
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) {
    pathCache.delete(fileId);
    throw new Error(`HTTP ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

/** Faylni Telegram'dan olish (3 urinish). Bot tokeni brauzerga chiqmasin — fayl doim server orqali uzatiladi */
export async function downloadFromTelegram(fileId: string): Promise<Buffer> {
  if (!config.telegram.token) throw new AppError(503, 'FILE_STORAGE_DISABLED', 'Fayl ombori sozlanmagan');
  const hit = mem.get(fileId);
  if (hit) {
    mem.delete(fileId);
    mem.set(fileId, hit); // eng so'nggi ishlatilgan — oxiriga
    return hit;
  }
  let p = inflight.get(fileId);
  if (!p) {
    p = (async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const buf = await fetchOnce(fileId);
          remember(fileId, buf);
          return buf;
        } catch (e) {
          last = e;
          console.warn(`Telegram fayl olish (${attempt + 1}/3):`, (e as Error).message);
          await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
        }
      }
      console.error('Telegram fayl olish:', (last as Error)?.message);
      throw unavailable();
    })().finally(() => inflight.delete(fileId));
    inflight.set(fileId, p);
  }
  return p;
}

/** Yangi yuklangan faylni xotiraga qo'yish: qabul qiluvchi ochganda Telegram'dan qayta olinmaydi */
export function rememberUploaded(fileId: string, buf: Buffer) {
  remember(fileId, buf);
}
