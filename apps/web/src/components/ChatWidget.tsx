import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCheck, File as FileIcon, Film, Image as ImageIcon, MessageCircle, Mic, Paperclip, Pencil, Search, SendHorizontal, Trash2, Video, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { TZ } from '@/lib/time';
import { Logo } from './Logo';
import type { ChatAttachmentKind, ChatContact, ChatMessage } from '@/lib/types';
import {
  AttachmentView,
  NowPlayingBar,
  PICK_ACCEPT,
  RecordingBar,
  VIDEO_SOURCE_MAX_BYTES,
  VideoNotePreview,
  compressVideo,
  computeWaveform,
  fmtSize,
  pickedKind,
  primeChatFile,
  readMediaMeta,
  uploadChatFile,
  useRecorder,
  type RecKind,
  type Recorded,
} from './ChatMedia';
import { ConfirmDialog } from './ui/dialog';
import { Spinner } from './ui/spinner';

/**
 * Ichki chat (Telegram ko'rinishida): o'ng pastki burchakdagi yumaloq tugma — o'qilmaganlar soni bilan,
 * bosilsa suhbatdoshlar ro'yxati (har biri yonida o'qilmaganlar soni), keyin suhbat oynasi.
 * Real vaqt yangilanishi Layout'dagi SSE orqali (`['chat']` so'rovlari yangilanadi).
 */

const PAGE = 50;
// Telegram avatar ranglari: id bo'yicha barqaror tanlanadi
const AVATAR_GRADIENTS = [
  ['#ff885e', '#ff516a'],
  ['#ffcd6a', '#ffa85c'],
  ['#82b1ff', '#665fff'],
  ['#a0de7e', '#54cb68'],
  ['#53edd6', '#28c9b7'],
  ['#72d5fd', '#2a9ef1'],
  ['#e0a2f3', '#d669ed'],
];

const dt = (iso: string) => DateTime.fromISO(iso).setZone(TZ);

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function Avatar({ id, name, size = 48 }: { id: number; name: string; size?: number }) {
  const [a, b] = AVATAR_GRADIENTS[id % AVATAR_GRADIENTS.length];
  return (
    <span
      aria-hidden
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-on-brand"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(180deg, ${a}, ${b})` }}
    >
      {initials(name)}
    </span>
  );
}

function Ticks({ read, className }: { read: boolean; className?: string }) {
  const Icon = read ? CheckCheck : Check;
  return <Icon className={cn('h-4 w-4 shrink-0', className)} aria-hidden />;
}

const KIND_EMOJI: Record<ChatAttachmentKind, string> = { IMAGE: '🖼', VIDEO: '🎬', VOICE: '🎤', VIDEO_NOTE: '⏺', FILE: '📄' };

/** Ro'yxat va tahrirlash panelida xabarning qisqa matni: faylli xabarda tur belgisi + izoh */
function previewText(body: string, kind: ChatAttachmentKind | null | undefined, t: ReturnType<typeof useTranslation>['t']) {
  if (!kind) return body;
  return `${KIND_EMOJI[kind]} ${body || t(`chat.kind.${kind}`)}`;
}

/**
 * Pufakcha "ilmog'i" (Telegram kabi): guruhdagi oxirgi xabarning pastki burchagida, pufakcha rangida.
 * O'z xabari — o'ngda, suhbatdoshniki — chapda (ko'zgu).
 */
function BubbleTail({ mine }: { mine: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 11 20"
      className={cn(
        'pointer-events-none absolute bottom-0 h-5 w-[11px]',
        mine ? '-right-[10px] text-brand-500 dark:text-brand-600' : '-left-[10px] -scale-x-100 text-white dark:text-[#374151]',
      )}
    >
      <path d="M0 0 V20 H9.5 C10.6 20 11.2 18.7 10.4 17.9 C4.8 12.3 0.6 7 0 0 Z" fill="currentColor" />
    </svg>
  );
}

function UnreadBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cn('min-w-[22px] rounded-full bg-brand-500 px-1.5 text-center text-xs font-semibold leading-[22px] text-on-brand', className)}>
      {n > 999 ? '999+' : n}
    </span>
  );
}

/** Telefonda (< sm) chat to'liq ekran: balandlik `visualViewport`dan olinadi — klaviatura ochilganda
 *  oyna klaviatura ustida qoladi, sahifa surilmaydi va orqa fon scroll bo'lmaydi. */
function useMobileViewport(open: boolean) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia('(max-width: 639px)');
    const vv = window.visualViewport;
    const update = () => {
      if (!mq.matches) return setBox(null);
      setBox({ top: vv?.offsetTop ?? 0, height: vv?.height ?? window.innerHeight });
    };
    update();
    const html = document.documentElement;
    const prev = { body: document.body.style.overflow, html: html.style.overflow };
    const lock = () => {
      document.body.style.overflow = mq.matches ? 'hidden' : prev.body;
      html.style.overflow = mq.matches ? 'hidden' : prev.html;
    };
    lock();
    const onChange = () => {
      update();
      lock();
    };
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    mq.addEventListener('change', onChange);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      mq.removeEventListener('change', onChange);
      document.body.style.overflow = prev.body;
      html.style.overflow = prev.html;
    };
  }, [open]);
  return box;
}

export function ChatWidget({ pulse }: { pulse: number }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);

  const unread = useQuery({
    queryKey: ['chat', 'unread'],
    queryFn: () => api.get<{ count: number; chats: number }>('/chat/unread-count'),
    refetchInterval: 60_000, // SSE asosiy kanal; polling — zaxira
    enabled: !!user,
  });
  const total = unread.data?.count ?? 0;
  const mobileBox = useMobileViewport(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if (activeId) setActiveId(null);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeId]);

  if (!user) return null;

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label={t('chat.title')}
          style={mobileBox ? { top: mobileBox.top, height: mobileBox.height } : undefined}
          className="fixed inset-x-0 top-0 z-[56] flex h-[100dvh] animate-pop-in flex-col overflow-hidden overscroll-none bg-white dark:bg-[#111827] sm:inset-x-auto sm:bottom-24 sm:right-6 sm:top-auto sm:h-[680px] sm:max-h-[calc(100vh-128px)] sm:w-[440px] sm:rounded-2xl sm:border sm:border-gray-200 sm:shadow-pop sm:dark:border-[#374151]"
        >
          {activeId ? (
            <Conversation userId={activeId} meId={user.id} meName={user.fullName} onBack={() => setActiveId(null)} onClose={() => setOpen(false)} />
          ) : (
            <ContactList onPick={setActiveId} onClose={() => setOpen(false)} meId={user.id} />
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={total ? `${t('chat.open')} — ${t('chat.unread', { count: total })}` : t('chat.open')}
        aria-expanded={open}
        title={t('chat.title')}
        className={cn(open && 'max-sm:hidden', 'fixed bottom-6 right-6 z-[56] flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-gradient-to-tl from-[#048494] to-[#10B981] text-on-brand shadow-[0_6px_20px_rgba(4,132,148,0.45)] transition-transform hover:scale-105 active:scale-95')}
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle key={`chat-${pulse}`} className={cn('h-6 w-6', pulse > 0 && 'animate-bell-ring')} />}
        {!!total && (
          <span key={`chat-badge-${pulse}`} className="absolute -right-1 -top-1 animate-badge-pop">
            <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-60" />
            <span className="relative block min-w-[22px] rounded-full border-2 border-white bg-red-500 dark:border-[#111827] px-1 text-center text-[11px] font-bold leading-[18px] text-on-brand">
              {total > 99 ? '99+' : total}
            </span>
          </span>
        )}
      </button>
    </>
  );
}

// ---------------- Suhbatdoshlar ro'yxati ----------------

function listTime(iso: string, t: ReturnType<typeof useTranslation>['t']) {
  const d = dt(iso);
  const now = DateTime.now().setZone(TZ);
  if (d.hasSame(now, 'day')) return d.toFormat('HH:mm');
  if (d.hasSame(now.minus({ days: 1 }), 'day')) return t('chat.yesterday');
  if (now.diff(d, 'days').days < 7) return (t('weekdaysShort', { returnObjects: true }) as string[])[d.weekday - 1];
  return d.toFormat('dd.MM.yy');
}

function ContactList({ onPick, onClose, meId }: { onPick: (id: number) => void; onClose: () => void; meId: number }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const contacts = useQuery({ queryKey: ['chat', 'contacts'], queryFn: () => api.get<ChatContact[]>('/chat/contacts') });

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (contacts.data ?? []).filter((c) => !s || c.fullName.toLowerCase().includes(s));
  }, [contacts.data, search]);

  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-[#1F2937]">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
          <Logo variant="row" className="h-6 w-auto" />
          <span className="leading-none text-gray-400" aria-hidden="true">—</span>
          <span className="leading-none">{t('chat.title')}</span>
        </h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="shrink-0 px-3 py-2">
        <label className="flex h-10 items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3.5 text-gray-500 focus-within:border-brand-500 dark:border-[#374151] dark:bg-[#1F2937] dark:focus-within:border-brand-500">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.search')}
            aria-label={t('chat.search')}
            className="w-full bg-transparent text-base text-gray-900 outline-none sm:text-sm placeholder:text-gray-500 focus-visible:ring-0 focus-visible:ring-offset-0"
            autoFocus
          />
        </label>
      </div>
      <ul className="no-scrollbar min-h-0 grow overflow-y-auto overscroll-contain">
        {contacts.isLoading && (
          <li className="flex justify-center py-10">
            <Spinner />
          </li>
        )}
        {contacts.isSuccess && !list.length && <li className="py-10 text-center text-sm text-gray-500">{t('chat.empty')}</li>}
        {list.map((c) => {
          const last = c.lastMessage;
          const mine = last?.senderId === meId;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-[#1F2937]"
              >
                <Avatar id={c.id} name={c.fullName} size={52} />
                <span className="flex min-w-0 grow flex-col gap-1 border-b border-gray-100 py-1.5 dark:border-[#1F2937]">
                  <span className="flex items-center gap-2">
                    <span className={cn('min-w-0 grow truncate font-semibold text-gray-900', !c.active && 'text-gray-500')}>{c.fullName}</span>
                    {mine && <Ticks read={!!last?.readAt} className="text-brand-500" />}
                    {last && <span className="shrink-0 text-xs text-gray-500">{listTime(last.createdAt, t)}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 grow truncate text-sm text-gray-500">
                      {last ? (
                        <>
                          {mine && <span className="text-gray-700">{t('chat.you')}: </span>}
                          {previewText(last.body, last.attachmentKind, t)}
                        </>
                      ) : (
                        `${t(`roles.${c.role}`)}${c.active ? '' : ` · ${t('chat.inactive')}`}`
                      )}
                    </span>
                    {!!c.unread && <UnreadBadge n={c.unread} />}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------- Suhbat ----------------

function dayLabel(iso: string, t: ReturnType<typeof useTranslation>['t']) {
  const d = dt(iso);
  const now = DateTime.now().setZone(TZ);
  if (d.hasSame(now, 'day')) return t('chat.today');
  if (d.hasSame(now.minus({ days: 1 }), 'day')) return t('chat.yesterday');
  const months = t('months', { returnObjects: true }) as string[];
  return `${d.day} ${months[d.month - 1]}${d.year !== now.year ? ` ${d.year}` : ''}`;
}

function Conversation({ userId, meId, meName, onBack, onClose }: { userId: number; meId: number; meName: string; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  // Tahrirlanayotgan o'z xabari (matn maydoni shu xabar matni bilan to'ladi)
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [menu, setMenu] = useState<{ msg: ChatMessage; x: number; y: number } | null>(null);
  const [toDelete, setToDelete] = useState<ChatMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Eski xabarlar yuklanganda ko'rinayotgan joy siljimasin
  const keepFromBottom = useRef<number | null>(null);
  const lastIdRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  // Yuborishga tayyorlangan fayl (izoh — matn maydonida) va yuklash foizi
  const [pending, setPending] = useState<{ file: File; kind: ChatAttachmentKind; previewUrl: string | null } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // Video avval brauzerda siqiladi (convert), keyin yuklanadi (upload)
  const [phase, setPhase] = useState<'convert' | 'upload'>('upload');
  const [dragOver, setDragOver] = useState(false);

  const contacts = useQuery({ queryKey: ['chat', 'contacts'], queryFn: () => api.get<ChatContact[]>('/chat/contacts') });
  const peer = contacts.data?.find((c) => c.id === userId);
  // ['chat'] ostida emas: SSE har xabarda ['chat']ni yangilaydi, sozlama esa o'zgarmaydi
  const chatConfig = useQuery({
    queryKey: ['chat-config'],
    queryFn: () => api.get<{ attachments: boolean; maxFileBytes: number }>('/chat/config'),
    staleTime: Infinity,
  });
  const filesOn = !!chatConfig.data?.attachments;
  const maxBytes = chatConfig.data?.maxFileBytes ?? 20 * 1024 * 1024;

  const history = useInfiniteQuery({
    queryKey: ['chat', 'with', userId],
    queryFn: ({ pageParam }) =>
      api.get<{ items: ChatMessage[]; hasMore: boolean }>(`/chat/with/${userId}${qs({ before: pageParam, limit: PAGE })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.items[0]?.id : undefined),
  });
  const messages = useMemo(() => (history.data?.pages ?? []).slice().reverse().flatMap((p) => p.items), [history.data]);

  const markRead = useMutation({
    mutationFn: () => api.post(`/chat/with/${userId}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat'] }),
  });
  const hasUnreadIncoming = messages.some((m) => m.senderId === userId && !m.readAt);
  useEffect(() => {
    // Suhbat ko'rinib turgan bo'lsagina o'qilgan sanaladi (boshqa tabda yoki oyna yashirin bo'lsa — yo'q)
    const read = () => {
      if (hasUnreadIncoming && !document.hidden && !markRead.isPending) markRead.mutate();
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUnreadIncoming, userId]);

  const send = useMutation({
    mutationFn: (body: string) => api.post<ChatMessage>(`/chat/with/${userId}`, { body }),
    onSuccess: (m) => {
      // Darhol ko'rinsin (SSE keyin ham yangilaydi)
      appendCached(m);
      void qc.invalidateQueries({ queryKey: ['chat', 'contacts'] });
    },
  });

  const appendCached = (m: ChatMessage) =>
    qc.setQueryData(['chat', 'with', userId], (d: typeof history.data) =>
      d && !d.pages[0].items.some((x) => x.id === m.id)
        ? { ...d, pages: [{ ...d.pages[0], items: [...d.pages[0].items, m] }, ...d.pages.slice(1)] }
        : d,
    );

  const fileError = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    const key = ['FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE', 'TOO_LONG', 'FILE_STORAGE_UNAVAILABLE', 'FILE_STORAGE_DISABLED'].includes(code) ? code : 'GENERIC';
    toast.error(t(`chat.fileErrors.${key}`, { max: fmtSize(maxBytes) }));
  };

  // Yuborilgan (siqilgan) fayl: o'zida qayta yuklab olinmasin
  const sentFile = useRef<File | null>(null);
  const sendFile = useMutation({
    mutationFn: async (v: { file: File; kind: ChatAttachmentKind; body: string; durationSec?: number; size?: number }) => {
      let { file, kind, durationSec } = v;
      const { body, size } = v;
      let meta: { width?: number; height?: number; durationSec?: number } = size ? { width: size, height: size } : {};
      if (kind === 'VIDEO') {
        // Tanlangan video: ≤ 60 s — dumaloq video xabar, uzunrog'i — siqilgan oddiy video
        setPhase('convert');
        setProgress(0);
        try {
          const c = await compressVideo(file, maxBytes, setProgress);
          ({ file, kind, durationSec } = c);
          meta = { width: c.width, height: c.height };
        } catch (e) {
          if ((e as Error).message === 'TOO_LONG') throw new ApiError(400, 'TOO_LONG', 'too long');
          // Siqib bo'lmasa (brauzer qo'llamaydi) — asl fayl, 20 MB ga sig'sa
          meta = await readMediaMeta(file, 'VIDEO');
        }
      } else if (kind === 'IMAGE') meta = await readMediaMeta(file, kind);
      const waveform = kind === 'VOICE' ? await computeWaveform(file) : null;
      if (file.size > maxBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'too large');
      setPhase('upload');
      const form = new FormData();
      form.set('kind', kind);
      form.set('body', body);
      const dur = durationSec ?? meta.durationSec;
      if (dur != null) form.set('durationSec', String(dur));
      if (meta.width && meta.height) {
        form.set('width', String(meta.width));
        form.set('height', String(meta.height));
      }
      if (waveform) form.set('waveform', waveform.join(','));
      form.set('file', file, file.name);
      setProgress(0);
      sentFile.current = file;
      return uploadChatFile(userId, form, setProgress);
    },
    onSuccess: (m) => {
      if (m.attachment && sentFile.current) primeChatFile(m.attachment.id, sentFile.current);
      appendCached(m);
      void qc.invalidateQueries({ queryKey: ['chat', 'contacts'] });
    },
    onError: fileError,
    onSettled: () => {
      setProgress(null);
      setPhase('upload');
      sentFile.current = null;
    },
  });

  const recorder = useRecorder((r: Recorded) => sendFile.mutate({ file: r.file, kind: r.kind, body: '', durationSec: r.durationSec, size: r.size }));
  const startRecording = (kind: RecKind) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error(t('chat.recordUnsupported'));
      return;
    }
    recorder.start(kind).catch(() => toast.error(t(kind === 'VOICE' ? 'chat.micDenied' : 'chat.cameraDenied')));
  };

  const clearPending = () =>
    setPending((p) => {
      if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return null;
    });
  /** media — faqat rasm/video; file — hujjat (siqilmagan, yuklab olinadi); auto — sudrab tashlanganda turidan */
  const pickFile = (file: File | undefined, mode: 'media' | 'file' | 'auto' = 'auto') => {
    if (!file || !filesOn) return;
    const kind: ChatAttachmentKind | null = mode === 'file' ? 'FILE' : (pickedKind(file) ?? (mode === 'auto' ? 'FILE' : null));
    if (!kind) return toast.error(t('chat.fileErrors.UNSUPPORTED_FILE_TYPE'));
    // Video yuborishda siqiladi: katta asl fayl ham qabul qilinadi
    const limit = kind === 'VIDEO' ? VIDEO_SOURCE_MAX_BYTES : maxBytes;
    if (file.size > limit) return toast.error(t('chat.fileErrors.FILE_TOO_LARGE', { max: fmtSize(limit) }));
    if (editing) cancelEdit();
    clearPending();
    setPending({ file, kind, previewUrl: kind === 'IMAGE' ? URL.createObjectURL(file) : null });
    inputRef.current?.focus();
  };
  useEffect(() => () => clearPending(), []);

  /** Keshdagi suhbat sahifalarida bitta xabarni almashtirish (null — olib tashlash) */
  const patchCached = (id: number, fn: (m: ChatMessage) => ChatMessage | null) =>
    qc.setQueryData(['chat', 'with', userId], (d: typeof history.data) =>
      d && {
        ...d,
        pages: d.pages.map((p) => ({ ...p, items: p.items.flatMap((x) => (x.id === id ? (fn(x) ?? []) : [x])) })),
      },
    );

  const edit = useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) => api.patch<ChatMessage>(`/chat/messages/${id}`, { body }),
    onSuccess: (m) => {
      patchCached(m.id, () => m);
      void qc.invalidateQueries({ queryKey: ['chat', 'contacts'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/chat/messages/${id}`),
    onSuccess: (_r, id) => {
      patchCached(id, () => null);
      setToDelete(null);
      if (editing?.id === id) cancelEdit();
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });

  const startEdit = (m: ChatMessage) => {
    clearPending();
    setEditing(m);
    setText(m.body);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const cancelEdit = () => {
    setEditing(null);
    setText('');
  };

  const submit = () => {
    const body = text.trim();
    if (send.isPending || edit.isPending || sendFile.isPending) return;
    if (pending) {
      const p = pending;
      setText('');
      setPending(null);
      sendFile.mutate(
        { file: p.file, kind: p.kind, body },
        {
          onSuccess: () => p.previewUrl && URL.revokeObjectURL(p.previewUrl),
          onError: () => {
            setPending(p);
            setText(body);
          },
        },
      );
      inputRef.current?.focus();
      return;
    }
    // Faylli xabarning izohini butunlay olib tashlash mumkin
    if (!body && !editing?.attachment) return;
    if (editing) {
      const target = editing;
      cancelEdit();
      if (body !== target.body) edit.mutate({ id: target.id, body }, { onError: () => startEdit({ ...target, body }) });
    } else {
      setText('');
      send.mutate(body, { onError: () => setText(body) });
    }
    inputRef.current?.focus();
  };

  // Pastga aylantirish: birinchi ochilishda, o'z xabarida yoki pastda turgan bo'lsa yangi xabarda
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
      return;
    }
    const last = messages.at(-1);
    if (!last || last.id === lastIdRef.current) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (lastIdRef.current === null || nearBottom || last.senderId === meId) el.scrollTop = el.scrollHeight;
    lastIdRef.current = last.id;
  }, [messages, meId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [userId]);

  const openMenu = (m: ChatMessage, e: React.MouseEvent) => {
    // Matn belgilanayotgan bo'lsa (nusxa olish uchun) menyu ochilmasin
    if (e.type === 'click' && window.getSelection()?.toString()) return;
    e.preventDefault();
    setMenu({ msg: m, x: e.clientX, y: e.clientY });
  };

  // Matn maydoni balandligi matnga qarab (ko'pi bilan ~6 qator)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const loadOlder = () => {
    const el = scrollRef.current;
    if (!history.hasNextPage || history.isFetchingNextPage || !el) return;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    void history.fetchNextPage();
  };

  const canSend = peer?.active !== false;
  const name = peer?.fullName ?? '';

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-gray-200 px-2 dark:border-[#1F2937]">
        <button type="button" onClick={onBack} aria-label={t('common.back')} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]">
          <ArrowLeft className="h-5 w-5" />
        </button>
        {peer && <Avatar id={peer.id} name={name} size={38} />}
        <div className="min-w-0 grow">
          <div className="truncate text-sm font-semibold text-gray-900">{name}</div>
          {peer && <div className="truncate text-xs text-gray-500">{peer.active ? t(`roles.${peer.role}`) : t('chat.inactive')}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]">
          <X className="h-5 w-5" />
        </button>
      </div>

      <NowPlayingBar />
      <div className="relative flex min-h-0 grow flex-col">
      {recorder.rec?.kind === 'VIDEO_NOTE' && <VideoNotePreview stream={recorder.rec.stream} elapsed={recorder.elapsed} />}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-[2] flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-white/85 text-sm font-medium text-brand-600 dark:bg-[#111827]/85">
          {t('chat.dropHere')}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          if (e.currentTarget.scrollTop < 60) loadOlder();
        }}
        onDragOver={(e) => {
          if (!filesOn || !canSend || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!filesOn || !canSend) return;
          e.preventDefault();
          setDragOver(false);
          pickFile(e.dataTransfer.files[0]);
        }}
        className="no-scrollbar min-h-0 grow overflow-y-auto overscroll-contain bg-brand-25 px-3 py-2 dark:bg-[#1F2937]"
      >
        {history.isLoading && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {history.isFetchingNextPage && (
          <div className="flex justify-center py-2">
            <Spinner />
          </div>
        )}
        {history.isSuccess && !messages.length && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <span className="rounded-2xl bg-black/20 px-4 py-2 text-sm text-on-brand dark:bg-[#374151]">
              {t('chat.noMessages')}
              <br />
              <span className="text-xs opacity-90">{t('chat.startHint')}</span>
            </span>
          </div>
        )}
        {messages.map((m, i) => {
          const mine = m.senderId === meId;
          const prev = messages[i - 1];
          const newDay = !prev || !dt(prev.createdAt).hasSame(dt(m.createdAt), 'day');
          const grouped = !newDay && prev?.senderId === m.senderId;
          const next = messages[i + 1];
          // Telegram kabi: ketma-ket xabarlar guruhining oxirgisida pastki burchakda "ilmoq"
          const lastInGroup = !next || next.senderId !== m.senderId || !dt(next.createdAt).hasSame(dt(m.createdAt), 'day');
          const att = m.attachment;
          const note = att?.kind === 'VIDEO_NOTE';
          const voiceFooter = att?.kind === 'VOICE' && !m.body;
          // Izohsiz rasm/video: vaqt rasm ustida (Telegram kabi)
          const overlayTime = !!att && !m.body && att.kind !== 'VOICE' && att.kind !== 'FILE';
          const timeInner = (
            <>
              {m.editedAt && <span className="mr-0.5 italic">{t('chat.edited')}</span>}
              {dt(m.createdAt).toFormat('HH:mm')}
              {mine && <Ticks read={!!m.readAt} className="h-3.5 w-3.5" />}
            </>
          );
          const timeFloat = (
            <span className={cn('float-right ml-2 mt-1.5 flex translate-y-0.5 items-center gap-0.5 text-[11px] leading-none', mine ? 'text-on-brand/80' : 'text-gray-500')}>
              {timeInner}
            </span>
          );
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="sticky top-0 z-[1] my-2 flex justify-center">
                  <span className="rounded-full bg-black/25 px-3 py-0.5 text-xs font-medium text-on-brand backdrop-blur-sm dark:bg-[#374151]/90">{dayLabel(m.createdAt, t)}</span>
                </div>
              )}
              <div className={cn('flex', mine ? 'justify-end pr-2' : 'justify-start pl-2', grouped ? 'mt-0.5' : 'mt-2')}>
                <div
                  onClick={mine ? (e) => openMenu(m, e) : undefined}
                  onContextMenu={mine ? (e) => openMenu(m, e) : undefined}
                  className={cn(
                    'relative max-w-[82%] text-sm',
                    mine && 'cursor-pointer',
                    // Dumaloq video xabar — pufakchasiz, faqat doira
                    note && menu?.msg.id === m.id && 'rounded-full ring-2 ring-brand-300',
                    !note && [
                      'rounded-2xl shadow-sm',
                      att ? 'p-1' : 'px-3 py-1.5',
                      menu?.msg.id === m.id && 'ring-2 ring-brand-300',
                      mine ? 'bg-brand-500 text-on-brand dark:bg-brand-600' : 'bg-white text-gray-900 dark:bg-[#374151]',
                      lastInGroup && (mine ? 'rounded-br-none' : 'rounded-bl-none'),
                    ],
                  )}
                >
                  {!note && lastInGroup && <BubbleTail mine={mine} />}
                  {att && (
                    <AttachmentView
                      att={att}
                      mine={mine}
                      footer={
                        voiceFooter ? (
                          <span className={cn('flex items-center gap-0.5 text-[11px] leading-none', mine ? 'text-on-brand/80' : 'text-gray-500')}>{timeInner}</span>
                        ) : null
                      }
                      sender={{
                        avatar: <Avatar id={m.senderId} name={mine ? meName : name} size={44} />,
                        name: mine ? meName : name,
                        time: `${dayLabel(m.createdAt, t)}, ${dt(m.createdAt).toFormat('HH:mm')}`,
                      }}
                      overlay={
                        overlayTime ? (
                          <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-full bg-black/45 px-1.5 py-0.5 text-[11px] leading-none text-on-brand">
                            {timeInner}
                          </span>
                        ) : null
                      }
                    />
                  )}
                  {(!att || m.body) && (
                    <div className={cn(att && 'px-2 pb-0.5 pt-1')}>
                      <span className="whitespace-pre-wrap break-words">{m.body}</span>
                      {/* Vaqt va ✓ — Telegram'dagidek matn oxirida, o'ng pastda */}
                      {timeFloat}
                    </div>
                  )}
                  {att?.kind === 'FILE' && !m.body && <div className="flow-root px-2 pb-0.5">{timeFloat}</div>}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
      </div>

      {canSend && sendFile.isPending && (
        <div className="flex shrink-0 items-center gap-3 border-t border-gray-200 px-3 py-1.5 dark:border-[#1F2937]">
          <Spinner size="small" className="text-brand-500" />
          <div className="min-w-0 grow">
            <div className="text-xs font-semibold text-brand-500">{phase === 'convert' ? t('chat.converting') : t('chat.uploading')}</div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-[#374151]">
              <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
          </div>
          <span className="text-xs tabular-nums text-gray-500">{Math.round((progress ?? 0) * 100)}%</span>
        </div>
      )}
      {canSend && pending && (
        <div className="flex shrink-0 items-center gap-3 border-t border-gray-200 px-3 py-1.5 dark:border-[#1F2937]">
          {pending.previewUrl ? (
            <img src={pending.previewUrl} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-500 dark:bg-[#374151]">
              {pending.kind === 'IMAGE' ? <ImageIcon className="h-5 w-5" /> : pending.kind === 'FILE' ? <FileIcon className="h-5 w-5" /> : <Film className="h-5 w-5" />}
            </span>
          )}
          <div className="min-w-0 grow border-l-2 border-brand-500 pl-2">
            <div className="text-xs font-semibold text-brand-500">{t(`chat.kind.${pending.kind}`)}</div>
            <div className="truncate text-xs text-gray-500">
              {pending.file.name} · {fmtSize(pending.file.size)}
            </div>
          </div>
          <button type="button" onClick={clearPending} aria-label={t('chat.removeFile')} title={t('chat.removeFile')} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {canSend && editing && (
        <div className="flex shrink-0 items-center gap-3 border-t border-gray-200 px-3 py-1.5 dark:border-[#1F2937]">
          <Pencil className="h-4 w-4 shrink-0 text-brand-500" />
          <div className="min-w-0 grow border-l-2 border-brand-500 pl-2">
            <div className="text-xs font-semibold text-brand-500">{t('chat.editing')}</div>
            <div className="truncate text-xs text-gray-500">{previewText(editing.body, editing.attachment?.kind, t)}</div>
          </div>
          <button type="button" onClick={cancelEdit} aria-label={t('chat.cancelEdit')} title={t('chat.cancelEdit')} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-[#1F2937]">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {canSend && recorder.rec ? (
        <RecordingBar
          kind={recorder.rec.kind}
          elapsed={recorder.elapsed}
          onCancel={() => recorder.stop(false)}
          onSend={() => recorder.stop(true)}
          sendIcon={<SendHorizontal className="h-5 w-5" />}
        />
      ) : canSend ? (
        <form
          className={cn('flex shrink-0 items-end gap-2 p-2', !editing && !pending && !sendFile.isPending && 'border-t border-gray-200 dark:border-[#1F2937]')}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {filesOn && !editing && (
            <div className="relative shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept={PICK_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files?.[0], 'media');
                  e.target.value = '';
                }}
              />
              <input
                ref={docInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files?.[0], 'file');
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => setAttachMenu((v) => !v)}
                disabled={sendFile.isPending}
                aria-label={t('chat.attach')}
                aria-expanded={attachMenu}
                title={t('chat.attach')}
                className={cn(
                  'flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-brand-500 disabled:cursor-default disabled:opacity-40 dark:hover:bg-[#1F2937]',
                  attachMenu && 'text-brand-500',
                )}
              >
                <Paperclip className="h-5 w-5" />
              </button>
              {attachMenu && (
                <AttachMenu
                  onClose={() => setAttachMenu(false)}
                  items={[
                    { icon: ImageIcon, label: t('chat.attachMedia'), onClick: () => fileInputRef.current?.click() },
                    { icon: FileIcon, label: t('chat.attachFile'), onClick: () => docInputRef.current?.click() },
                  ]}
                />
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter — yuborish, Shift+Enter — yangi qator (Telegram kabi)
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape' && (editing || pending)) {
                e.preventDefault();
                if (editing) cancelEdit();
                else clearPending();
              } else if (e.key === 'ArrowUp' && !text) {
                // Telegram kabi: bo'sh maydonda ↑ — oxirgi o'z xabarini tahrirlash
                const lastMine = messages.findLast((x) => x.senderId === meId);
                if (lastMine) {
                  e.preventDefault();
                  startEdit(lastMine);
                }
              }
            }}
            onPaste={(e) => {
              // Skrinshotni to'g'ridan-to'g'ri qo'yish (Ctrl+V)
              const f = Array.from(e.clipboardData.files).find((x) => pickedKind(x));
              if (f && filesOn && !editing) {
                e.preventDefault();
                pickFile(f);
              }
            }}
            placeholder={pending ? t('chat.captionPlaceholder') : t('chat.placeholder')}
            aria-label={pending ? t('chat.captionPlaceholder') : t('chat.placeholder')}
            className="no-scrollbar max-h-[140px] min-h-10 grow resize-none rounded-2xl border border-gray-200 bg-gray-50 px-3.5 py-2 dark:border-[#374151] dark:bg-[#1F2937] dark:focus:border-brand-500 text-base text-gray-900 outline-none placeholder:text-gray-500 focus:border-brand-500 sm:text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {filesOn && !editing && !pending && !text.trim() ? (
            // Matn bo'sh: Telegram kabi ovozli va dumaloq video xabar tugmalari
            <>
              <button
                type="button"
                onClick={() => startRecording('VOICE')}
                disabled={sendFile.isPending}
                aria-label={t('chat.recordVoice')}
                title={t('chat.recordVoice')}
                className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-brand-500 disabled:cursor-default disabled:opacity-40 dark:hover:bg-[#1F2937]"
              >
                <Mic className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => startRecording('VIDEO_NOTE')}
                disabled={sendFile.isPending}
                aria-label={t('chat.recordVideo')}
                title={t('chat.recordVideo')}
                className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-brand-500 disabled:cursor-default disabled:opacity-40 dark:hover:bg-[#1F2937]"
              >
                <Video className="h-5 w-5" />
              </button>
            </>
          ) : (
            <button
              type="submit"
              disabled={(!text.trim() && !pending && !editing?.attachment) || send.isPending || edit.isPending || sendFile.isPending}
              aria-label={editing ? t('common.save') : t('chat.send')}
              title={editing ? t('common.save') : t('chat.send')}
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand-500 text-on-brand transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:cursor-default disabled:opacity-40"
            >
              {editing ? <Check className="h-5 w-5" /> : <SendHorizontal className="h-5 w-5" />}
            </button>
          )}
        </form>
      ) : (
        <div className="shrink-0 border-t border-gray-200 p-3 text-center text-xs text-gray-500 dark:border-[#1F2937]">{t('chat.inactiveHint')}</div>
      )}

      {menu && (
        <MessageMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(canSend ? [{ icon: Pencil, label: t('chat.edit'), onClick: () => startEdit(menu.msg) }] : []),
            { icon: Trash2, label: t('chat.delete'), danger: true, onClick: () => setToDelete(menu.msg) },
          ]}
        />
      )}
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        loading={remove.isPending}
        title={t('chat.deleteTitle')}
        text={t('chat.deleteText')}
      />
    </>
  );
}

/** Xabar ustida o'ng tugma / bosilganda chiqadigan menyu (Telegram kabi). Body'ga portal: chat oynasining transform'i fixed'ni buzmasin */
function MessageMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: { icon: typeof Pencil; label: string; danger?: boolean; onClick: () => void }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Oyna chetidan chiqmasin
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, []);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={pos}
      className="fixed z-[58] min-w-[170px] animate-pop-in overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-pop dark:border-[#4B5563] dark:bg-[#374151]"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            it.onClick();
          }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-3 px-3.5 py-2 text-left text-sm outline-none hover:bg-gray-100 focus-visible:bg-gray-100 dark:hover:bg-[#4B5563] dark:focus-visible:bg-[#4B5563] focus-visible:ring-0 focus-visible:ring-offset-0',
            it.danger ? 'text-red-600' : 'text-gray-900',
          )}
        >
          <it.icon className="h-4 w-4" />
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** 📎 menyusi (Telegram kabi): tugma ustida ochiladi, tashqariga bosish yoki Esc — yopiladi */
function AttachMenu({ items, onClose }: { items: { icon: typeof Pencil; label: string; onClick: () => void }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const btn = ref.current?.parentElement?.querySelector('button[aria-expanded]');
      if (!ref.current?.contains(e.target as Node) && !btn?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="absolute bottom-full left-0 z-[3] mb-2 min-w-[200px] animate-pop-in overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-pop dark:border-[#4B5563] dark:bg-[#374151]"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            it.onClick();
          }}
          className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left text-sm text-gray-900 outline-none hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:ring-0 focus-visible:ring-offset-0 dark:hover:bg-[#4B5563] dark:focus-visible:bg-[#4B5563]"
        >
          <it.icon className="h-5 w-5 text-gray-500" />
          {it.label}
        </button>
      ))}
    </div>
  );
}
