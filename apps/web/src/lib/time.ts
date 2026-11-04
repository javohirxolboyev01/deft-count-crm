import { DateTime } from 'luxon';

// Barcha sana/vaqt Asia/Tashkent bo'yicha ko'rsatiladi (brauzer vaqt zonasidan qat'i nazar)
export const TZ = 'Asia/Tashkent';

const dt = (iso: string) => DateTime.fromISO(iso).setZone(TZ);

export const fmtDate = (iso?: string | null) => (iso ? dt(iso).toFormat('dd.MM.yyyy') : '—');
export const fmtDateTime = (iso?: string | null) => (iso ? dt(iso).toFormat('dd.MM.yyyy HH:mm') : '—');
export const fmtShortDue = (iso?: string | null) => (iso ? dt(iso).toFormat('dd.MM HH:mm') : '—');
/** 'YYYY-MM-DD' -> 'dd.MM.yyyy' (oylik jadval sarlavhasi, Sheet'dagidek: 15.10.2026) */
export const fmtIsoDate = (isoDate?: string | null) => (isoDate ? DateTime.fromISO(isoDate).toFormat('dd.MM.yyyy') : '');

export const currentMonth = () => DateTime.now().setZone(TZ).toFormat('yyyy-MM');
export const shiftMonth = (month: string, delta: number) =>
  DateTime.fromFormat(month, 'yyyy-MM').plus({ months: delta }).toFormat('yyyy-MM');
/** Belgilanadigan oy (rahbar qarori): noyabrda oktyabr ishi/hisoboti topshiriladi — jadvallar shu oydan ochiladi */
export const workMonth = () => shiftMonth(currentMonth(), -1);
/** Oy nomlari lug'atdan (brauzerda uz locale ma'lumoti bo'lmasligi mumkin) */
/** Oy ishining muddati (V34/V36): keyingi oyning dueDay-kuni (oy qisqa bo'lsa oxirgi kuni; null — oy oxiri) */
export const workDueDate = (month: string, dueDay: number | null) => {
  const next = DateTime.fromISO(`${month}-01`).plus({ months: 1 });
  return next.set({ day: Math.min(dueDay ?? 31, next.daysInMonth!) }).toFormat('dd.MM.yyyy');
};
export const monthLabel = (month: string, names: string[]) => {
  const [y, m] = month.split('-').map(Number);
  return `${names[m - 1]} ${y}`;
};

export const todayIso = () => DateTime.now().setZone(TZ).toISODate()!;
export const startOfMonthIso = () => DateTime.now().setZone(TZ).startOf('month').toISODate()!;
export const startOfWeekIso = () => DateTime.now().setZone(TZ).startOf('week').toISODate()!;

/** Bugun HH:mm (Tashkent) -> ISO; datetime-local input qiymati uchun ham */
export const todayAtLocalInput = (hhmm: string) => `${todayIso()}T${hhmm}`;
export const localInputToIso = (v: string) => DateTime.fromISO(v, { zone: TZ }).toUTC().toISO()!;
export const isoToLocalInput = (iso: string) => dt(iso).toFormat("yyyy-MM-dd'T'HH:mm");

/**
 * Nisbiy vaqt: "5 daqiqa oldin", "6 soat oldin", "Kecha", undan eskisi — sana (Tashkent kunlari bo'yicha).
 * Matnlar lug'atdan (notif.time.*): brauzerda uz locale ma'lumoti bo'lmasligi mumkin (Intl.RelativeTimeFormat)
 */
export function fmtRelative(iso: string, t: (key: string, opts?: Record<string, unknown>) => string) {
  const d = dt(iso);
  const now = DateTime.now().setZone(TZ);
  const mins = Math.max(0, Math.floor(now.diff(d, 'minutes').minutes));
  if (mins < 1) return t('notif.time.justNow');
  if (mins < 60) return t('notif.time.minutes', { n: mins });
  if (d.hasSame(now, 'day')) return t('notif.time.hours', { n: Math.floor(mins / 60) });
  if (d.hasSame(now.minus({ days: 1 }), 'day')) return t('notif.time.yesterday');
  return d.toFormat('dd.MM.yyyy');
}

export function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
}
