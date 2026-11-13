import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtIsoDate, fmtTime, TZ } from '@/lib/time';
import type { ServerStatus } from '@/lib/types';

/** Necha kun qolganda ko'rinadi (eslatma bilan bir xil: 3, 1, 0 kun) */
const SHOW_DAYS = 3;
/** Banner balandligi — Layout sidebar/header'ni shuncha pastga suradi */
export const BANNER_H = 38;
const DISMISS_KEY = 'server-banner-dismissed';

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};

/**
 * Tarif tugashi / to'lov yaqin bo'lsa — sahifaning eng yuqorisida ogohlantirish va orqaga sanoq (faqat rahbar).
 * So'rov: sahifa ochilganda va har 30 daqiqada bitta (server ham 1 daqiqa keshlaydi). Sanoq brauzerda har soniya —
 * serverga so'rov yubormaydi.
 * × bilan yopilsa — shu kun oxirigacha (ertasi kuni yoki holat o'zgarsa yana chiqadi; eslatma ham har kuni keladi).
 */
export function useServerBillingBanner(enabled: boolean) {
  const q = useQuery({
    queryKey: ['server', 'status'],
    queryFn: () => api.get<ServerStatus>('/server/status'),
    enabled,
    staleTime: 60_000,
    refetchInterval: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [dismissed, setDismissed] = useState(readDismissed);
  const b = q.data?.billing;
  if (!enabled || !b) return null;
  // Kompyuter soati xato bo'lsa ham sanoq server soati bo'yicha: farq = server vaqti − javob kelgan paytdagi brauzer vaqti
  const clockOffset = q.data?.serverTime ? Date.parse(q.data.serverTime) - q.dataUpdatedAt : 0;
  if (!b.paymentFailed && (b.daysLeft == null || b.daysLeft > SHOW_DAYS)) return null;
  const key = `${b.paymentFailed ? 'failed' : b.trial ? 'trial' : 'payment'}|${b.nextPaymentDate}|${DateTime.now().setZone(TZ).toISODate()}`;
  if (dismissed === key) return null;
  // Aniq vaqt bo'lmasa — o'sha kun oxiri (Toshkent)
  const target = b.nextPaymentAt
    ? DateTime.fromISO(b.nextPaymentAt)
    : b.nextPaymentDate
      ? DateTime.fromISO(b.nextPaymentDate, { zone: TZ }).endOf('day')
      : null;
  const dismiss = () => {
    setDismissed(key);
    try {
      localStorage.setItem(DISMISS_KEY, key);
    } catch {
      /* saqlanmasa — faqat shu sahifa ochiqligida yopiladi */
    }
  };
  return { billing: b, target, dismiss, clockOffset };
}

/** Har soniya yangilanadi; har safar soatdan qayta hisoblanadi (fon tab yoki uyqu rejimidan keyin ham siljimaydi) */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;
/** Almashib turadigan matn: har 3 soniyada, 0.3 s davomida so'nib tepaga siljiydi */
const ROTATE_MS = 3000;
const FADE_MS = 300;

/** Matnlar ro'yxatini 3 soniyada almashtiradi; `leaving` — chiqib ketish animatsiyasi */
function useRotation(count: number) {
  const [idx, setIdx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (count < 2) return;
    let fade: number | undefined;
    const id = window.setInterval(() => {
      setLeaving(true);
      fade = window.setTimeout(() => {
        setIdx((i) => i + 1);
        setLeaving(false);
      }, FADE_MS);
    }, ROTATE_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(fade);
    };
  }, [count]);
  return { idx: count ? idx % count : 0, leaving };
}

export function ServerBillingBanner({ data }: { data: NonNullable<ReturnType<typeof useServerBillingBanner>> }) {
  const { t } = useTranslation();
  const now = useNow();
  const { billing: b, target, dismiss, clockOffset } = data;
  const left = target ? Math.max(0, target.toMillis() - (now + clockOffset)) : null;
  const ended = left === 0;
  // 1–3 kun — warning (amber); 1 kundan kam, tugagan yoki to'lov o'tmagan — critical (qizil)
  const critical = b.paymentFailed || (left != null && left < DAY_MS);

  const at = b.nextPaymentAt
    ? t('server.banner.at', { date: fmtIsoDate(b.nextPaymentDate), time: fmtTime(b.nextPaymentAt) })
    : fmtIsoDate(b.nextPaymentDate) || '—';
  const kind = b.paymentFailed ? 'failed' : ended ? 'ended' : b.trial ? 'trial' : 'payment';
  const messages = t(`server.banner.${kind}`, { at, returnObjects: true }) as unknown as string[];
  const { idx, leaving } = useRotation(messages.length);

  let clock: string | null = null;
  let days = 0;
  if (left != null && !b.paymentFailed && !ended) {
    const s = Math.floor(left / 1000);
    days = Math.floor(s / 86400);
    clock = `${pad(Math.floor((s % 86400) / 3600))} : ${pad(Math.floor((s % 3600) / 60))} : ${pad(s % 60)}`;
  }

  return (
    <div
      role="alert"
      style={{ height: BANNER_H }}
      className={cn(
        'billing-banner group fixed inset-x-0 top-0 z-[60] flex items-center overflow-hidden pr-3 text-xs text-on-brand shadow-sm transition-[filter] hover:brightness-110 sm:pr-4 sm:text-sm',
        critical ? 'billing-banner-critical' : 'billing-banner-warning',
      )}
    >
      <span className="shimmer-effect" aria-hidden />
      <Link to="/server" className="relative flex h-full min-w-0 flex-1 items-center gap-2 pl-3 sm:pl-4">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span
          aria-live="polite"
          className={cn(
            'min-w-0 truncate font-medium transition-[opacity,transform] duration-300',
            leaving ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
          )}
        >
          {messages[idx]}
        </span>
        <span className="flex-1" />
        {clock && (
          <span className="flex shrink-0 items-center gap-2">
            <span className="hidden text-[11px] font-semibold uppercase tracking-wide opacity-80 sm:inline">{t('server.banner.left')}</span>
            <span className="rounded-md bg-white/30 px-2 py-0.5 font-mono text-xs font-semibold tabular-nums">
              {days > 0 && <>{t('server.days', { n: days })} · </>}
              {clock}
            </span>
          </span>
        )}
        <ChevronRight className="h-[18px] w-[18px] shrink-0" />
      </Link>
      <button
        type="button"
        onClick={dismiss}
        title={t('server.banner.dismiss')}
        aria-label={t('server.banner.dismiss')}
        className="relative ml-0 flex h-7 w-0 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md opacity-0 transition-all duration-200 hover:bg-white/20 focus-visible:ml-1 focus-visible:w-7 focus-visible:opacity-100 group-hover:ml-1 group-hover:w-7 group-hover:opacity-100 [@media(hover:none)]:ml-1 [@media(hover:none)]:w-7 [@media(hover:none)]:opacity-100"
      >
        <X className="h-[18px] w-[18px] shrink-0" />
      </button>
    </div>
  );
}
