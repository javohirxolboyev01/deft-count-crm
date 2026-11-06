import { AlertCircle, Download, FileText, Pause, Play, RotateCcw, RotateCw, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, api, getAccessToken, refreshAccess } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { ChatAttachment, ChatAttachmentKind, ChatMessage } from '@/lib/types';
import { Spinner } from './ui/spinner';

/**
 * Chat fayllari (V43): rasm, video, ovozli xabar, dumaloq video xabar.
 * Fayl Telegram kanalida saqlanadi, brauzerga server orqali keladi (`/api/chat/files/:id`, Authorization bilan),
 * shuning uchun <img src> o'rniga blob: URL ishlatiladi. Yuklangan fayllar sessiya davomida xotirada keshlanadi.
 */

// Server bilan bir xil ro'yxat (apps/api/src/modules/chat.ts KIND_MIMES)
export const PICK_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime';
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const VIDEO_NOTE_MAX_SEC = 60;
const VOICE_MAX_SEC = 30 * 60;

export function pickedKind(file: File): ChatAttachmentKind | null {
  const mime = file.type.split(';')[0].toLowerCase();
  if (IMAGE_MIMES.includes(mime)) return 'IMAGE';
  if (VIDEO_MIMES.includes(mime)) return 'VIDEO';
  return null;
}

export const fmtDuration = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// ---------------- Fayl keshi ----------------

const fileCache = new Map<number, Promise<string>>();

function chatFileUrl(id: number) {
  let p = fileCache.get(id);
  if (!p) {
    // Telegram'ga ulanish beqaror bo'lishi mumkin: xato bo'lsa bir marta o'zi qayta so'raydi
    const get = () => api.blob(`/chat/files/${id}`);
    p = get()
      .catch((e) => (e?.status === 404 ? Promise.reject(e) : new Promise((r) => setTimeout(r, 1500)).then(get)))
      .then((b) => URL.createObjectURL(b));
    p.catch(() => fileCache.delete(id));
    fileCache.set(id, p);
  }
  return p;
}

/** O'zi yuborgan faylni qayta yuklab olmaslik uchun: keshga lokal nusxa */
export function primeChatFile(id: number, file: Blob) {
  if (!fileCache.has(id)) fileCache.set(id, Promise.resolve(URL.createObjectURL(file)));
}

function useChatFile(id: number, enabled = true) {
  const [state, setState] = useState<{ url?: string; error?: boolean }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({});
    chatFileUrl(id).then(
      (url) => alive && setState({ url }),
      () => alive && setState({ error: true }),
    );
    return () => {
      alive = false;
    };
  }, [id, enabled, attempt]);
  return { ...state, retry: () => setAttempt((a) => a + 1) };
}

// ---------------- Yuborish (progress bilan) ----------------

/** XHR — fetch yuklash foizini bermaydi. 401 bo'lsa token yangilanib bir marta qayta yuboriladi */
export function uploadChatFile(userId: number, form: FormData, onProgress: (p: number) => void): Promise<ChatMessage> {
  const send = (retry: boolean): Promise<ChatMessage> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/chat/with/${userId}/attachment`);
      xhr.withCredentials = true;
      const tok = getAccessToken();
      if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = async () => {
        let data: any = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* bo'sh javob */
        }
        if (xhr.status === 401 && retry && (await refreshAccess())) {
          send(false).then(resolve, reject);
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as ChatMessage);
        else reject(new ApiError(xhr.status, data.code ?? `HTTP_${xhr.status}`, data.message ?? xhr.statusText, data.details));
      };
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error'));
      xhr.send(form);
    });
  return send(true);
}

// ---------------- Videoni siqish (brauzerda) ----------------

/** Tanlangan video qayta ishlanadigan eng katta hajm (natija baribir ≤ 20 MB bo'ladi) */
export const VIDEO_SOURCE_MAX_BYTES = 1024 * 1024 * 1024;

export interface CompressedVideo {
  file: File;
  kind: 'VIDEO_NOTE' | 'VIDEO';
  durationSec: number;
  width: number;
  height: number;
}

/**
 * Tanlangan videoni yuborishdan oldin siqish (rahbar qarori: kamroq hajm):
 *  - ≤ 60 s — dumaloq video xabar: markazdan kvadrat 384×384, ~1 Mbit/s MP4 (Telegram kanalida ham dumaloq);
 *  - uzunrog'i — oddiy video: katta tomoni ≤ 640, bitreyt 20 MB ga sig'adigan qilib tanlanadi.
 * Brauzerda ffmpeg yo'q: video ko'rinmas <video>da o'ynatiladi, kadrlar canvas'ga chiziladi, ovoz WebAudio orqali
 * olinadi va MediaRecorder bilan qayta yoziladi. Shuning uchun siqish videoning o'z davomiyligicha vaqt oladi.
 */
export async function compressVideo(file: File, maxBytes: number, onProgress: (p: number) => void): Promise<CompressedVideo> {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) throw new Error('UNSUPPORTED');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  const cleanup: (() => void)[] = [() => URL.revokeObjectURL(url), () => video.removeAttribute('src')];
  try {
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error('DECODE'));
    });
    const d = video.duration;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!Number.isFinite(d) || !vw || !vh) throw new Error('DECODE');
    const note = Math.round(d) <= VIDEO_NOTE_MAX_SEC;
    let W: number;
    let H: number;
    if (note) W = H = NOTE_SIZE;
    else {
      const k = Math.min(1, 640 / Math.max(vw, vh));
      W = Math.round((vw * k) / 2) * 2;
      H = Math.round((vh * k) / 2) * 2;
    }
    // Uzun video 20 MB ga sig'sin: (95% chegara × 8 bit) / soniya − ovoz
    const audioBps = 64_000;
    const videoBps = note ? 1_000_000 : Math.min(1_500_000, Math.floor((maxBytes * 0.95 * 8) / d) - audioBps);
    if (videoBps < 200_000) throw new Error('TOO_LONG');

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const draw = () => {
      if (note) {
        const side = Math.min(vw, vh);
        ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, W, H);
      } else ctx.drawImage(video, 0, 0, W, H);
    };
    const timer = setInterval(draw, 1000 / 30);
    cleanup.push(() => clearInterval(timer));
    const stream = canvas.captureStream(30);

    // Ovoz: element ovozi grafga yo'naltiriladi va karnayga ulanmaydi — foydalanuvchi eshitmaydi
    const audioCtx = new AudioContext();
    cleanup.push(() => void audioCtx.close());
    try {
      const src = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(dest);
      dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    } catch {
      /* ovozsiz video */
    }

    const mime = recorderMime('VIDEO_NOTE');
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: videoBps, audioBitsPerSecond: audioBps });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
    video.ontimeupdate = () => onProgress(Math.min(1, video.currentTime / d));
    const ended = new Promise<void>((res, rej) => {
      video.onended = () => res();
      video.onerror = () => rej(new Error('DECODE'));
    });
    await audioCtx.resume().catch(() => undefined);
    draw();
    rec.start(1000);
    try {
      await video.play();
    } catch {
      // Brauzer ovozli avto-ijroni to'xtatsa — ovozsiz bo'lsa ham siqiladi
      video.muted = true;
      await video.play();
    }
    await ended;
    draw();
    rec.stop();
    await stopped;
    stream.getTracks().forEach((tr) => tr.stop());
    onProgress(1);

    const type = rec.mimeType || mime || 'video/webm';
    const base = type.split(';')[0];
    // Faqat asosiy tur: `codecs=avc1…,mp4a…` dagi vergul multipart sarlavhasini buzadi (server text/plain deb oladi)
    const out = new File(chunks, `${note ? 'video-note' : 'video'}-${Date.now()}.${EXT[base] ?? 'webm'}`, { type: base });
    return { file: out, kind: note ? 'VIDEO_NOTE' : 'VIDEO', durationSec: Math.max(1, Math.round(d)), width: W, height: H };
  } finally {
    cleanup.forEach((fn) => fn());
  }
}

/** Tanlangan rasm/video o'lchami va davomiyligi (xabarda joy oldindan ajratilsin — aylantirish sakramasin) */
export function readMediaMeta(file: File, kind: ChatAttachmentKind): Promise<{ width?: number; height?: number; durationSec?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (v: { width?: number; height?: number; durationSec?: number }) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done({}), 4000);
    if (kind === 'IMAGE') {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        done({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => done({});
      img.src = url;
    } else {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        clearTimeout(timer);
        done({
          width: v.videoWidth || undefined,
          height: v.videoHeight || undefined,
          durationSec: Number.isFinite(v.duration) ? Math.round(v.duration) : undefined,
        });
      };
      v.onerror = () => done({});
      v.src = url;
    }
  });
}

// ---------------- Xabardagi fayl ----------------

/** Rasm/video ko'rinish o'lchami: kengligi ≤ 260, balandligi ≤ 320 */
function boxSize(att: ChatAttachment) {
  const w = att.width ?? 4;
  const h = att.height ?? 3;
  const scale = Math.min(260 / w, 320 / h);
  return { width: Math.max(140, Math.round(w * scale)), aspectRatio: `${w} / ${h}` };
}

function LoadError({ onRetry, className }: { onRetry: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      className={cn('flex cursor-pointer flex-col items-center justify-center gap-1 text-xs', className)}
    >
      <AlertCircle className="h-5 w-5" />
      {t('chat.fileLoadError')}
      <RotateCw className="h-4 w-4" />
    </button>
  );
}

/** Rasm ochilganda pastki chap burchakdagi ma'lumot (Telegram kabi): yuboruvchi avatari, ismi, vaqti */
export interface MediaSender {
  avatar: ReactNode;
  name: string;
  time: string;
}

export function AttachmentView({
  att,
  mine,
  overlay,
  footer,
  sender,
}: {
  att: ChatAttachment;
  mine: boolean;
  overlay?: ReactNode;
  /** Ovozli xabar: davomiylik qatorining o'ng tomonida (vaqt va ✓) */
  footer?: ReactNode;
  sender?: MediaSender;
}) {
  if (att.kind === 'IMAGE') return <ImageView att={att} overlay={overlay} sender={sender} />;
  if (att.kind === 'FILE') return <FileView att={att} mine={mine} />;
  if (att.kind === 'VIDEO') return <VideoView att={att} overlay={overlay} />;
  if (att.kind === 'VIDEO_NOTE') return <VideoNoteView att={att} overlay={overlay} sender={sender} />;
  return <VoiceView att={att} mine={mine} sender={sender} footer={footer} />;
}

/** Hujjat (Telegram kabi): doira ichida belgi, nomi, hajmi; bosilsa yuklab olinadi */
function FileView({ att, mine }: { att: ChatAttachment; mine: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = att.fileName ?? 'file';
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase().slice(0, 5) : '';
  const save = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const href = await chatFileUrl(att.id);
      Object.assign(document.createElement('a'), { href, download: name }).click();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={save} title={t('chat.download')} className="flex w-[260px] max-w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left">
      <span
        className={cn(
          'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
          mine ? 'bg-white text-brand-600' : 'bg-brand-500 text-on-brand',
        )}
      >
        {busy ? <Spinner size="small" /> : failed ? <RotateCw className="h-5 w-5" /> : <Download className="h-5 w-5" />}
      </span>
      <span className="min-w-0 grow">
        <span className="block truncate font-medium">{name}</span>
        <span className={cn('flex items-center gap-1 text-xs', mine ? 'text-on-brand/80' : 'text-gray-500')}>
          <FileText className="h-3.5 w-3.5 shrink-0" />
          {fmtSize(att.sizeBytes)}
          {ext && ` · ${ext}`}
          {failed && ` · ${t('chat.fileLoadError')}`}
        </span>
      </span>
    </button>
  );
}

function ImageView({ att, overlay, sender }: { att: ChatAttachment; overlay?: ReactNode; sender?: MediaSender }) {
  const { url, error, retry } = useChatFile(att.id);
  const [zoom, setZoom] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-xl bg-black/10" style={boxSize(att)}>
      {url ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom(true);
          }}
          className="block h-full w-full cursor-zoom-in"
        >
          <img src={url} alt={att.fileName ?? ''} className="h-full w-full object-cover" draggable={false} />
        </button>
      ) : error ? (
        <LoadError onRetry={retry} className="h-full w-full text-gray-500" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Spinner />
        </div>
      )}
      {overlay}
      {zoom && url && <Lightbox url={url} fileName={att.fileName} sender={sender} onClose={() => setZoom(false)} />}
    </div>
  );
}

function VideoView({ att, overlay }: { att: ChatAttachment; overlay?: ReactNode }) {
  // Video katta bo'lishi mumkin: faqat bosilganda yuklanadi
  const [want, setWant] = useState(false);
  const { url, error, retry } = useChatFile(att.id, want);
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#1a344d]" style={boxSize(att)}>
      {url ? (
        <video src={url} controls autoPlay playsInline className="h-full w-full bg-black object-contain" onClick={(e) => e.stopPropagation()} />
      ) : error ? (
        <LoadError onRetry={retry} className="h-full w-full text-on-brand" />
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setWant(true);
          }}
          className="flex h-full w-full cursor-pointer items-center justify-center"
          aria-label="Play"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-on-brand">
            {want ? <Spinner size="small" className="text-on-brand" /> : <Play className="ml-0.5 h-6 w-6" />}
          </span>
        </button>
      )}
      {!url && (
        <span className="absolute left-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-[11px] text-on-brand">
          {att.durationSec != null ? `${fmtDuration(att.durationSec)} · ` : ''}
          {fmtSize(att.sizeBytes)}
        </span>
      )}
      {!url && overlay}
    </div>
  );
}

// ---------------- Hozir o'ynayotgan media (Telegram'dagi tepadagi panel) ----------------

/** Bir vaqtda bitta ovozli/video xabar o'ynaydi; suhbat tepasidagi panel shu holatni ko'rsatadi */
export interface NowPlaying {
  attId: number;
  kind: 'VOICE' | 'VIDEO_NOTE';
  el: HTMLMediaElement;
  /** webm yozuvlarda el.duration = Infinity — yuborishda o'lchangan qiymat */
  duration: number;
  title: string;
  /** To'xtatish: video xabar ovozsiz takrorlanishga, ovozli xabar boshiga qaytadi */
  stop: () => void;
}

let nowPlaying: NowPlaying | null = null;
const playingListeners = new Set<() => void>();

function setNowPlaying(p: NowPlaying | null) {
  // Boshqasi boshlansa — oldingisi to'xtaydi (Telegram kabi)
  if (p && nowPlaying && nowPlaying.attId !== p.attId) nowPlaying.stop();
  nowPlaying = p;
  playingListeners.forEach((fn) => fn());
}
function clearNowPlaying(attId: number) {
  if (nowPlaying?.attId === attId) setNowPlaying(null);
}

export function useNowPlaying() {
  return useSyncExternalStore(
    (fn) => {
      playingListeners.add(fn);
      return () => playingListeners.delete(fn);
    },
    () => nowPlaying,
  );
}

/** requestAnimationFrame bilan media vaqti (timeupdate soniyasiga ~4 marta — halqa sakrab yurardi) */
function useMediaFrame(el: HTMLMediaElement | null, active: boolean, fn: (t: number) => void) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (!el || !active) return;
    let raf = 0;
    const tick = () => {
      cb.current(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el, active]);
}

/** Suhbat tepasidagi panel: ⏯, kim / qanday xabar, vaqt, ✕ (to'xtatish) */
export function NowPlayingBar() {
  const { t } = useTranslation();
  const p = useNowPlaying();
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p) return;
    const sync = () => setPaused(p.el.paused);
    sync();
    p.el.addEventListener('play', sync);
    p.el.addEventListener('pause', sync);
    return () => {
      p.el.removeEventListener('play', sync);
      p.el.removeEventListener('pause', sync);
    };
  }, [p]);
  const dur = p ? (Number.isFinite(p.el.duration) ? p.el.duration : p.duration) : 0;
  useMediaFrame(p?.el ?? null, !!p, (cur) => {
    const s = Math.floor(cur);
    setTime((old) => (old === s ? old : s));
    if (barRef.current && dur) barRef.current.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
  });
  if (!p) return null;
  return (
    <div className="relative flex h-11 shrink-0 items-center gap-2 border-b border-gray-200 px-2 dark:border-[#1F2937]">
      <button
        type="button"
        onClick={() => (p.el.paused ? void p.el.play() : p.el.pause())}
        aria-label={paused ? t('chat.play') : t('chat.pause')}
        title={paused ? t('chat.play') : t('chat.pause')}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-brand-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]"
      >
        {paused ? <Play className="ml-0.5 h-5 w-5" /> : <Pause className="h-5 w-5" />}
      </button>
      <div className="min-w-0 grow text-sm">
        <span className="font-semibold text-gray-900">{p.title}</span>
        <span className="text-gray-500"> · {t(`chat.kind.${p.kind}`)}</span>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-gray-500">
        {fmtDuration(time)}
        {dur ? ` / ${fmtDuration(dur)}` : ''}
      </span>
      <button
        type="button"
        onClick={() => p.stop()}
        aria-label={t('chat.stopPlaying')}
        title={t('chat.stopPlaying')}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="absolute inset-x-0 bottom-0 h-0.5">
        <div ref={barRef} className="h-full w-0 bg-brand-500" />
      </div>
    </div>
  );
}

const NOTE_SMALL = 216;
const NOTE_BIG = 288;

/**
 * Dumaloq video xabar (Telegram kabi): ovozsiz takrorlanib turadi; bosilsa kattalashib boshidan ovoz bilan o'ynaydi,
 * atrofida silliq halqa, burchakda qolgan vaqt; yana bosilsa pauza; tugasa yoki ✕ — kichik ovozsiz holatga qaytadi.
 */
function VideoNoteView({ att, overlay, sender }: { att: ChatAttachment; overlay?: ReactNode; sender?: MediaSender }) {
  const { t } = useTranslation();
  const { url, error, retry } = useChatFile(att.id);
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const [mode, setModeState] = useState<'preview' | 'playing' | 'paused'>('preview');
  // play/pause hodisalari kechikib kelishi mumkin: joriy rejim ref'da (eski qiymat bilan qaytib qolmasin)
  const modeRef = useRef(mode);
  const setMode = (m: typeof mode) => {
    modeRef.current = m;
    setModeState(m);
  };
  const ringRef = useRef<SVGCircleElement>(null);
  const [left, setLeft] = useState<number | null>(null);

  const toPreview = useCallback(() => {
    if (!el) return;
    el.muted = true;
    el.loop = true;
    el.currentTime = 0;
    void el.play().catch(() => undefined);
    modeRef.current = 'preview';
    setModeState('preview');
    setLeft(null);
    clearNowPlaying(att.id);
  }, [el, att.id]);

  useEffect(() => () => clearNowPlaying(att.id), [att.id]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!el) return;
    if (mode === 'preview') {
      el.currentTime = 0;
      el.muted = false;
      el.loop = false;
      void el.play();
      setMode('playing');
      setNowPlaying({ attId: att.id, kind: 'VIDEO_NOTE', el, duration: att.durationSec ?? 0, title: sender?.name ?? t('chat.kind.VIDEO_NOTE'), stop: toPreview });
    } else if (el.paused) void el.play();
    else el.pause();
  };

  const dur = el && Number.isFinite(el.duration) ? el.duration : (att.durationSec ?? 0);
  const size = mode === 'preview' ? NOTE_SMALL : NOTE_BIG;
  const R = size / 2 - 3;
  const C = 2 * Math.PI * R;
  useMediaFrame(el, mode !== 'preview', (cur) => {
    if (ringRef.current && dur) ringRef.current.style.strokeDashoffset = String(C * (1 - Math.min(1, cur / dur)));
    const l = Math.max(0, Math.ceil(dur - cur));
    setLeft((o) => (o === l ? o : l));
  });

  return (
    <div className="relative transition-[width,height] duration-200 ease-out" style={{ width: size, height: size }}>
      <div className="h-full w-full overflow-hidden rounded-full bg-black/20">
        {url ? (
          <video
            ref={setEl}
            src={url}
            muted
            loop
            autoPlay
            playsInline
            onClick={toggle}
            onPlay={() => modeRef.current !== 'preview' && setMode('playing')}
            onPause={() => modeRef.current !== 'preview' && setMode('paused')}
            onEnded={toPreview}
            className="h-full w-full cursor-pointer object-cover"
          />
        ) : error ? (
          <LoadError onRetry={retry} className="h-full w-full text-gray-500" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Spinner />
          </div>
        )}
      </div>
      {mode !== 'preview' && (
        <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
          <circle ref={ringRef} cx={size / 2} cy={size / 2} r={R} fill="none" stroke="#fff" strokeWidth="3" strokeDasharray={C} strokeDashoffset={C} strokeLinecap="round" />
        </svg>
      )}
      {mode === 'paused' && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-on-brand">
            <Play className="ml-0.5 h-6 w-6" />
          </span>
        </span>
      )}
      {(left != null || att.durationSec != null) && (
        <span className="absolute bottom-1 left-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[11px] tabular-nums text-on-brand">
          {fmtDuration(left ?? att.durationSec ?? 0)}
        </span>
      )}
      {overlay}
    </div>
  );
}

const WAVE_BARS = 48;

/**
 * Ovoz to'lqini (Telegram kabi): faylni dekodlab WAVE_BARS ta bo'lakdagi eng baland qiymat, 0..31 ga keltirilgan.
 * Yozib bo'lingach yuborishdan oldin hisoblanadi va xabar bilan saqlanadi (V45).
 */
export async function computeWaveform(blob: Blob): Promise<number[] | null> {
  try {
    const ctx = new AudioContext();
    try {
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      const data = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / WAVE_BARS));
      const peaks: number[] = [];
      for (let b = 0; b < WAVE_BARS; b++) {
        let max = 0;
        for (let i = b * step; i < Math.min(data.length, (b + 1) * step); i++) max = Math.max(max, Math.abs(data[i]));
        peaks.push(max);
      }
      const top = Math.max(...peaks) || 1;
      // Ildiz — past ovozlar ham ko'rinsin
      return peaks.map((p) => Math.round(Math.sqrt(p / top) * 31));
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Ovozli xabar (Telegram kabi): katta ▶ doira, to'lqin ustunlari (bosib suriladi), ostida davomiylik va vaqt */
function VoiceView({ att, mine, sender, footer }: { att: ChatAttachment; mine: boolean; sender?: MediaSender; footer?: ReactNode }) {
  const { t } = useTranslation();
  const [want, setWant] = useState(false);
  const { url, error, retry } = useChatFile(att.id, want);
  const [el, setEl] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  // Eski xabarlarda to'lqin saqlanmagan: fayl ochilganda hisoblanadi
  const [wave, setWave] = useState<number[] | null>(att.waveform);
  // MediaRecorder'ning webm faylida davomiylik yo'q (Infinity) — yuborishda o'lchangan qiymat ishlatiladi
  const total = att.durationSec ?? 0;

  useEffect(() => {
    if (url && want && el?.paused) void el.play();
  }, [url, want, el]);
  useEffect(() => {
    if (!url || wave) return;
    let alive = true;
    void fetch(url)
      .then((r) => r.blob())
      .then(computeWaveform)
      .then((w) => alive && w && setWave(w));
    return () => {
      alive = false;
    };
  }, [url, wave]);
  useEffect(() => () => clearNowPlaying(att.id), [att.id]);
  useMediaFrame(el, playing, setPos);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!url) {
      if (error) retry();
      setWant(true);
      return;
    }
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!el || !total) {
      if (!url) setWant(true);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    el.currentTime = Math.min(total, Math.max(0, ((e.clientX - r.left) / r.width) * total));
    setPos(el.currentTime);
  };
  const pct = total ? Math.min(1, pos / total) : 0;
  const bars = wave?.length ? wave : Array.from({ length: WAVE_BARS }, () => 2);
  return (
    <div className="flex w-[250px] max-w-full items-center gap-3 px-1.5 pb-0.5 pt-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('chat.pause') : t('chat.play')}
        className={cn(
          'flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform active:scale-95',
          mine ? 'bg-white text-brand-600' : 'bg-brand-500 text-on-brand',
        )}
      >
        {want && !url && !error ? (
          <Spinner size="small" />
        ) : error ? (
          <RotateCw className="h-5 w-5" />
        ) : playing ? (
          <Pause className="h-6 w-6" fill="currentColor" />
        ) : (
          <Play className="ml-0.5 h-6 w-6" fill="currentColor" />
        )}
      </button>
      <div className="min-w-0 grow">
        <div onClick={seek} className="flex h-6 w-full cursor-pointer items-end justify-between gap-[1.5px]" role="slider" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(pos)}>
          {bars.map((v, i) => {
            const played = (i + 0.5) / bars.length <= pct;
            return (
              <span
                key={i}
                style={{ height: `${Math.max(2, Math.round((v / 31) * 22))}px` }}
                className={cn(
                  // Ustunlar joyga qarab torayadi: pufakchadan chiqib ketmasin
                  'min-w-0 max-w-[3px] flex-1 rounded-full',
                  mine ? (played ? 'bg-white' : 'bg-white/45') : played ? 'bg-brand-500' : 'bg-gray-400/60 dark:bg-white/30',
                )}
              />
            );
          })}
        </div>
        <div className="mt-1 flex items-end justify-between gap-2">
          <span className={cn('text-[12px] tabular-nums', mine ? 'text-on-brand/80' : 'text-gray-500')}>{fmtClock(playing || pos ? pos : total)}</span>
          {footer}
        </div>
      </div>
      {url && (
        <audio
          ref={setEl}
          src={url}
          preload="auto"
          onPlay={(e) => {
            setPlaying(true);
            const a = e.currentTarget;
            setNowPlaying({
              attId: att.id,
              kind: 'VOICE',
              el: a,
              duration: total,
              title: sender?.name ?? t('chat.kind.VOICE'),
              stop: () => {
                a.pause();
                a.currentTime = 0;
                setPos(0);
                clearNowPlaying(att.id);
              },
            });
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
            clearNowPlaying(att.id);
          }}
          className="hidden"
        />
      )}
    </div>
  );
}

/**
 * Rasmni ko'rish (Telegram Desktop kabi): xira qora fon, markazda rasm; pastda chapda yuboruvchi va vaqt,
 * o'ngda kichraytirish / kattalashtirish / burish / yuklab olish / yopish. G'ildirak — kattalashtirish,
 * kattalashtirilganda sichqoncha bilan suriladi. Fon yoki Esc — yopish.
 */
function Lightbox({ url, fileName, sender, onClose }: { url: string; fileName: string | null; sender?: MediaSender; onClose: () => void }) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const zoomTo = (next: number) => {
    const v = Math.min(5, Math.max(1, Math.round(next * 100) / 100));
    setScale(v);
    if (v === 1) setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomTo(scale * 1.25);
      else if (e.key === '-') zoomTo(scale / 1.25);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  // 90°/270° burilganda rasm ekranga sig'sin: chegaralar almashadi
  const sideways = rotate % 180 !== 0;
  const fit = sideways
    ? { maxWidth: 'calc(100vh - 140px)', maxHeight: 'calc(100vw - 48px)' }
    : { maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 140px)' };

  const btn = 'flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-on-brand/80 transition-colors hover:bg-white/10 hover:text-on-brand disabled:cursor-default disabled:opacity-30';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-[60] flex animate-pop-in flex-col bg-black/80 backdrop-blur-md"
    >
      <div
        className="flex min-h-0 grow items-center justify-center overflow-hidden"
        onWheel={(e) => zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))}
      >
        <img
          src={url}
          alt={fileName ?? ''}
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            if (drag.current?.moved) return;
            // Telegram kabi: rasm ustiga bosish — kattalashtirish / asl holiga qaytish
            zoomTo(scale > 1 ? 1 : 2);
          }}
          onPointerDown={(e) => {
            if (scale <= 1) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, moved: false };
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || !dragging) return;
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
            setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
          }}
          onPointerUp={() => {
            setDragging(false);
            setTimeout(() => (drag.current = null));
          }}
          style={{
            ...fit,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotate}deg)`,
            transition: dragging ? 'none' : 'transform 160ms ease-out',
          }}
          className={cn('select-none object-contain shadow-pop', scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in')}
        />
      </div>

      <div className="flex h-[100px] shrink-0 items-center justify-between gap-4 px-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex min-w-0 items-center gap-3">
          {sender && (
            <>
              {sender.avatar}
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-on-brand">{sender.name}</div>
                <div className="truncate text-sm text-on-brand/60">{sender.time}</div>
              </div>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => zoomTo(scale / 1.25)} disabled={scale <= 1} aria-label={t('chat.zoomOut')} title={t('chat.zoomOut')} className={btn}>
            <ZoomOut className="h-6 w-6" />
          </button>
          <button type="button" onClick={() => zoomTo(scale * 1.25)} disabled={scale >= 5} aria-label={t('chat.zoomIn')} title={t('chat.zoomIn')} className={btn}>
            <ZoomIn className="h-6 w-6" />
          </button>
          <button type="button" onClick={() => setRotate((r) => r - 90)} aria-label={t('chat.rotate')} title={t('chat.rotate')} className={btn}>
            <RotateCcw className="h-6 w-6" />
          </button>
          <a href={url} download={fileName ?? 'image'} aria-label={t('chat.download')} title={t('chat.download')} className={cn(btn, 'ml-3')}>
            <Download className="h-6 w-6" />
          </a>
          <button type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')} className={btn}>
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------- Yozib olish (ovozli va dumaloq video xabar) ----------------

export type RecKind = 'VOICE' | 'VIDEO_NOTE';

function recorderMime(kind: RecKind) {
  const list =
    kind === 'VOICE'
      ? ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      : // Telegram dumaloq videosi faqat MP4 (H.264) — imkon bo'lsa shu (Chrome 126+, Safari); bo'lmasa webm (kanalda hujjat bo'ladi)
        ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'video/mp4': 'mp4' };

export interface Recorded {
  kind: RecKind;
  file: File;
  durationSec: number;
  /** Dumaloq video: kvadrat tomoni (px) */
  size?: number;
}

// Telegram dumaloq videosi kvadrat (tomoni ≤ 640); 384 — Telegram ilovalari yozadigan o'lcham
const NOTE_SIZE = 384;

/** Kamera kadrini markazdan kvadrat qilib kesish: canvas'ga chizib, uning oqimini yozamiz */
function squareStream(camera: MediaStream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = camera;
  void video.play();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = NOTE_SIZE;
  const ctx = canvas.getContext('2d')!;
  // requestAnimationFrame emas: boshqa oynaga o'tilganda ham yozuv to'xtab qolmasin
  const timer = setInterval(() => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const side = Math.min(w, h);
    ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, NOTE_SIZE, NOTE_SIZE);
  }, 1000 / 30);
  const out = canvas.captureStream(30);
  camera.getAudioTracks().forEach((tr) => out.addTrack(tr));
  return {
    stream: out,
    dispose: () => {
      clearInterval(timer);
      video.srcObject = null;
      out.getVideoTracks().forEach((tr) => tr.stop());
    },
  };
}

/**
 * MediaRecorder o'ramasi. stop(true) — yozuv tugaydi va onDone chaqiriladi, stop(false) — bekor.
 * Dumaloq video 60 soniyada o'zi to'xtab yuboriladi (Telegram kabi).
 */
export function useRecorder(onDone: (r: Recorded) => void) {
  const [rec, setRec] = useState<{ kind: RecKind; stream: MediaStream; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const mr = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const stop = useCallback((send: boolean) => {
    keep.current = send;
    if (mr.current && mr.current.state !== 'inactive') mr.current.stop();
  }, []);

  const start = useCallback(async (kind: RecKind) => {
    if (mr.current) return;
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'VOICE'
        ? { audio: { echoCancellation: true, noiseSuppression: true } }
        : { audio: true, video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' } },
    );
    const square = kind === 'VIDEO_NOTE' ? squareStream(stream) : null;
    const mime = recorderMime(kind);
    const recorder = new MediaRecorder(square?.stream ?? stream, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 32_000,
      ...(kind === 'VIDEO_NOTE' ? { videoBitsPerSecond: 1_000_000 } : {}),
    });
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      square?.dispose();
      stream.getTracks().forEach((tr) => tr.stop());
      mr.current = null;
      setRec(null);
      setElapsed(0);
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      if (!keep.current || !chunks.length || durationSec < 1) return;
      const type = recorder.mimeType || mime || (kind === 'VOICE' ? 'audio/webm' : 'video/webm');
      const base = type.split(';')[0];
      const name = `${kind === 'VOICE' ? 'voice' : 'video-note'}-${startedAt}.${EXT[base] ?? 'webm'}`;
      // Faqat asosiy tur (codecs parametrisiz) — multipart sarlavhasi buzilmasin
      doneRef.current({ kind, file: new File(chunks, name, { type: base }), durationSec, size: square ? NOTE_SIZE : undefined });
    };
    mr.current = recorder;
    keep.current = false;
    recorder.start(1000);
    setRec({ kind, stream, startedAt });
  }, []);

  useEffect(() => {
    if (!rec) return;
    const max = rec.kind === 'VIDEO_NOTE' ? VIDEO_NOTE_MAX_SEC : VOICE_MAX_SEC;
    const id = setInterval(() => {
      const s = (Date.now() - rec.startedAt) / 1000;
      setElapsed(s);
      if (s >= max) stop(true);
    }, 200);
    return () => clearInterval(id);
  }, [rec, stop]);

  // Komponent yopilsa (suhbatdan chiqilsa) — kamera/mikrofon o'chsin, yozuv yuborilmasin
  useEffect(() => () => stop(false), [stop]);

  return { rec, elapsed, start, stop };
}

/** Yozib olish paytida: dumaloq jonli kamera (video xabar) */
export function VideoNotePreview({ stream, elapsed }: { stream: MediaStream; elapsed: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  const R = 116;
  const C = 2 * Math.PI * R;
  return (
    <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
      <div className="relative h-[240px] w-[240px]">
        <video ref={ref} autoPlay muted playsInline className="h-full w-full -scale-x-100 rounded-full object-cover shadow-pop" />
        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 240 240" aria-hidden>
          <circle cx="120" cy="120" r={R} fill="none" stroke="#37a0ad" strokeWidth="5" strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, elapsed / VIDEO_NOTE_MAX_SEC))} strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

/** Yozib olish paytidagi pastki panel: qizil nuqta + vaqt, bekor qilish va yuborish */
export function RecordingBar({ kind, elapsed, onCancel, onSend, sendIcon }: { kind: RecKind; elapsed: number; onCancel: () => void; onSend: () => void; sendIcon: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 p-2 dark:border-[#1F2937]">
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('chat.cancelRecording')}
        title={t('chat.cancelRecording')}
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-red-600 hover:bg-gray-100 dark:hover:bg-[#1F2937]"
      >
        <Trash2 className="h-5 w-5" />
      </button>
      {/* min-w-0: uzun matn yuborish tugmasini o'ngga itarib chiqarmasin */}
      <span className="flex min-w-0 grow items-center gap-2 text-sm text-gray-900">
        <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
        <span className="shrink-0 tabular-nums">{fmtDuration(elapsed)}</span>
        <span className="min-w-0 truncate text-gray-500">
          {kind === 'VOICE' ? t('chat.recordingVoice') : t('chat.recordingVideo', { max: VIDEO_NOTE_MAX_SEC })}
        </span>
      </span>
      <button
        type="button"
        onClick={onSend}
        aria-label={t('chat.send')}
        title={t('chat.send')}
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand-500 text-on-brand transition-transform hover:opacity-90 active:scale-95"
      >
        {sendIcon}
      </button>
    </div>
  );
}
