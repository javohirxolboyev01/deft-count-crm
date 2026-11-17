import { ApiError, api, qs } from './api';

/**
 * «Telegram» bo'limidan rasm/video/fayl yuborish (brauzer tomoni).
 * - Rasm «siqib yuborish» tanlansa brauzerda 2560 px gacha kichraytiriladi (Telegram ham shunday siqadi):
 *   5–10 MB telefon rasmi ~0.3–0.6 MB bo'lib ketadi — serverga ham, Telegram ulanishiga ham yuk kam.
 * - Fayl tanlangan zahoti yuklana boshlaydi (xodim izoh yozguncha), progress ko'rinadi, bekor qilish mumkin.
 */

export type SendKind = 'PHOTO' | 'VIDEO' | 'FILE';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const PHOTO_MAX_SIDE = 2560;
const PHOTO_QUALITY = 0.87;

export interface SendItem {
  key: string;
  file: File;
  name: string;
  isImage: boolean;
  isVideo: boolean;
  /** Ko'rinish uchun: rasm yoki videoning birinchi kadri (blob: URL) */
  preview: string | null;
  w: number;
  h: number;
  duration: number;
}

let seq = 0;
const COMPRESSIBLE = /^image\/(jpeg|png|webp|heic|heif|bmp)$/;

/** Fayl haqida ma'lumot: o'lcham, video davomiyligi va kadri */
export async function prepareItem(file: File): Promise<SendItem> {
  const isImage = COMPRESSIBLE.test(file.type);
  const isVideo = /^video\/(mp4|webm|quicktime|x-m4v)$/.test(file.type);
  const base: SendItem = { key: `f${++seq}`, file, name: file.name || 'file', isImage, isVideo, preview: null, w: 0, h: 0, duration: 0 };
  if (isImage || file.type === 'image/gif') {
    const url = URL.createObjectURL(file);
    const dims = await new Promise<{ w: number; h: number }>((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = url;
    });
    // Brauzer ocha olmagan rasm (masalan HEIC) — oddiy fayl bo'lib ketadi
    if (!dims.w) {
      URL.revokeObjectURL(url);
      return { ...base, isImage: false };
    }
    return { ...base, preview: url, ...dims };
  }
  if (isVideo) {
    const url = URL.createObjectURL(file);
    const meta = await new Promise<{ w: number; h: number; duration: number; frame: string | null }>((res) => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'metadata';
      v.playsInline = true;
      const done = (frame: string | null) => res({ w: v.videoWidth, h: v.videoHeight, duration: Math.round(v.duration || 0), frame });
      v.onloadeddata = () => {
        // Birinchi kadr — oldindan ko'rish uchun
        try {
          const c = document.createElement('canvas');
          const s = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight, 1));
          c.width = Math.max(1, Math.round(v.videoWidth * s));
          c.height = Math.max(1, Math.round(v.videoHeight * s));
          c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
          c.toBlob((b) => done(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.8);
        } catch {
          done(null);
        }
      };
      v.onerror = () => res({ w: 0, h: 0, duration: 0, frame: null });
      v.src = url;
    });
    URL.revokeObjectURL(url);
    return { ...base, preview: meta.frame, w: meta.w, h: meta.h, duration: meta.duration };
  }
  return base;
}

export function releaseItem(it: SendItem) {
  if (it.preview) URL.revokeObjectURL(it.preview);
}

/** Telegram kabi: eng uzun tomoni 2560 px, JPEG. Kichikroq bo'lmasa — asl fayl */
async function compressImage(file: File, w: number, h: number): Promise<Blob> {
  const s = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d');
    if (!ctx) return file;
    // Shaffof PNG qora bo'lib qolmasin
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

// ---------------- Yuklash vazifasi ----------------

export interface UploadTask {
  item: SendItem;
  kind: SendKind;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error: unknown;
  id: string | null;
  promise: Promise<string>;
  abort: () => void;
  subscribe: (fn: () => void) => () => void;
}

/** compress — rasm siqib «rasm» sifatida, video «video» sifatida; aks holda hammasi asl holida «fayl» */
export function startUpload(item: SendItem, compress: boolean): UploadTask {
  const ctrl = new AbortController();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const kind: SendKind = compress && item.isImage ? 'PHOTO' : compress && item.isVideo ? 'VIDEO' : 'FILE';
  const task: UploadTask = {
    item,
    kind,
    progress: 0,
    status: 'uploading',
    error: null,
    id: null,
    promise: null as unknown as Promise<string>,
    abort: () => {
      ctrl.abort();
      if (task.id) void api.del(`/tg/upload/${task.id}`).catch(() => undefined);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  task.promise = (async () => {
    try {
      let body: Blob = item.file;
      let mime = item.file.type || 'application/octet-stream';
      let name = item.name;
      if (kind === 'PHOTO') {
        body = await compressImage(item.file, item.w, item.h);
        if (body !== item.file) {
          mime = 'image/jpeg';
          name = name.replace(/\.[^.]+$/, '') + '.jpg';
        }
      }
      if (body.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'TG_FILE_TOO_LARGE', 'Fayl juda katta');
      const r = await api.upload<{ id: string }>(
        `/tg/upload${qs({ kind, name, mime, w: item.w || undefined, h: item.h || undefined, duration: item.duration || undefined })}`,
        body,
        {
          signal: ctrl.signal,
          onProgress: (f) => {
            // Brauzer → server 95% gacha; qolgani server Telegram'ga yuklaguncha
            task.progress = f * 0.95;
            emit();
          },
        },
      );
      task.id = r.id;
      task.progress = 1;
      task.status = 'done';
      emit();
      return r.id;
    } catch (e) {
      task.status = 'error';
      task.error = e;
      emit();
      throw e;
    }
  })();
  // Kutilmagan "unhandled rejection" bo'lmasin: xato task.status orqali ko'rinadi
  task.promise.catch(() => undefined);
  return task;
}
