import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Loader2, PhoneIncoming, PhoneMissed, PhoneOutgoing, Play, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card, CardHeader } from '@/components/ui/card';
import { Empty, QueryState } from '@/components/ui/states';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { fmtDateTime } from '@/lib/time';
import type { CallRecord, CallsOfContact } from '@/lib/types';

// IP telefoniya qo'ng'iroqlari (V46): jurnal sahifasi, mijoz kartasi va lead oynasi uchun umumiy ko'rinish

/** Davomiylik: 75 -> '1:15', 3725 -> '1:02:05' */
export function fmtCallDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Tashqi raqam (oxirgi 9 raqam): '901234567' -> '+998 90 123 45 67' */
export function fmtCallNumber(n: string | null | undefined) {
  if (!n) return '—';
  if (/^\d{9}$/.test(n)) return `+998 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
  return n;
}

export const isMissed = (c: Pick<CallRecord, 'disposition'>) => c.disposition !== 'ANSWERED';

/** Yo'nalish belgisi: javobsiz — qizil */
export function CallIcon({ call, className }: { call: Pick<CallRecord, 'direction' | 'disposition'>; className?: string }) {
  const { t } = useTranslation();
  const missed = isMissed(call);
  const Icon = call.direction === 'INTERNAL' ? ArrowLeftRight : call.direction === 'OUT' ? PhoneOutgoing : missed ? PhoneMissed : PhoneIncoming;
  const label = `${t(`calls.dir.${call.direction}`)} · ${dispositionText(call.disposition, t)}`;
  return (
    <Icon
      className={cn('h-4 w-4 shrink-0', missed ? 'text-overdue' : call.direction === 'OUT' ? 'text-brand-500' : 'text-done', className)}
      aria-label={label}
      role="img"
    >
      <title>{label}</title>
    </Icon>
  );
}

export function dispositionText(d: string, t: (k: string, o?: Record<string, unknown>) => string) {
  const key = `calls.disp.${d}`;
  const s = t(key);
  return s === key ? d : s;
}

// Ochilgan yozuvlar sessiya davomida xotirada (qayta bosilganda Telegram'dan qayta olinmaydi)
const recordingUrls = new Map<number, string>();
// Bir vaqtda bitta yozuv: yangisi chala boshlasa oldingisi pauza (bir nechta pleer ochiq tursa ham ovoz aralashmasin)
let playing: HTMLAudioElement | null = null;

/**
 * Qo'ng'iroq audio yozuvi (V48): faqat rahbarga keladi (server boshqalarga recordingId bermaydi).
 * Fayl Authorization bilan olinadi, shuning uchun <audio src> o'rniga blob: URL.
 */
export function RecordingPlayer({ id, className }: { id: number; className?: string }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(() => recordingUrls.get(id) ?? null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const load = async () => {
    setOpen(true);
    if (url) return;
    setLoading(true);
    try {
      const u = URL.createObjectURL(await api.blob(`/calls/recordings/${id}`));
      recordingUrls.set(id, u);
      setUrl(u);
    } catch (e) {
      setOpen(false);
      toast.error(errorText(e, t));
    } finally {
      setLoading(false);
    }
  };
  if (open && url) {
    return (
      <span className={cn('inline-flex max-w-full items-center gap-1', className)}>
        <audio
          controls
          autoPlay
          src={url}
          className="h-8 w-56 max-w-full"
          aria-label={t('calls.recording')}
          onPlay={(e) => {
            if (playing && playing !== e.currentTarget) playing.pause();
            playing = e.currentTarget;
          }}
          onPause={(e) => {
            if (playing === e.currentTarget) playing = null;
          }}
        />
        {/* Yopish: pleer yo'qoladi (ovoz to'xtaydi), qatorda yana ▶ */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          title={t('common.close')}
          aria-label={t('common.close')}
          className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      title={loading ? t('calls.recordingLoading') : t('calls.play')}
      aria-label={t('calls.play')}
      className={cn(
        'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-brand-light text-brand transition-colors hover:bg-brand-500 hover:text-on-brand disabled:cursor-wait',
        className,
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Mijoz kartasi / lead oynasidagi blok: shu kontakt telefonlari bo'yicha qo'ng'iroqlar */
export function ContactCalls({ kind, id, card = true }: { kind: 'client' | 'lead'; id: number; card?: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['calls', kind, id],
    queryFn: () => api.get<CallsOfContact>(`/calls/${kind}/${id}${qs({ limit: 20 })}`),
  });
  const d = q.data;
  const body = (
    <QueryState q={q}>
      {d && !d.phone ? (
        <Empty text={t('calls.noPhone')} />
      ) : !d?.items.length ? (
        <Empty text={t('calls.noCalls')} />
      ) : (
        <>
          <div className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500', card ? 'px-4 pb-2' : 'mb-2')}>
            <span>{t('calls.total')}: <b className="text-foreground">{d.total}</b></span>
            <span>{t('calls.talkTime')}: <b className="text-foreground">{fmtCallDuration(d.talkSec)}</b></span>
          </div>
          <ul className={cn('divide-y text-sm', !card && 'rounded-lg border border-gray-200')}>
            {d.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <CallIcon call={c} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{c.userName ?? (c.ext ? `${t('calls.unassigned')} (${c.ext})` : '—')}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {fmtDateTime(c.startedAt)} · {fmtCallNumber(c.externalNumber)}
                  </div>
                </div>
                <span className={cn('shrink-0 text-xs tabular-nums', isMissed(c) ? 'text-overdue' : 'text-gray-600')}>
                  {isMissed(c) ? dispositionText(c.disposition, t) : fmtCallDuration(c.billsec)}
                </span>
                {c.recordingId && <RecordingPlayer id={c.recordingId} />}
              </li>
            ))}
          </ul>
        </>
      )}
    </QueryState>
  );
  if (!card) return body;
  return (
    <Card>
      <CardHeader title={t('calls.title')} />
      {body}
    </Card>
  );
}
