import { Download, MapPin, Pause, Play, User } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fmtDuration, fmtSize } from '@/components/ChatMedia';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { trimCache } from '@/lib/tgCache';
import { registerStarter, trackChanged, trackKey, trackPlaying, trackStopped, useTgPlayer, type TrackKind } from '@/lib/tgPlayer';
import { openViewer } from '@/lib/tgViewerStore';
import { errorText } from '@/lib/errors';
import type { TgMessage } from '@/lib/types';

/**
 * Telegram xabaridagi media (V53). Fayl serverda saqlanmaydi: ko'rilganda Telegram'dan server orqali keladi.
 * Rasm va kichik rasm — brauzerda sessiya davomida blob: sifatida; video va ovoz — oqim bilan (imzoli havola,
 * Range so'rovlari: darhol o'ynaydi, oldinga sakrash mumkin). Rasm/video bosilganda CRM ichidagi ko'ruvchi ochiladi.
 */

const blobs = new Map<string, Promise<string>>();

export function mediaUrl(peerId: string, msgId: number, thumb = false) {
  const key = `${peerId}:${msgId}:${thumb ? 't' : 'f'}`;
  let p = blobs.get(key);
  if (!p) {
    p = api.blob(`/tg/dialogs/${peerId}/media/${msgId}${thumb ? '?thumb=1' : ''}`).then((b) => URL.createObjectURL(b));
    p.catch(() => blobs.delete(key));
    blobs.set(key, p);
    trimCache(blobs, 120);
  }
  return p;
}

// Oqim havolasi 6 soat amal qiladi: 5 soatdan keyin yangisi olinadi
const links = new Map<string, { at: number; p: Promise<string> }>();
const LINK_TTL_MS = 5 * 3600_000;

export function streamUrl(peerId: string, msgId: number) {
  const key = `${peerId}:${msgId}`;
  const hit = links.get(key);
  if (hit && Date.now() - hit.at < LINK_TTL_MS) return hit.p;
  const p = api.get<{ url: string }>(`/tg/dialogs/${peerId}/media/${msgId}/link`).then((r) => r.url);
  p.catch(() => links.delete(key));
  links.set(key, { at: Date.now(), p });
  if (links.size > 400) links.delete(links.keys().next().value!);
  return p;
}

function useLoaded(load: () => Promise<string>, deps: unknown[], enabled: boolean) {
  const [state, setState] = useState<{ url?: string; error?: unknown }>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    load().then(
      (url) => alive && setState({ url }),
      (error) => alive && setState({ error }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  return state;
}

export function useMedia(peerId: string, msgId: number, enabled: boolean, thumb = false) {
  return useLoaded(() => mediaUrl(peerId, msgId, thumb), [peerId, msgId, thumb], enabled);
}

export function useStream(peerId: string, msgId: number, enabled: boolean) {
  return useLoaded(() => streamUrl(peerId, msgId), [peerId, msgId], enabled);
}

/** Telegram kabi: rasm/video o'lchami pufakchaga moslab (eni ≤ 420, bo'yi ≤ 420) */
function fit(w: number | null, h: number | null, maxW = 420, maxH = 420, minW = 160) {
  const W = w || 320;
  const H = h || 240;
  const s = Math.min(1, maxW / W, maxH / H);
  return { width: Math.max(minW, Math.round(W * s)), aspectRatio: `${W} / ${H}` };
}

export function isBubbleless(m: TgMessage) {
  const k = m.media?.kind;
  return !m.text && (k === 'STICKER' || k === 'VIDEO_NOTE');
}

/** Rasm/video — pufakcha chetiga yopishadi (ichki chegara yo'q) */
export function isVisual(m: TgMessage) {
  const k = m.media?.kind;
  return k === 'PHOTO' || k === 'VIDEO' || k === 'GIF';
}

export function TgMediaView({
  peerId,
  m,
  author,
  overlay,
  radiusClass,
}: {
  peerId: string;
  m: TgMessage;
  /** Pleer panelida ko'rinadigan muallif («Siz», guruhda yozgan odam yoki chat nomi) */
  author: string;
  overlay?: ReactNode;
  radiusClass?: string;
}) {
  const media = m.media!;
  switch (media.kind) {
    case 'PHOTO':
      return <Photo peerId={peerId} m={m} overlay={overlay} radiusClass={radiusClass} />;
    case 'VIDEO':
    case 'GIF':
      return <VideoBox peerId={peerId} m={m} overlay={overlay} radiusClass={radiusClass} />;
    case 'VIDEO_NOTE':
      return <RoundVideo peerId={peerId} m={m} overlay={overlay} author={author} />;
    case 'STICKER':
      return <Sticker peerId={peerId} m={m} overlay={overlay} />;
    case 'VOICE':
    case 'AUDIO':
      return <Voice peerId={peerId} m={m} author={author} />;
    case 'FILE':
      return <FileDoc peerId={peerId} m={m} />;
    case 'CONTACT':
      return <Info m={m} icon={<User className="h-6 w-6" />} />;
    case 'LOCATION':
      return <Info m={m} icon={<MapPin className="h-6 w-6" />} />;
    default:
      return <Info m={m} icon={<span className="text-xl">📊</span>} />;
  }
}

function ErrorBox({ error, style }: { error: unknown; style?: React.CSSProperties }) {
  const { t } = useTranslation();
  return (
    <div style={style} className="flex max-w-full items-center justify-center bg-black/10 p-3 text-center text-xs opacity-80">
      {errorText(error, t)}
    </div>
  );
}

function Photo({ peerId, m, overlay, radiusClass }: { peerId: string; m: TgMessage; overlay?: ReactNode; radiusClass?: string }) {
  const { url, error } = useMedia(peerId, m.id, true);
  const style = fit(m.media!.width, m.media!.height);
  if (error) return <ErrorBox error={error} style={style} />;
  return (
    <div className={cn('relative max-w-full overflow-hidden', radiusClass)} style={style}>
      {url ? (
        <button type="button" onClick={() => openViewer(peerId, m.id)} className="block h-full w-full cursor-zoom-in" aria-label="Open">
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        </button>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-black/10">
          <Spinner size="small" />
        </div>
      )}
      {overlay}
    </div>
  );
}

function PlayCircle({ loading, small }: { loading?: boolean; small?: boolean }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-on-brand backdrop-blur-sm',
        small ? 'h-11 w-11' : 'h-[54px] w-[54px]',
      )}
    >
      {loading ? <Spinner size="small" className="text-on-brand" /> : <Play className={cn('ml-1 fill-current', small ? 'h-5 w-5' : 'h-6 w-6')} />}
    </span>
  );
}

/** Pufakchadagi video: Telegram kabi kichik rasm + ▶ + davomiylik; bosilsa ko'ruvchida o'ynaydi. GIF — o'zi ovozsiz aylanadi */
function VideoBox({ peerId, m, overlay, radiusClass }: { peerId: string; m: TgMessage; overlay?: ReactNode; radiusClass?: string }) {
  const media = m.media!;
  const gif = media.kind === 'GIF';
  const thumb = useMedia(peerId, m.id, media.hasThumb, true);
  const src = useStream(peerId, m.id, gif);
  const style = fit(media.width, media.height);
  return (
    <button
      type="button"
      onClick={() => openViewer(peerId, m.id)}
      className={cn('relative block max-w-full cursor-pointer overflow-hidden bg-black', radiusClass)}
      style={style}
      aria-label="Play"
    >
      {gif && src.url ? (
        <video src={src.url} poster={thumb.url} className="h-full w-full object-cover" autoPlay loop muted playsInline />
      ) : (
        thumb.url && <img src={thumb.url} alt="" className="h-full w-full object-cover" draggable={false} />
      )}
      {!gif && <PlayCircle />}
      {!gif && (
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-xs text-on-brand">
          {media.durationSec != null ? fmtDuration(media.durationSec) : ''}
          {media.size ? `${media.durationSec != null ? ' · ' : ''}${fmtSize(media.size)}` : ''}
        </span>
      )}
      {gif && <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-xs font-medium text-on-brand">GIF</span>}
      {overlay}
    </button>
  );
}

// ---------------- Dumaloq video xabar ----------------

/**
 * Telegram kabi: bosilsa ovoz bilan o'ynaydi va kattalashadi, atrofida progress halqasi; yana bosilsa — pauza.
 * Tugasa kichrayadi va shu chatdagi keyingi ovozli/dumaloq xabar o'zi boshlanadi.
 */
function RoundVideo({ peerId, m, overlay, author }: { peerId: string; m: TgMessage; overlay?: ReactNode; author: string }) {
  const media = m.media!;
  const key = trackKey(peerId, m.id);
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);
  const thumb = useMedia(peerId, m.id, media.hasThumb, true);
  const src = useStream(peerId, m.id, active);
  const ref = useRef<HTMLVideoElement | null>(null);
  const meta = useRef({ author, date: m.date });
  meta.current = { author, date: m.date };
  const { track, paused } = useTgPlayer();
  const isCur = track?.key === key;

  const start = useCallback(() => {
    const v = ref.current;
    if (v) void v.play().catch(() => undefined);
    else setActive(true);
  }, []);
  useEffect(() => registerStarter(key, { peerId, msgId: m.id, kind: 'VIDEO_NOTE', start }), [key, peerId, m.id, start]);

  // Komponent yo'qolsa (chat almashsa) — to'xtaydi
  useEffect(
    () => () => {
      const v = ref.current;
      if (v) {
        v.pause();
        trackStopped(v, false);
      }
    },
    [],
  );

  const onClick = () => {
    const v = ref.current;
    if (!active || !v) return setActive(true);
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const big = active && isCur;
  const size = big ? 320 : 240;
  const R = 48;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative max-w-full transition-[width,height] duration-200" style={{ width: size, height: size }}>
      <button type="button" onClick={onClick} className="relative block h-full w-full cursor-pointer overflow-hidden rounded-full bg-black/20" aria-label={active && !paused ? 'Pause' : 'Play'}>
        {thumb.url && <img src={thumb.url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />}
        {active && src.url && (
          <video
            ref={ref}
            src={src.url}
            className="absolute inset-0 h-full w-full object-cover"
            autoPlay
            playsInline
            onPlay={(e) => trackPlaying({ key, peerId, msgId: m.id, kind: 'VIDEO_NOTE', title: meta.current.author, date: meta.current.date, el: e.currentTarget })}
            onPause={() => trackChanged()}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setTime(v.currentTime);
              setProgress(v.duration ? v.currentTime / v.duration : 0);
            }}
            onEnded={(e) => {
              const v = e.currentTarget;
              ref.current = null;
              setActive(false);
              setProgress(0);
              setTime(0);
              trackStopped(v, true);
            }}
          />
        )}
        {(!active || !src.url || (isCur && paused)) && <PlayCircle loading={active && !src.url && !src.error} small />}
      </button>
      {/* Progress halqasi */}
      {active && (
        <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.6" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
        </svg>
      )}
      <span className="pointer-events-none absolute bottom-1 left-2 rounded-full bg-black/45 px-1.5 py-0.5 text-xs text-on-brand">
        {active ? fmtDuration(time) : media.durationSec != null ? fmtDuration(media.durationSec) : ''}
      </span>
      {overlay}
    </div>
  );
}

function Sticker({ peerId, m, overlay }: { peerId: string; m: TgMessage; overlay?: ReactNode }) {
  const media = m.media!;
  const image = media.mime === 'image/webp';
  const video = media.mime === 'video/webm';
  const { url } = useMedia(peerId, m.id, image || video);
  const box = fit(media.width ?? 512, media.height ?? 512, 180, 180, 60);
  return (
    <div className="relative" style={box}>
      {url && image && <img src={url} alt={media.label ?? ''} className="h-full w-full object-contain" draggable={false} />}
      {url && video && <video src={url} className="h-full w-full object-contain" autoPlay loop muted playsInline />}
      {/* Animatsiyali (.tgs) stiker brauzerda o'ynamaydi: Telegram kabi emoji */}
      {!image && !video && <span className="flex h-full w-full items-center justify-center text-[96px] leading-none">{media.label || '💟'}</span>}
      {overlay}
    </div>
  );
}


// ---------------- Ovozli xabar va audio (Telegram to'lqini bilan) ----------------

function Voice({ peerId, m, author }: { peerId: string; m: TgMessage; author: string }) {
  const { t } = useTranslation();
  const media = m.media!;
  const kind = media.kind as TrackKind;
  const key = trackKey(peerId, m.id);
  const [want, setWant] = useState(false);
  const { url, error } = useStream(peerId, m.id, want);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);
  const meta = useRef({ author, date: m.date });
  meta.current = { author, date: m.date };
  const { track, paused } = useTgPlayer();
  const isPlaying = track?.key === key && !paused;

  useEffect(() => {
    if (!url) return;
    const a = new Audio(url);
    a.preload = 'auto';
    audio.current = a;
    const onTime = () => {
      setTime(a.currentTime);
      setProgress(a.duration ? a.currentTime / a.duration : 0);
    };
    const onEnd = () => {
      setProgress(0);
      setTime(0);
      trackStopped(a, true);
    };
    const onPause = () => trackChanged();
    const onPlay = () => trackPlaying({ key, peerId, msgId: m.id, kind, title: meta.current.author, date: meta.current.date, el: a });
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onPause);
    a.addEventListener('play', onPlay);
    // Bosilgandan keyin yuklangan — darhol o'ynaydi
    void a.play().catch(() => undefined);
    return () => {
      a.pause();
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('play', onPlay);
      trackStopped(a, false);
      audio.current = null;
    };
  }, [url, key, peerId, m.id, kind]);

  const start = useCallback(() => {
    const a = audio.current;
    if (!a) return setWant(true);
    void a.play().catch(() => undefined);
  }, []);
  useEffect(() => registerStarter(key, { peerId, msgId: m.id, kind, start }), [key, peerId, m.id, kind, start]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return setWant(true);
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  };

  const seek = (e: React.MouseEvent<HTMLElement>) => {
    const a = audio.current;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (!a) return setWant(true);
    if (!a.duration) return;
    a.currentTime = f * a.duration;
    if (a.paused) void a.play().catch(() => undefined);
  };

  const bars = waveBars(media.waveform);
  const accent = m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)';
  const dur = media.durationSec ?? 0;
  const loading = want && !url && !error;
  return (
    <div className="flex min-w-[240px] items-center gap-3 py-0.5 pr-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        className="flex h-[54px] w-[54px] shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform active:scale-95"
        style={{ background: accent, color: m.out ? 'var(--tg-out)' : '#fff' }}
      >
        {loading ? <Spinner size="small" className="text-current" /> : isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="ml-1 h-6 w-6 fill-current" />}
      </button>
      <div className="min-w-0 grow">
        {kind === 'VOICE' ? (
          <div className="flex h-[23px] cursor-pointer items-end gap-[2px]" onClick={seek}>
            {bars.map((v, i) => (
              <span
                key={i}
                className="w-[2px] shrink-0 rounded-full"
                style={{ height: `${Math.max(2, (v / 31) * 23)}px`, background: accent, opacity: i / bars.length < progress ? 1 : 0.4 }}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="truncate text-[15px] font-medium">{media.label || media.fileName || t('tg.kind.AUDIO')}</div>
            <div className="cursor-pointer py-1.5" onClick={seek}>
              <div className="h-[3px] rounded-full" style={{ background: `linear-gradient(to right, ${accent} ${progress * 100}%, rgba(127,127,127,0.35) ${progress * 100}%)` }} />
            </div>
          </>
        )}
        <div className="mt-1 text-[13px]" style={{ color: m.out ? 'var(--tg-out-meta)' : 'var(--tg-in-meta)' }}>
          {error ? errorText(error, t) : isPlaying || time ? fmtDuration(time) : fmtDuration(dur)}
          {kind === 'AUDIO' && media.size ? ` · ${fmtSize(media.size)}` : ''}
        </div>
      </div>
    </div>
  );
}

/** To'lqinni ~40 ta ustunga keltirish (Telegram ham shuncha ko'rsatadi) */
function waveBars(w: number[] | null) {
  const N = 40;
  if (!w?.length) return Array.from({ length: N }, (_, i) => 6 + ((i * 7) % 11));
  return Array.from({ length: N }, (_, i) => {
    const from = Math.floor((i * w.length) / N);
    const to = Math.max(from + 1, Math.floor(((i + 1) * w.length) / N));
    return Math.max(...w.slice(from, to));
  });
}

// ---------------- Hujjat ----------------

const EXT_COLORS: [RegExp, string][] = [
  [/^(pdf)$/i, '#e44f4f'],
  [/^(xls|xlsx|csv|ods)$/i, '#47a447'],
  [/^(doc|docx|rtf|odt|txt)$/i, '#3a8ed6'],
  [/^(zip|rar|7z|tar|gz)$/i, '#f0a32f'],
];

function FileDoc({ peerId, m }: { peerId: string; m: TgMessage }) {
  const { t } = useTranslation();
  const media = m.media!;
  const [busy, setBusy] = useState(false);
  const name = media.fileName ?? `telegram-${m.id}`;
  const ext = name.includes('.') ? name.split('.').pop()!.slice(0, 4) : '';
  const color = EXT_COLORS.find(([re]) => re.test(ext))?.[1] ?? (m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)');
  const thumb = useMedia(peerId, m.id, media.hasThumb, true);
  return (
    <button
      type="button"
      disabled={busy}
      title={t('tg.download')}
      onClick={async () => {
        setBusy(true);
        try {
          await api.download(`/tg/dialogs/${peerId}/media/${m.id}`, name);
        } catch (e) {
          toast.error(errorText(e, t));
        } finally {
          setBusy(false);
        }
      }}
      className="group flex min-w-[240px] max-w-full cursor-pointer items-center gap-3 py-0.5 pr-2 text-left"
    >
      <span className="relative flex h-[54px] w-[54px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-on-brand" style={{ background: color }}>
        {thumb.url ? (
          <img src={thumb.url} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="text-[13px] font-semibold uppercase">{ext || <Download className="h-6 w-6" />}</span>
        )}
        <span className={cn('absolute inset-0 flex items-center justify-center bg-black/30 transition-opacity', busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
          {busy ? <Spinner size="small" className="text-on-brand" /> : <Download className="h-6 w-6" />}
        </span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium">{name}</span>
        <span className="block text-[13px]" style={{ color: m.out ? 'var(--tg-out-meta)' : 'var(--tg-in-meta)' }}>
          {media.size != null ? fmtSize(media.size) : ''}
        </span>
      </span>
    </button>
  );
}

function Info({ m, icon }: { m: TgMessage; icon: ReactNode }) {
  const { t } = useTranslation();
  const media = m.media!;
  return (
    <div className="flex min-w-[200px] items-center gap-3 py-0.5 pr-2">
      <span
        className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-full text-on-brand"
        style={{ background: m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)', color: m.out ? 'var(--tg-out)' : '#fff' }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-medium">{media.kind === 'CONTACT' && media.label ? media.label.split(' · ')[0] : t(`tg.kind.${media.kind}`)}</span>
        {media.label && (
          <span className="block truncate text-[13px]" style={{ color: m.out ? 'var(--tg-out-meta)' : 'var(--tg-in-meta)' }}>
            {media.kind === 'CONTACT' ? media.label.split(' · ').slice(1).join(' · ') : media.label}
          </span>
        )}
      </span>
    </div>
  );
}
