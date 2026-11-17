import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Film, Mic, Paperclip, RotateCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { ChatAttachment } from '@/lib/types';
import { AttachmentView, computeWaveform, primeChatFile, fmtDuration, fmtSize, readMediaMeta, uploadForm, useRecorder, type Recorded } from './ChatMedia';

/**
 * "Yangi vazifa" fayllari (V54): rasm, video, ovoz (yozib olish yoki audio fayl), hujjat.
 * Fayl tanlanishi bilan Telegram kanaliga yuklanadi (`POST /tasks/attachments`, chat ombori bilan bir xil);
 * vazifa yuborilganda faqat id'lar jo'natiladi. Fayl faqat yaratishda qo'shiladi (rahbar qarori).
 */

export const TASK_FILES_MAX = 10;
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'];
// Server bilan bir xil (chat.ts KIND_MIMES.VOICE)
const AUDIO_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav'];
const AUDIO_EXT: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac' };

type Kind = 'IMAGE' | 'VIDEO' | 'VOICE' | 'FILE';

function kindOf(file: File): Kind {
  const mime = file.type.split(';')[0].toLowerCase();
  if (IMAGE_MIMES.includes(mime)) return 'IMAGE';
  if (VIDEO_MIMES.includes(mime)) return 'VIDEO';
  if (AUDIO_MIMES.includes(mime)) return 'VOICE';
  // Ba'zi tizimlar mp3/m4a turini bermaydi — kengaytmadan
  if (!mime && AUDIO_EXT[file.name.split('.').pop()?.toLowerCase() ?? '']) return 'VOICE';
  return 'FILE';
}

export interface PendingFile {
  key: number;
  file: File;
  kind: Kind;
  preview?: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  att?: ChatAttachment;
  durationSec?: number;
  abort: AbortController;
}

let seq = 0;

export function useTaskAttachments() {
  const { t } = useTranslation();
  const [items, setItems] = useState<PendingFile[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const config = useQuery({
    queryKey: ['chat-config'],
    queryFn: () => api.get<{ attachments: boolean; maxFileBytes: number }>('/chat/config'),
    staleTime: Infinity,
  });
  const enabled = !!config.data?.attachments;
  const maxBytes = config.data?.maxFileBytes ?? 20 * 1024 * 1024;

  const patch = (key: number, p: Partial<PendingFile>) => setItems((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const upload = useCallback(async (item: PendingFile, recordedSec?: number) => {
    patch(item.key, { status: 'uploading', progress: 0 });
    try {
      const form = new FormData();
      form.set('kind', item.kind);
      if (item.kind === 'IMAGE' || item.kind === 'VIDEO' || item.kind === 'VOICE') {
        const meta = await readMediaMeta(item.file, item.kind === 'IMAGE' ? 'IMAGE' : 'VIDEO');
        if (meta.width) form.set('width', String(meta.width));
        if (meta.height) form.set('height', String(meta.height));
        const sec = recordedSec ?? item.durationSec ?? meta.durationSec;
        if (sec) form.set('durationSec', String(sec));
      }
      if (item.kind === 'VOICE') {
        const wave = await computeWaveform(item.file);
        if (wave) form.set('waveform', wave.join(','));
      }
      form.set('file', item.file, item.file.name);
      const att = await uploadForm<ChatAttachment>('/tasks/attachments', form, (p) => patch(item.key, { progress: p }), item.abort.signal);
      const url = `/tasks/files/${att.id}`;
      // O'zi yuklagan faylni qayta Telegram'dan olmaslik uchun (ovozni oynada eshitish)
      primeChatFile(att.id, item.file, url);
      patch(item.key, { status: 'done', progress: 1, att: { ...att, url } });
    } catch (e: any) {
      if (e?.code === 'ABORTED') return;
      patch(item.key, { status: 'error' });
      const code = e?.code ?? '';
      const key = ['FILE_TOO_LARGE', 'TOO_LONG', 'FILE_STORAGE_UNAVAILABLE', 'FILE_STORAGE_DISABLED'].includes(code) ? code
        : code === 'UNSUPPORTED_FILE_TYPE' ? 'UNSUPPORTED' : 'GENERIC';
      toast.error(t(key === 'UNSUPPORTED' ? 'urgent.files.unsupported' : `chat.fileErrors.${key}`, { max: fmtSize(maxBytes) }));
    }
  }, [t, maxBytes]);

  const add = useCallback((files: File[], recorded?: Recorded) => {
    const free = TASK_FILES_MAX - itemsRef.current.length;
    if (files.length > free) toast.error(t('urgent.files.tooMany', { max: TASK_FILES_MAX }));
    for (const file of files.slice(0, Math.max(0, free))) {
      if (file.size > maxBytes) {
        toast.error(`${file.name}: ${t('chat.fileErrors.FILE_TOO_LARGE', { max: fmtSize(maxBytes) })}`);
        continue;
      }
      const kind = recorded ? 'VOICE' : kindOf(file);
      const item: PendingFile = {
        key: ++seq,
        file,
        kind,
        preview: kind === 'IMAGE' ? URL.createObjectURL(file) : undefined,
        progress: 0,
        status: 'uploading',
        durationSec: recorded?.durationSec,
        abort: new AbortController(),
      };
      setItems((list) => [...list, item]);
      void upload(item, recorded?.durationSec);
    }
  }, [t, maxBytes, upload]);

  const remove = (key: number) => {
    const it = itemsRef.current.find((x) => x.key === key);
    it?.abort.abort();
    if (it?.preview) URL.revokeObjectURL(it.preview);
    setItems((list) => list.filter((x) => x.key !== key));
  };

  const retry = (key: number) => {
    const it = itemsRef.current.find((x) => x.key === key);
    if (it) void upload(it);
  };

  const reset = useCallback(() => {
    for (const it of itemsRef.current) {
      it.abort.abort();
      if (it.preview) URL.revokeObjectURL(it.preview);
    }
    setItems([]);
  }, []);

  useEffect(() => reset, [reset]);

  const recorder = useRecorder((r) => add([r.file], r));

  return {
    items,
    enabled,
    add,
    remove,
    retry,
    reset,
    recorder,
    ids: items.flatMap((x) => (x.att ? [x.att.id] : [])),
    /** Yuklanmoqda, xato yoki yozib olinmoqda — vazifani hali yuborib bo'lmaydi */
    busy: items.some((x) => x.status !== 'done') || !!recorder.rec,
  };
}

export type TaskAttachmentsState = ReturnType<typeof useTaskAttachments>;

/** Oynadagi blok: tugmalar (fayl, ovoz yozish), yozib olish paneli va fayllar ro'yxati */
export function TaskAttachmentsField({ state }: { state: TaskAttachmentsState }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const { items, recorder } = state;
  const full = items.length >= TASK_FILES_MAX;

  const startVoice = async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t('chat.recordUnsupported'));
      return;
    }
    try {
      await recorder.start('VOICE');
    } catch {
      toast.error(t('chat.micDenied'));
    }
  };

  return (
    <div className="space-y-2">
      {recorder.rec ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50/60 px-2 py-1.5 dark:border-red-900/60 dark:bg-red-950/30">
          <button
            type="button"
            onClick={() => recorder.stop(false)}
            title={t('chat.cancelRecording')}
            aria-label={t('chat.cancelRecording')}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-red-600 hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <span className="flex min-w-0 grow items-center gap-2 text-sm text-foreground">
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
            <span className="shrink-0 tabular-nums">{fmtDuration(recorder.elapsed)}</span>
            <span className="min-w-0 truncate text-gray-500">{t('chat.recordingVoice')}</span>
          </span>
          <button
            type="button"
            onClick={() => recorder.stop(true)}
            title={t('urgent.files.stopRecording')}
            aria-label={t('urgent.files.stopRecording')}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand-500 text-on-brand hover:opacity-90"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={full}
            onClick={() => input.current?.click()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:border-brand-400 hover:bg-gray-50 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" />
            {t('urgent.files.add')}
          </button>
          <button
            type="button"
            disabled={full}
            onClick={startVoice}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:border-brand-400 hover:bg-gray-50 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Mic className="h-4 w-4" />
            {t('urgent.files.record')}
          </button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              state.add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      )}

      {items.length > 0 && (
        <ul className="custom-scrollbar max-h-56 space-y-1.5 overflow-y-auto pr-1">
          {items.map((it) => (
            <li key={it.key} className="relative flex items-center gap-3 overflow-hidden rounded-lg border px-2 py-1.5">
              {it.kind === 'VOICE' && it.att ? (
                <div className="min-w-0 grow text-sm">
                  <AttachmentView att={it.att} mine={false} />
                </div>
              ) : (
                <>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gray-100 text-gray-500">
                    {it.preview ? (
                      <img src={it.preview} alt="" className="h-full w-full object-cover" />
                    ) : it.kind === 'VIDEO' ? (
                      <Film className="h-5 w-5" />
                    ) : it.kind === 'VOICE' ? (
                      <Mic className="h-5 w-5" />
                    ) : (
                      <FileText className="h-5 w-5" />
                    )}
                  </span>
                  <span className="min-w-0 grow">
                    <span className="block truncate text-sm font-medium text-foreground" title={it.file.name}>{it.file.name}</span>
                    <span className={cn('block truncate text-xs', it.status === 'error' ? 'text-red-600' : 'text-gray-500')}>
                      {t(`chat.kind.${it.kind}`)} · {fmtSize(it.file.size)}
                      {it.durationSec ? ` · ${fmtDuration(it.durationSec)}` : ''}
                      {it.status === 'uploading' && ` · ${t('urgent.files.uploading', { p: Math.round(it.progress * 100) })}`}
                      {it.status === 'error' && ` · ${t('chat.fileLoadError')}`}
                    </span>
                  </span>
                </>
              )}
              {it.status === 'error' && (
                <button
                  type="button"
                  onClick={() => state.retry(it.key)}
                  title={t('common.retry')}
                  aria-label={t('common.retry')}
                  className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-brand hover:bg-gray-100"
                >
                  <RotateCw className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => state.remove(it.key)}
                title={t('chat.removeFile')}
                aria-label={t('chat.removeFile')}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-red-600"
              >
                <X className="h-4 w-4" />
              </button>
              {it.status === 'uploading' && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-gray-100">
                  <span className="block h-full bg-brand-500 transition-[width]" style={{ width: `${Math.max(3, it.progress * 100)}%` }} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Vazifa panelida: yaratishda qo'shilgan fayllar (rasm bosilsa kattalashadi, ovoz eshitiladi, hujjat yuklab olinadi) */
export function TaskAttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      {attachments.map((a) => {
        const att = { ...a, url: `/tasks/files/${a.id}` };
        return (
          <div key={a.id} className={cn('overflow-hidden rounded-lg border', a.kind === 'IMAGE' || a.kind === 'VIDEO' ? '' : 'w-full p-1.5')}>
            <AttachmentView att={att} mine={false} />
          </div>
        );
      })}
    </div>
  );
}
