import { Download, MapPin, Pause, Play, User } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fmtDuration, fmtSize } from '@/components/ChatMedia';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { trimCache } from '@/lib/tgCache';
import { errorText } from '@/lib/errors';
import type { TgMessage } from '@/lib/types';

/**
 * Telegram xabaridagi media (V53). Fayl serverda saqlanmaydi: ko'rilganda Telegram'dan server orqali keladi,
 * brauzerda sessiya davomida blob: sifatida keshlanadi.
 */

const blobs = new Map<string, Promise<string>>();

function mediaUrl(peerId: string, msgId: number, thumb = false) {
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

function useMedia(peerId: string, msgId: number, enabled: boolean, thumb = false) {
  const [state, setState] = useState<{ url?: string; error?: unknown }>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    mediaUrl(peerId, msgId, thumb).then(
      (url) => alive && setState({ url }),
      (error) => alive && setState({ error }),
    );
    return () => {
      alive = false;
    };
  }, [peerId, msgId, enabled, thumb]);
  return state;
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

export function TgMediaView({ peerId, m, overlay, radiusClass }: { peerId: string; m: TgMessage; overlay?: ReactNode; radiusClass?: string }) {
  const media = m.media!;
  switch (media.kind) {
    case 'PHOTO':
      return <Photo peerId={peerId} m={m} overlay={overlay} radiusClass={radiusClass} />;
    case 'VIDEO':
    case 'GIF':
      return <VideoBox peerId={peerId} m={m} overlay={overlay} radiusClass={radiusClass} />;
    case 'VIDEO_NOTE':
      return <RoundVideo peerId={peerId} m={m} overlay={overlay} />;
    case 'STICKER':
      return <Sticker peerId={peerId} m={m} overlay={overlay} />;
    case 'VOICE':
    case 'AUDIO':
      return <Voice peerId={peerId} m={m} />;
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
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        </a>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-black/10">
          <Spinner size="small" />
        </div>
      )}
      {overlay}
    </div>
  );
}

function PlayCircle({ loading }: { loading?: boolean }) {
  return (
    <span className="absolute left-1/2 top-1/2 flex h-[54px] w-[54px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-on-brand backdrop-blur-sm">
      {loading ? <Spinner size="small" className="text-on-brand" /> : <Play className="ml-1 h-6 w-6 fill-current" />}
    </span>
  );
}

function VideoBox({ peerId, m, overlay, radiusClass }: { peerId: string; m: TgMessage; overlay?: ReactNode; radiusClass?: string }) {
  const media = m.media!;
  const gif = media.kind === 'GIF';
  // GIF kichik bo'lsa o'zi o'ynaydi (Telegram kabi), video — bosilganda
  const [on, setOn] = useState(gif && (media.size ?? 0) < 5 * 1024 * 1024);
  const thumb = useMedia(peerId, m.id, media.hasThumb, true);
  const full = useMedia(peerId, m.id, on);
  const style = fit(media.width, media.height);
  if (full.error) return <ErrorBox error={full.error} style={style} />;
  return (
    <div className={cn('relative max-w-full overflow-hidden bg-black', radiusClass)} style={style}>
      {on && full.url ? (
        <video src={full.url} className="h-full w-full object-cover" autoPlay playsInline loop={gif} muted={gif} controls={!gif} />
      ) : (
        <button type="button" onClick={() => setOn(true)} className="block h-full w-full cursor-pointer" aria-label="Play">
          {thumb.url && <img src={thumb.url} alt="" className="h-full w-full object-cover blur-[1px]" draggable={false} />}
          <PlayCircle loading={on} />
        </button>
      )}
      {!on && media.durationSec != null && !gif && (
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-xs text-on-brand">{fmtDuration(media.durationSec)}</span>
      )}
      {gif && !on && <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-xs font-medium text-on-brand">GIF</span>}
      {(!on || gif) && overlay}
    </div>
  );
}

function RoundVideo({ peerId, m, overlay }: { peerId: string; m: TgMessage; overlay?: ReactNode }) {
  const [on, setOn] = useState(false);
  const thumb = useMedia(peerId, m.id, m.media!.hasThumb, true);
  const full = useMedia(peerId, m.id, on);
  return (
    <div className="relative h-[240px] w-[240px] max-w-full">
      <div className="h-full w-full overflow-hidden rounded-full bg-black/20">
        {on && full.url ? (
          <video src={full.url} className="h-full w-full object-cover" autoPlay playsInline onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())} />
        ) : (
          <button type="button" onClick={() => setOn(true)} className="relative block h-full w-full cursor-pointer" aria-label="Play">
            {thumb.url && <img src={thumb.url} alt="" className="h-full w-full object-cover" draggable={false} />}
            <PlayCircle loading={on && !full.error} />
          </button>
        )}
      </div>
      {m.media!.durationSec != null && (
        <span className="pointer-events-none absolute bottom-1 left-2 rounded-full bg-black/45 px-1.5 py-0.5 text-xs text-on-brand">{fmtDuration(m.media!.durationSec)}</span>
      )}
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

// ---------------- Ovozli xabar (Telegram to'lqini bilan) ----------------

let playing: HTMLAudioElement | null = null;

function Voice({ peerId, m }: { peerId: string; m: TgMessage }) {
  const { t } = useTranslation();
  const media = m.media!;
  const [want, setWant] = useState(false);
  const { url, error } = useMedia(peerId, m.id, want);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);

  useEffect(() => {
    if (!url) return;
    const a = new Audio(url);
    audio.current = a;
    const onTime = () => {
      setTime(a.currentTime);
      setProgress(a.duration ? a.currentTime / a.duration : 0);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
      setTime(0);
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onPause);
    a.addEventListener('play', onPlay);
    // Bosilgandan keyin yuklangan bo'lsa — darhol o'ynaydi
    if (playing && playing !== a) playing.pause();
    playing = a;
    void a.play().catch(() => undefined);
    return () => {
      a.pause();
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('play', onPlay);
    };
  }, [url]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return setWant(true);
    if (a.paused) {
      if (playing && playing !== a) playing.pause();
      playing = a;
      void a.play();
    } else a.pause();
  };

  const bars = waveBars(media.waveform);
  const accent = m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)';
  const dur = media.durationSec ?? 0;
  return (
    <div className="flex min-w-[240px] items-center gap-3 py-0.5 pr-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        className="flex h-[54px] w-[54px] shrink-0 cursor-pointer items-center justify-center rounded-full text-on-brand transition-transform active:scale-95"
        style={{ background: accent, color: m.out ? 'var(--tg-out)' : '#fff' }}
      >
        {want && !url && !error ? (
          <Spinner size="small" className="text-current" />
        ) : isPlaying ? (
          <Pause className="h-6 w-6 fill-current" />
        ) : media.kind === 'AUDIO' ? (
          <Play className="ml-1 h-6 w-6 fill-current" />
        ) : (
          <Play className="ml-1 h-6 w-6 fill-current" />
        )}
      </button>
      <div className="min-w-0 grow">
        {media.kind === 'VOICE' ? (
          <div
            className="flex h-[23px] cursor-pointer items-end gap-[2px]"
            onClick={(e) => {
              const a = audio.current;
              if (!a || !a.duration) return;
              const r = e.currentTarget.getBoundingClientRect();
              a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
            }}
          >
            {bars.map((v, i) => (
              <span
                key={i}
                className="w-[2px] shrink-0 rounded-full"
                style={{
                  height: `${Math.max(2, (v / 31) * 23)}px`,
                  background: accent,
                  opacity: i / bars.length < progress ? 1 : 0.4,
                }}
              />
            ))}
          </div>
        ) : (
          <div className="truncate text-[15px] font-medium">{media.label || media.fileName || t('tg.kind.AUDIO')}</div>
        )}
        <div className="mt-1 text-[13px]" style={{ color: m.out ? 'var(--tg-out-meta)' : 'var(--tg-in-meta)' }}>
          {error ? errorText(error, t) : isPlaying || time ? fmtDuration(time) : fmtDuration(dur)}
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
