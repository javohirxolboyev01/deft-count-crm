import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Api, helpers, utils } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { AppError } from '../common/errors';
import { peerInput, recordSent, tgCall, tgClient } from './tgAccount';

/**
 * CRM'dan Telegram'ga rasm/video/fayl yuborish. Fayl CRM serverida ham, bazada ham SAQLANMAYDI.
 *
 * Ikki bosqich (Telegram ilovasidagidek — xodim izoh yozguncha fayl yuklanib turadi):
 * 1) `POST /api/tg/upload`: brauzer → server vaqtinchalik faylga (xotirada to'planmaydi), keyin navbat bilan Telegram'ga
 *    yuklanadi (diskdan 512 KB bo'laklarda) va vaqtinchalik fayl darhol o'chiriladi. Xotirada faqat Telegram'dagi
 *    yuklangan fayl havolasi (InputFile) qoladi — 1 soat.
 * 2) `POST /api/tg/dialogs/:peerId/send-media`: yuklanganlar izoh bilan bitta xabar yoki albom bo'lib yuboriladi.
 *
 * Unumdorlik (rahbar talabi): firma Telegram'iga bitta ulanish — bir vaqtda ko'pi bilan 2 ta fayl Telegram'ga
 * yuklanadi (qolgani navbatda), boshqa xodimlarning chat ochishi sekinlashmasin. Hajm ≤ 100 MB. Rasm brauzerda siqiladi.
 */

export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const DIR = path.join(os.tmpdir(), 'crm-tg-upload');
const TELEGRAM_PARALLEL = 2;
const TTL_MS = 60 * 60_000;
// Telegram «rasm» sifatida 10 MB gacha qabul qiladi; kattasi fayl bo'lib ketadi
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export type UploadKind = 'PHOTO' | 'VIDEO' | 'FILE';

interface Uploaded {
  userId: number;
  kind: UploadKind;
  name: string;
  mime: string;
  size: number;
  file: Api.TypeInputFile;
  video: { w: number; h: number; duration: number } | null;
  at: number;
}

const uploads = new Map<string, Uploaded>();

// ---------------- Navbat (semafor): Telegram'ga bir vaqtda ko'pi bilan 2 ta yuklash ----------------

let active = 0;
const waiters: (() => void)[] = [];

async function acquire() {
  if (active < TELEGRAM_PARALLEL) {
    active++;
    return;
  }
  // Bo'shagan joy to'g'ridan-to'g'ri navbatdagiga beriladi (active kamaymaydi)
  await new Promise<void>((r) => waiters.push(r));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

export const uploadQueue = () => ({ active, waiting: waiters.length });

/** Ilova ishga tushganda: oldingi ishdan qolgan vaqtinchalik fayllar (masalan, server o'chib qolgan bo'lsa) */
export function cleanupUploadDir() {
  fs.rmSync(DIR, { recursive: true, force: true });
}

function prune() {
  const now = Date.now();
  for (const [id, u] of uploads) if (now - u.at > TTL_MS) uploads.delete(id);
}

export async function receiveUpload(
  body: Readable,
  meta: { userId: number; kind: UploadKind; name: string; mime: string; video: Uploaded['video'] },
) {
  // Telegram ulanmagan bo'lsa fayl qabul qilinmaydi (100 MB behuda yuklanmasin)
  const c = tgClient();
  await fs.promises.mkdir(DIR, { recursive: true });
  const id = randomUUID();
  const tmp = path.join(DIR, id);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > UPLOAD_MAX_BYTES) cb(new AppError(413, 'TG_FILE_TOO_LARGE', 'Fayl juda katta', { maxBytes: UPLOAD_MAX_BYTES }));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(body, limiter, fs.createWriteStream(tmp));
    if (!bytes) throw new AppError(400, 'VALIDATION', 'Fayl bo\'sh');
    await acquire();
    let file: Api.TypeInputFile;
    try {
      file = await tgCall(() =>
        c.uploadFile({
          file: new CustomFile(meta.name, bytes, tmp),
          // maxBufferSize: 0 — fayl xotiraga to'liq o'qilmaydi, diskdan bo'lak-bo'lak
          maxBufferSize: 0,
          workers: bytes > 10 * 1024 * 1024 ? 2 : 1,
        }),
      );
    } finally {
      release();
    }
    const kind: UploadKind = meta.kind === 'PHOTO' && (bytes > PHOTO_MAX_BYTES || !/^image\/(jpeg|png|webp)$/.test(meta.mime)) ? 'FILE' : meta.kind;
    prune();
    uploads.set(id, { userId: meta.userId, kind, name: meta.name, mime: meta.mime, size: bytes, file, video: meta.video, at: Date.now() });
    return { id, size: bytes, kind };
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/** Brauzer «bekor qilish» bosganda (yoki oynani yopganda) — havola unutiladi */
export function dropUpload(id: string, userId: number) {
  const u = uploads.get(id);
  if (u && u.userId === userId) uploads.delete(id);
}

function mediaOf(u: Uploaded): Api.TypeInputMedia {
  if (u.kind === 'PHOTO') return new Api.InputMediaUploadedPhoto({ file: u.file });
  const attributes: Api.TypeDocumentAttribute[] = [new Api.DocumentAttributeFilename({ fileName: u.name })];
  if (u.kind === 'VIDEO') {
    attributes.push(
      new Api.DocumentAttributeVideo({ duration: u.video?.duration ?? 0, w: u.video?.w ?? 0, h: u.video?.h ?? 0, supportsStreaming: true }),
    );
  }
  return new Api.InputMediaUploadedDocument({
    file: u.file,
    mimeType: u.mime || 'application/octet-stream',
    attributes,
    forceFile: u.kind === 'FILE',
  });
}

/** Javobdagi yangi xabarlar (Telegram'ning updates javobidan) */
function messagesFrom(result: any): Api.Message[] {
  const out: Api.Message[] = [];
  for (const u of result?.updates ?? []) {
    if ((u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) && u.message instanceof Api.Message) out.push(u.message);
  }
  return out.sort((a, b) => a.id - b.id);
}

export async function sendUploaded(peerId: string, ids: string[], caption: string, replyTo: number | undefined, user: { id: number; fullName: string }) {
  const items = ids.map((id) => uploads.get(id));
  if (items.some((u) => !u || u.userId !== user.id)) {
    throw new AppError(409, 'TG_UPLOAD_EXPIRED', 'Fayl yuklanishi eskirgan — qaytadan tanlang');
  }
  const list = items as Uploaded[];
  // Albomda rasm/video aralash bo'lishi mumkin, fayllar — alohida albom (Telegram qoidasi)
  const visual = list.map((u) => u.kind !== 'FILE');
  if (list.length > 1 && visual.some((v) => v !== visual[0])) throw new AppError(400, 'VALIDATION', 'Albomda rasm va fayl aralashmaydi');
  const c = tgClient();
  const peer = await peerInput(peerId);
  const reply = replyTo ? new Api.InputReplyToMessage({ replyToMsgId: replyTo }) : undefined;
  let result: any;
  if (list.length === 1) {
    result = await tgCall(() =>
      c.invoke(new Api.messages.SendMedia({ peer, media: mediaOf(list[0]), message: caption, randomId: helpers.generateRandomLong(), replyTo: reply })),
    );
  } else {
    // Albom: har fayl avval Telegram'da media'ga aylanadi (uploadMedia), keyin hammasi bitta xabar guruhi bo'lib ketadi
    const multiMedia: Api.InputSingleMedia[] = [];
    for (const [i, u] of list.entries()) {
      const mm = await tgCall(() => c.invoke(new Api.messages.UploadMedia({ peer, media: mediaOf(u) })));
      multiMedia.push(new Api.InputSingleMedia({ media: utils.getInputMedia(mm), randomId: helpers.generateRandomLong(), message: i === 0 ? caption : '' }));
    }
    result = await tgCall(() => c.invoke(new Api.messages.SendMultiMedia({ peer, multiMedia, replyTo: reply })));
  }
  for (const id of ids) uploads.delete(id);
  return recordSent(peerId, messagesFrom(result), user.id, user.fullName);
}
