import { DateTime } from 'luxon';
import { AppError } from './errors';

export const TZ = 'Asia/Tashkent';

export const nowTz = () => DateTime.now().setZone(TZ);

/** Joriy davr: 'YYYY-MM-01' (Asia/Tashkent bo'yicha) */
export function currentPeriod(): string {
  return nowTz().startOf('month').toISODate()!;
}

/**
 * Belgilanadigan (ish) oyi: joriy oydan bir oy oldin — noyabrda oktyabr ishlari/hisobotlari belgilanadi (muddat keyingi
 * oyda, V34/V36). Jadvallar va dashboardlar shu oydan ochiladi (web: `workMonth()`).
 */
export function workPeriod(): string {
  return nowTz().startOf('month').minus({ months: 1 }).toISODate()!;
}

/** 'YYYY-MM' -> 'YYYY-MM-01' */
export function periodFromMonth(month: string | undefined): string {
  if (!month) return currentPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Oy formati YYYY-MM bo\'lishi kerak');
  }
  return `${month}-01`;
}

/** 'YYYY-MM-01' + n oy */
export function addMonthsIso(period: string, n: number): string {
  return DateTime.fromISO(period).plus({ months: n }).toISODate()!;
}

export function monthOf(period: string): string {
  return period.slice(0, 7);
}

/** Bugun soat HH:mm (Asia/Tashkent) -> Date */
export function todayAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return nowTz().set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate();
}

/** 'YYYY-MM-DD' kun boshi/oxiri (Asia/Tashkent) */
export function dayStart(isoDate: string): Date {
  return DateTime.fromISO(isoDate, { zone: TZ }).startOf('day').toJSDate();
}
export function dayEnd(isoDate: string): Date {
  return DateTime.fromISO(isoDate, { zone: TZ }).endOf('day').toJSDate();
}
