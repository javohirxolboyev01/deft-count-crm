import { DateTime } from 'luxon';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { trimCache } from '@/lib/tgCache';
import { TZ } from '@/lib/time';
import type { TgDialog, TgMediaKind, TgTextEntity, TgUserStatus } from '@/lib/types';

/** «Telegram» bo'limi (V53) uchun umumiy UI: avatar, pufakcha dumi, belgilar, formatlangan matn, holat matni */

type T = ReturnType<typeof useTranslation>['t'];

export const dtOf = (sec: number) => DateTime.fromSeconds(sec).setZone(TZ);

// Telegram avatar ranglari (qizil, to'q sariq, binafsha, yashil, moviy, ko'k, pushti) — peer id bo'yicha
const AVATAR = [
  ['#ff885e', '#ff516a'],
  ['#ffcd6a', '#ffa85c'],
  ['#e0a2f3', '#d669ed'],
  ['#a0de7e', '#54cb68'],
  ['#53edd6', '#28c9b7'],
  ['#72d5fd', '#2a9ef1'],
  ['#ffa8a8', '#ff719a'],
];

/** Marked id ("-100123…") dan Telegram'dagi asl id → rang indeksi */
export function avatarColor(peerId: string) {
  try {
    // Superguruh: "-100" + asl id; oddiy guruh: "-" + id
    const raw = peerId.startsWith('-100') && peerId.length > 13 ? peerId.slice(4) : peerId.replace(/^-/, '');
    const n = Number(BigInt(raw) % 7n);
    return AVATAR[(n + 7) % 7];
  } catch {
    return AVATAR[0];
  }
}

/** Telegram'dagidek: ism va familiyaning bosh harflari (guruhda — birinchi ikki so'z) */
export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ? [...parts[0]][0] : '';
  const b = parts[1] ? [...parts[1]][0] : '';
  return (a + b).toUpperCase() || '?';
}

// ---------------- Profil rasmi (ko'rinadigan bo'lganda yuklanadi) ----------------

const photoCache = new Map<string, Promise<string | null>>();

function photoUrl(peerId: string, v: string) {
  const key = `${peerId}:${v}`;
  let p = photoCache.get(key);
  if (!p) {
    p = api
      .blob(`/tg/photo/${peerId}?v=${encodeURIComponent(v)}`)
      .then((b) => URL.createObjectURL(b))
      .catch(() => null);
    photoCache.set(key, p);
    trimCache(photoCache, 600);
  }
  return p;
}

export function TgAvatar({
  peerId,
  name,
  photoId,
  size = 54,
  className,
  icon,
  online,
}: {
  peerId: string;
  name: string;
  /** null — rasm yo'q (so'rov yuborilmaydi), undefined — noma'lum (guruh a'zosi): so'rab ko'riladi */
  photoId?: string | null;
  size?: number;
  className?: string;
  icon?: ReactNode;
  online?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const want = photoId !== null && !icon;

  useEffect(() => {
    if (!want || visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e.some((x) => x.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [want, visible]);

  useEffect(() => {
    if (!want || !visible) return;
    let alive = true;
    void photoUrl(peerId, photoId ?? 'x').then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [want, visible, peerId, photoId]);

  const [a, b] = avatarColor(peerId);
  return (
    <span ref={ref} aria-hidden className={cn('relative inline-flex shrink-0 select-none', className)} style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" className="h-full w-full rounded-full object-cover" draggable={false} />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full font-semibold text-on-brand"
          style={{ background: icon ? 'var(--tg-badge-muted)' : `linear-gradient(180deg, ${a}, ${b})`, fontSize: Math.round(size * 0.38) }}
        >
          {icon ?? initials(name)}
        </span>
      )}
      {online && (
        <span
          className="absolute bottom-[1px] right-[1px] rounded-full border-2 bg-[var(--tg-online)]"
          style={{ width: Math.max(12, size * 0.26), height: Math.max(12, size * 0.26), borderColor: 'var(--tg-bg)' }}
        />
      )}
    </span>
  );
}

// ---------------- Pufakcha dumi va belgilar ----------------

/** Telegram pufakchasi dumi: guruhning oxirgi xabarida pastki burchakda */
export function Tail({ out }: { out: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 11 20"
      width="11"
      height="20"
      className={cn('pointer-events-none absolute bottom-0', out ? '-right-[8.5px]' : '-left-[8.5px] -scale-x-100')}
      style={{ color: out ? 'var(--tg-out)' : 'var(--tg-in)' }}
    >
      <path d="M0 0 V20 H9.5 C10.6 20 11.2 18.7 10.4 17.9 C4.8 12.3 0.6 7 0 0 Z" fill="currentColor" />
    </svg>
  );
}

/** ✓ (yuborildi) / ✓✓ (o'qildi) — Telegram shaklida */
export function TgTicks({ read, className }: { read: boolean; className?: string }) {
  return read ? (
    <svg viewBox="0 0 19 12" width="19" height="12" aria-hidden className={className}>
      <path d="M1.5 6.6 4.9 10 12.2 2.2M7.6 9.9l.6.4 7.6-8.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 19 12" width="19" height="12" aria-hidden className={className}>
      <path d="M4.5 6.6 7.9 10 15.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-end gap-[2px]', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-[4px] w-[4px] rounded-full bg-current" style={{ animation: `tg-typing-dot 1.2s ${i * 0.2}s infinite` }} />
      ))}
    </span>
  );
}

// ---------------- Vaqt va holat matnlari ----------------

/** Ro'yxatdagi vaqt: bugun — HH:mm, shu hafta — kun nomi, keyin — dd.MM.yy */
export function listTime(sec: number, t: T) {
  const d = dtOf(sec);
  const now = DateTime.now().setZone(TZ);
  if (d.hasSame(now, 'day')) return d.toFormat('HH:mm');
  if (now.diff(d, 'days').days < 7) return (t('weekdaysShort', { returnObjects: true }) as string[])[d.weekday - 1];
  return d.toFormat('dd.MM.yy');
}

export function dayLabel(sec: number, t: T) {
  const d = dtOf(sec);
  const now = DateTime.now().setZone(TZ);
  if (d.hasSame(now, 'day')) return t('chat.today');
  if (d.hasSame(now.minus({ days: 1 }), 'day')) return t('chat.yesterday');
  const months = t('months', { returnObjects: true }) as string[];
  return `${d.day} ${months[d.month - 1]}${d.year !== now.year ? ` ${d.year}` : ''}`;
}

export function isOnline(s: TgUserStatus | null | undefined) {
  return s?.kind === 'ONLINE' && (!s.at || s.at * 1000 > Date.now());
}

/** Sarlavhadagi holat: «online», «oxirgi marta 14:05 da», «a'zolar: 12» … */
export function statusText(d: TgDialog, t: T) {
  if (d.kind === 'BOT') return t('tg.bot');
  if (d.kind === 'GROUP') return d.members ? t('tg.members', { count: d.members }) : t('tg.group');
  if (d.kind === 'CHANNEL') return d.members ? t('tg.subscribers', { count: d.members }) : t('tg.channel');
  const s = d.status;
  if (!s) return t('tg.lastSeenLongAgo');
  if (isOnline(s)) return t('tg.online');
  if ((s.kind === 'OFFLINE' || s.kind === 'ONLINE') && s.at) {
    const at = dtOf(s.at);
    const now = DateTime.now().setZone(TZ);
    if (now.diff(at, 'minutes').minutes < 1) return t('tg.lastSeenJustNow');
    if (at.hasSame(now, 'day')) return t('tg.lastSeenAt', { time: at.toFormat('HH:mm') });
    if (at.hasSame(now.minus({ days: 1 }), 'day')) return t('tg.lastSeenYesterday', { time: at.toFormat('HH:mm') });
    return t('tg.lastSeenDate', { date: at.toFormat('dd.MM.yy') });
  }
  if (s.kind === 'RECENTLY') return t('tg.lastSeenRecently');
  if (s.kind === 'LAST_WEEK') return t('tg.lastSeenWeek');
  if (s.kind === 'LAST_MONTH') return t('tg.lastSeenMonth');
  return t('tg.lastSeenLongAgo');
}

export const KIND_EMOJI: Record<TgMediaKind, string> = {
  PHOTO: '🖼', VIDEO: '📹', VIDEO_NOTE: '📹', VOICE: '🎤', AUDIO: '🎵', STICKER: '', GIF: '', FILE: '📎',
  CONTACT: '👤', LOCATION: '📍', POLL: '📊', OTHER: '',
};

/** Ro'yxatdagi oxirgi xabar matni (Telegram kabi: media turi + izoh) */
export function previewOf(m: TgDialog['lastMessage'], t: T): { prefix: string; text: string } {
  if (!m) return { prefix: '', text: '' };
  if (m.service) return { prefix: '', text: t('tg.service') };
  if (m.mediaKind) {
    const kind = t(`tg.kind.${m.mediaKind}`);
    return { prefix: `${KIND_EMOJI[m.mediaKind]}${KIND_EMOJI[m.mediaKind] ? ' ' : ''}`, text: m.text ? m.text.replace(/\s+/g, ' ') : kind };
  }
  return { prefix: '', text: m.text.replace(/\s+/g, ' ') };
}

// ---------------- Formatlangan matn (Telegram entity'lari) ----------------

const LINKS = new Set<TgTextEntity['type']>(['url', 'textUrl', 'email', 'phone', 'mention']);

function hrefOf(e: TgTextEntity, text: string) {
  const s = text.slice(e.offset, e.offset + e.length);
  if (e.type === 'textUrl') return e.url ?? null;
  if (e.type === 'url') return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  if (e.type === 'email') return `mailto:${s}`;
  if (e.type === 'phone') return `tel:${s.replace(/[^\d+]/g, '')}`;
  if (e.type === 'mention') return s.startsWith('@') ? `https://t.me/${s.slice(1)}` : null;
  return null;
}

/** Faqat xavfsiz havolalar (javascript: va h.k. emas) */
const safeHref = (h: string | null) => (h && /^(https?:|mailto:|tel:)/i.test(h) ? h : null);

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return shown ? (
    <span>{children}</span>
  ) : (
    <span role="button" tabIndex={0} onClick={() => setShown(true)} onKeyDown={(e) => e.key === 'Enter' && setShown(true)} className="tg-spoiler">
      {children}
    </span>
  );
}

/**
 * Entity'lar ustma-ust tushishi mumkin (qalin + havola): matn chegaralar bo'yicha bo'laklarga bo'linadi,
 * har bo'lakka uni qoplagan barcha formatlar qo'llanadi. Offset'lar UTF-16 bo'yicha — JS satri bilan bir xil.
 */
export function FormattedText({ text, entities, linkClass }: { text: string; entities: TgTextEntity[]; linkClass: string }) {
  if (!entities.length) return <>{text}</>;
  const cuts = new Set<number>([0, text.length]);
  for (const e of entities) {
    cuts.add(Math.max(0, Math.min(text.length, e.offset)));
    cuts.add(Math.max(0, Math.min(text.length, e.offset + e.length)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const parts: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    const on = entities.filter((e) => e.offset <= a && e.offset + e.length >= b);
    let node: ReactNode = text.slice(a, b);
    const has = (t: TgTextEntity['type']) => on.some((e) => e.type === t);
    const cls = cn(
      has('bold') && 'font-semibold',
      has('italic') && 'italic',
      has('underline') && 'underline',
      has('strike') && 'line-through',
      (has('code') || has('pre')) && 'rounded bg-black/[0.06] px-[3px] font-mono text-[0.9em] dark:bg-on-brand/10',
      has('hashtag') && linkClass,
    );
    if (cls) node = <span className={cls}>{node}</span>;
    if (has('spoiler')) node = <Spoiler>{node}</Spoiler>;
    const link = on.find((e) => LINKS.has(e.type));
    const href = link ? safeHref(hrefOf(link, text)) : null;
    if (href) {
      node = (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cn('break-words hover:underline', linkClass)}>
          {node}
        </a>
      );
    }
    if (has('quote')) node = <span className="my-0.5 block border-l-[3px] border-current pl-2 opacity-90">{node}</span>;
    parts.push(<Fragment key={a}>{node}</Fragment>);
  }
  return <>{parts}</>;
}
