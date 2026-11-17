import {
  ChevronLeft,
  ChevronRight,
  Download,
  Forward,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Volume1,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fmtDuration } from '@/components/ChatMedia';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { pauseTrack } from '@/lib/tgPlayer';
import { closeViewer, openViewer, useViewer } from '@/lib/tgViewerStore';
import type { TgMessage } from '@/lib/types';
import { mediaUrl, streamUrl, useMedia, useStream } from './TgMedia';
import { FormattedText, TgAvatar, dtOf } from './tgUi';

/**
 * Rasm va video ko'ruvchisi — Telegram Desktop/Web kabi, CRM ichida butun ekranda (alohida oyna/tab emas):
 * tepada muallif va sana, uzatish/yuklab olish/yopish; o'rtada rasm (g'ildirak yoki ikki bosish bilan kattalashadi,
 * sudrab suriladi) yoki video (o'z pleeri: pauza, vaqt chizig'i, ovoz, tezlik, kichik oyna, to'liq ekran);
 * chap/o'ng — shu chatdagi oldingi/keyingi rasm yoki video; pastda izoh. Esc, ←/→, bo'sh joy (pauza) ishlaydi.
 */

const isViewable = (m: TgMessage) => !!m.media && (m.media.kind === 'PHOTO' || m.media.kind === 'VIDEO' || m.media.kind === 'GIF');

export function TgViewer({
  peerId,
  messages,
  authorOf,
  onForward,
}: {
  peerId: string;
  messages: TgMessage[];
  authorOf: (m: TgMessage) => string;
  onForward: (msgId: number) => void;
}) {
  const open = useViewer();
  // Boshqa chatga o'tilsa ko'ruvchi yopiladi
  useEffect(() => () => closeViewer(), [peerId]);
  if (!open || open.peerId !== peerId) return null;
  return <Viewer peerId={peerId} msgId={open.msgId} messages={messages} authorOf={authorOf} onForward={onForward} />;
}

function Viewer({
  peerId,
  msgId,
  messages,
  authorOf,
  onForward,
}: {
  peerId: string;
  msgId: number;
  messages: TgMessage[];
  authorOf: (m: TgMessage) => string;
  onForward: (msgId: number) => void;
}) {
  const { t } = useTranslation();
  const items = useMemo(() => messages.filter(isViewable), [messages]);
  const idx = items.findIndex((m) => m.id === msgId);
  const m = idx >= 0 ? items[idx] : null;
  const prev = idx > 0 ? items[idx - 1] : null;
  const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);

  // Xabar o'chirilsa — yopiladi
  useEffect(() => {
    if (!m) closeViewer();
  }, [m]);
  useEffect(() => setZoom(1), [msgId]);

  // Qo'shni rasmlar oldindan yuklanadi (o'tish darhol bo'lsin)
  useEffect(() => {
    for (const x of [prev, next]) if (x?.media?.kind === 'PHOTO') void mediaUrl(peerId, x.id).catch(() => undefined);
  }, [peerId, prev, next]);

  const go = useCallback((x: TgMessage | null) => x && openViewer(peerId, x.id), [peerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (document.fullscreenElement) return;
        closeViewer();
      } else if (e.key === 'ArrowLeft') go(prev);
      else if (e.key === 'ArrowRight') go(next);
      else if ((e.key === '+' || e.key === '=') && m?.media?.kind === 'PHOTO') setZoom((z) => Math.min(4, z + 0.5));
      else if (e.key === '-' && m?.media?.kind === 'PHOTO') setZoom((z) => Math.max(1, z - 0.5));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, prev, next, m]);

  // Sensorli ekran: chapga/o'ngga surish — keyingi/oldingi, pastga — yopish
  const touch = useRef<{ x: number; y: number } | null>(null);

  if (!m) return null;
  const media = m.media!;
  const isPhoto = media.kind === 'PHOTO';
  const author = authorOf(m);
  const d = dtOf(m.date);
  const months = t('months', { returnObjects: true }) as string[];
  const kindLabel = t(`tg.kind.${media.kind}`);

  const download = async () => {
    if (downloading) return;
    if (!isPhoto) {
      // Video katta bo'lishi mumkin: oqim havolasi orqali, bo'lak-bo'lak (serverda to'planmaydi)
      try {
        const url = await streamUrl(peerId, m.id);
        Object.assign(document.createElement('a'), { href: `${url}?dl=1`, download: media.fileName ?? '' }).click();
      } catch (e) {
        toast.error(errorText(e, t));
      }
      return;
    }
    setDownloading(true);
    try {
      await api.download(`/tg/dialogs/${peerId}/media/${m.id}`, media.fileName ?? `photo-${m.id}.jpg`);
    } catch (e) {
      toast.error(errorText(e, t));
    } finally {
      setDownloading(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={kindLabel}
      className="tg fixed inset-0 z-[95] flex animate-fade-in flex-col bg-black/90 text-white"
      onTouchStart={(e) => {
        if (zoom > 1 || e.touches.length !== 1) return;
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const s = touch.current;
        touch.current = null;
        if (!s) return;
        const dx = e.changedTouches[0].clientX - s.x;
        const dy = e.changedTouches[0].clientY - s.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? next : prev);
        else if (dy > 110 && Math.abs(dy) > Math.abs(dx)) closeViewer();
      }}
    >
      {/* Tepa: muallif, sana, amallar */}
      <div className="relative z-[2] flex h-14 shrink-0 items-center gap-3 px-2 sm:px-4">
        <TgAvatar peerId={m.out ? '1' : (m.senderId ?? peerId)} name={author} size={40} photoId={m.out ? null : undefined} />
        <div className="min-w-0 grow">
          <div className="truncate text-[15px] font-medium">{author}</div>
          <div className="truncate text-[13px] text-white/60">
            {`${d.day} ${months[d.month - 1]}${d.year !== dtOf(Date.now() / 1000).year ? ` ${d.year}` : ''}, ${d.toFormat('HH:mm')}`}
            {items.length > 1 && ` · ${t('tg.mediaOf', { kind: kindLabel, n: idx + 1, total: items.length })}`}
          </div>
        </div>
        {isPhoto && (
          <>
            <ViewerBtn label={t('tg.zoomOut')} onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} className="max-sm:hidden">
              <ZoomOut className="h-[22px] w-[22px]" />
            </ViewerBtn>
            <ViewerBtn label={t('tg.zoomIn')} onClick={() => setZoom((z) => Math.min(4, z + 0.5))} disabled={zoom >= 4} className="max-sm:hidden">
              <ZoomIn className="h-[22px] w-[22px]" />
            </ViewerBtn>
          </>
        )}
        <ViewerBtn
          label={t('tg.forward')}
          onClick={() => {
            closeViewer();
            onForward(m.id);
          }}
        >
          <Forward className="h-[22px] w-[22px]" />
        </ViewerBtn>
        <ViewerBtn label={t('tg.download')} onClick={() => void download()}>
          {downloading ? <Spinner size="small" className="text-white" /> : <Download className="h-[22px] w-[22px]" />}
        </ViewerBtn>
        <ViewerBtn label={t('common.close')} onClick={closeViewer}>
          <X className="h-6 w-6" />
        </ViewerBtn>
      </div>

      {/* O'rta: media. Bo'sh joy bosilsa yopiladi */}
      <div className="relative flex min-h-0 grow items-center justify-center overflow-hidden px-2 sm:px-16" onClick={(e) => e.target === e.currentTarget && closeViewer()}>
        {isPhoto ? (
          <ZoomImage key={m.id} peerId={peerId} m={m} zoom={zoom} setZoom={setZoom} onBackdrop={closeViewer} />
        ) : (
          <VideoPlayer key={m.id} peerId={peerId} m={m} />
        )}
        {prev && <NavZone side="left" label={t('tg.prevMedia')} onClick={() => go(prev)} />}
        {next && <NavZone side="right" label={t('tg.nextMedia')} onClick={() => go(next)} />}
      </div>

      {/* Izoh */}
      {m.text ? (
        <div className="tg-scroll mx-auto max-h-[22vh] w-full max-w-[720px] shrink-0 overflow-y-auto whitespace-pre-wrap break-words px-4 pb-4 pt-2 text-center text-[15px] leading-snug">
          <FormattedText text={m.text} entities={m.entities} linkClass="text-[#8cc8ff]" />
        </div>
      ) : (
        <div className="h-4 shrink-0" />
      )}
    </div>,
    document.body,
  );
}

function ViewerBtn({ label, onClick, children, disabled, className }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Chap/o'ng chekka: butun balandlik bo'yicha bosiladigan zona (Telegram Desktop kabi), sensorli ekranda yashirin */
function NavZone({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'group absolute inset-y-0 z-[1] hidden w-[72px] cursor-pointer items-center justify-center sm:flex',
        side === 'left' ? 'left-0' : 'right-0',
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/0 text-white/50 transition-colors group-hover:bg-white/10 group-hover:text-white">
        {side === 'left' ? <ChevronLeft className="h-8 w-8" /> : <ChevronRight className="h-8 w-8" />}
      </span>
    </button>
  );
}

// ---------------- Rasm: kattalashtirish va surish ----------------

function ZoomImage({
  peerId,
  m,
  zoom,
  setZoom,
  onBackdrop,
}: {
  peerId: string;
  m: TgMessage;
  zoom: number;
  setZoom: (f: (z: number) => number) => void;
  onBackdrop: () => void;
}) {
  const { t } = useTranslation();
  const { url, error } = useMedia(peerId, m.id, true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  if (error) return <div className="text-sm text-white/70">{errorText(error, t)}</div>;
  if (!url) return <Spinner className="text-white" />;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className={cn(
        'max-h-full max-w-full animate-pop-in select-none object-contain',
        zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
        !drag.current && 'transition-transform duration-150',
      )}
      style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, touchAction: zoom > 1 ? 'none' : 'auto' }}
      onWheel={(e) => {
        const dz = e.deltaY < 0 ? 0.25 : -0.25;
        setZoom((z) => Math.min(4, Math.max(1, z + dz)));
      }}
      onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2.5))}
      onPointerDown={(e) => {
        if (zoom <= 1) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.moved = true;
        setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Kichik ekranda bitta bosish — hech narsa; kattalashtirilmagan rasm chetidan tashqari bosilsa ota-element yopadi
        if (zoom <= 1 && e.detail === 1 && window.matchMedia('(pointer: coarse)').matches) onBackdrop();
      }}
    />
  );
}

// ---------------- Video pleer (Telegram uslubida) ----------------

const SPEEDS = [0.5, 1, 1.5, 2];

function VideoPlayer({ peerId, m }: { peerId: string; m: TgMessage }) {
  const { t } = useTranslation();
  const media = m.media!;
  const gif = media.kind === 'GIF';
  const thumb = useMedia(peerId, m.id, media.hasThumb, true);
  const src = useStream(peerId, m.id, true);
  const ref = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(media.durationSec ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [waiting, setWaiting] = useState(true);
  const [muted, setMuted] = useState(gif);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem('tg-video-volume'));
      return v > 0 && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  });
  const [speed, setSpeed] = useState(1);
  const [fs, setFs] = useState(false);
  const [showUi, setShowUi] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seeking = useRef(false);

  const v = () => ref.current;
  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  // Boshqaruv paneli: o'ynayotganda sichqoncha 2.5 s qimirlamasa yashirinadi
  const poke = useCallback(() => {
    setShowUi(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (ref.current && !ref.current.paused && !seeking.current) setShowUi(false);
    }, 2500);
  }, []);
  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    el.playbackRate = speed;
  }, [volume, muted, speed, src.url]);

  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        toggle();
        poke();
      } else if (e.key === 'm') setMuted((x) => !x);
      else if (e.key === 'f') void toggleFs();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, poke]);

  const toggleFs = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrap.current?.requestFullscreen();
    } catch {
      /* brauzer ruxsat bermadi */
    }
  };
  const pip = async () => {
    const el = v();
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* qo'llanmaydi */
    }
  };

  const seekTo = (clientX: number, bar: HTMLElement) => {
    const el = v();
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (el && (el.duration || dur)) {
      el.currentTime = f * (el.duration || dur);
      setTime(el.currentTime);
    }
  };

  if (src.error) return <div className="text-sm text-white/70">{errorText(src.error, t)}</div>;
  const total = dur || media.durationSec || 0;
  const pct = total ? (time / total) * 100 : 0;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const box = media.width && media.height ? { aspectRatio: `${media.width} / ${media.height}` } : undefined;

  return (
    <div
      ref={wrap}
      className={cn('relative flex animate-pop-in items-center justify-center bg-black', fs ? 'h-full w-full' : 'max-h-full max-w-full', !showUi && 'cursor-none')}
      onMouseMove={poke}
      onClick={(e) => e.stopPropagation()}
    >
      {src.url ? (
        <video
          ref={ref}
          src={src.url}
          poster={thumb.url}
          autoPlay
          playsInline
          loop={gif}
          className={cn('block object-contain', fs ? 'h-full w-full' : 'max-h-[calc(100dvh-140px)] max-w-full')}
          onClick={() => {
            toggle();
            poke();
          }}
          onDoubleClick={() => void toggleFs()}
          onPlay={() => {
            setPaused(false);
            pauseTrack();
            poke();
          }}
          onPause={() => {
            setPaused(true);
            setShowUi(true);
          }}
          onTimeUpdate={(e) => !seeking.current && setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration || total)}
          onProgress={(e) => {
            const el = e.currentTarget;
            const b = el.buffered;
            for (let i = 0; i < b.length; i++) {
              if (b.start(i) <= el.currentTime && b.end(i) >= el.currentTime) setBuffered(b.end(i));
            }
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onEnded={() => setShowUi(true)}
        />
      ) : (
        <div className="max-h-[calc(100dvh-140px)] w-[min(720px,calc(100vw-32px))] max-w-full" style={box}>
          {thumb.url && <img src={thumb.url} alt="" className="h-full w-full object-contain blur-sm" draggable={false} />}
        </div>
      )}

      {(waiting || !src.url) && !paused && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="text-white" />
        </span>
      )}
      {(!src.url || (paused && !waiting)) && (
        <button type="button" onClick={toggle} aria-label="Play" className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/50 backdrop-blur-sm transition-transform active:scale-95">
          {!src.url ? <Spinner className="text-white" /> : <Play className="ml-1 h-8 w-8 fill-current" />}
        </button>
      )}

      {/* Boshqaruv paneli */}
      {!gif && (
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200',
            showUi ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <div
            role="slider"
            aria-label={t('tg.seek')}
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(time)}
            tabIndex={0}
            className="group relative flex h-4 cursor-pointer items-center"
            onPointerDown={(e) => {
              seeking.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekTo(e.clientX, e.currentTarget);
            }}
            onPointerMove={(e) => seeking.current && seekTo(e.clientX, e.currentTarget)}
            onPointerUp={() => {
              seeking.current = false;
              poke();
            }}
            onKeyDown={(e) => {
              const el = v();
              if (!el) return;
              if (e.key === 'ArrowRight') {
                e.stopPropagation();
                el.currentTime = Math.min(total, el.currentTime + 5);
              } else if (e.key === 'ArrowLeft') {
                e.stopPropagation();
                el.currentTime = Math.max(0, el.currentTime - 5);
              }
            }}
          >
            <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover:h-[5px]">
              <div className="absolute inset-y-0 left-0 bg-white/40" style={{ width: `${total ? Math.min(100, (buffered / total) * 100) : 0}%` }} />
              <div className="absolute inset-y-0 left-0 bg-white" style={{ width: `${pct}%` }} />
            </div>
            <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-white opacity-0 transition-opacity group-hover:opacity-100" style={{ left: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center gap-1 text-sm">
            <CtrlBtn label={paused ? 'Play' : 'Pause'} onClick={toggle}>
              {paused ? <Play className="h-5 w-5 fill-current" /> : <Pause className="h-5 w-5 fill-current" />}
            </CtrlBtn>
            <div className="group/vol flex items-center">
              <CtrlBtn label={t('tg.mute')} onClick={() => setMuted((x) => !x)}>
                <VolIcon className="h-5 w-5" />
              </CtrlBtn>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label={t('tg.volume')}
                onChange={(e) => {
                  const x = Number(e.target.value);
                  setVolume(x);
                  setMuted(x === 0);
                  try {
                    if (x > 0) localStorage.setItem('tg-video-volume', String(x));
                  } catch {
                    /* ignore */
                  }
                }}
                className="w-0 cursor-pointer accent-white opacity-0 transition-all group-hover/vol:w-20 group-hover/vol:opacity-100 max-sm:hidden"
              />
            </div>
            <span className="ml-1 tabular-nums text-white/90">
              {fmtDuration(Math.floor(time))} / {fmtDuration(Math.floor(total))}
            </span>
            <span className="grow" />
            <button
              type="button"
              onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
              title={t('tg.speed')}
              className="h-8 min-w-[44px] cursor-pointer rounded-md px-1.5 text-[13px] font-semibold hover:bg-white/10"
            >
              {speed}x
            </button>
            {'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && (
              <CtrlBtn label={t('tg.pip')} onClick={() => void pip()} className="max-sm:hidden">
                <PictureInPicture2 className="h-5 w-5" />
              </CtrlBtn>
            )}
            <CtrlBtn label={t(fs ? 'tg.exitFullscreen' : 'tg.fullscreen')} onClick={() => void toggleFs()}>
              {fs ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </CtrlBtn>
          </div>
        </div>
      )}
    </div>
  );
}

function CtrlBtn({ label, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn('flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-white/90 hover:bg-white/10 hover:text-white', className)}
    >
      {children}
    </button>
  );
}
