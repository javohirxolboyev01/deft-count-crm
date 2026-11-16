import type { TFunction } from 'i18next';
import { ApiError } from './api';

/**
 * Server xato kodi -> tarjima qilingan matn (noma'lum kod bo'lsa server xabari).
 * Validatsiya xatosida qaysi maydon nima uchun noto'g'ri ekani ham qo'shiladi (zod fieldErrors): umumiy
 * "Ma'lumot noto'g'ri" o'zi foydalanuvchiga nimani tuzatishni aytmaydi.
 */
export function errorText(e: unknown, t: TFunction): string {
  if (e instanceof ApiError) {
    const key = `errors.${e.code}`;
    const tr = t(key);
    const base = tr !== key ? tr : e.message;
    const fields = (e.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined)?.fieldErrors;
    const msgs = fields ? Object.values(fields).flatMap((m) => m ?? []) : [];
    return msgs.length ? `${base}: ${[...new Set(msgs)].join('; ')}` : base;
  }
  if (e instanceof Error) return e.message;
  return t('errors.INTERNAL');
}
