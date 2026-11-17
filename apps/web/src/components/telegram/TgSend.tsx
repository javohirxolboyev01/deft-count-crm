import { AlertCircle, File as FileIcon, Image as ImageIcon, Paperclip, Plus, RotateCw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDuration, fmtSize } from '@/components/ChatMedia';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { prepareItem, releaseItem, startUpload, type SendItem, type UploadTask } from '@/lib/tgSend';
import { IconButton } from './TgChatList';
import { TgModal } from './TgDialogs';

/** Rasm/video/fayl yuborish UI (Telegram Desktop kabi): 📎 menyusi, yuborish oynasi, sudrab tashlash, yuklanayotgan xabar */

// Yuklanish progressi o'zgarganda qayta chizish
function useTasks(tasks: UploadTask[]) {
  const ver = useRef(0);
  useSyncExternalStore(
    (l) => {
      const offs = tasks.map((t) =>
        t.subscribe(() => {
          ver.current++;
          l();
        }),
      );
      return () => offs.forEach((o) => o());
    },
    () => ver.current,
  );
}

function Ring({ value, size = 48, onCancel, label }: { value: number; size?: number; onCancel?: () => void; label: string }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      onClick={onCancel}
      aria-label={label}
      title={label}
      className="relative flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/50 text-on-brand backdrop-blur-sm"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 48 48" className="absolute inset-0 h-full w-full -rotate-90 animate-[spin_2s_linear_infinite]" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.04, value))} />
      </svg>
      <X className="h-5 w-5" />
    </button>
  );
}

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4) : '');

function FileRow({ task, onRemove, out }: { task: UploadTask; onRemove?: () => void; out?: boolean }) {
  const { t } = useTranslation();
  const ext = extOf(task.item.name);
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-on-brand" style={{ background: 'var(--tg-primary)' }}>
        {task.item.preview ? (
          <img src={task.item.preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-[13px] font-semibold uppercase">{ext || <FileIcon className="h-5 w-5" />}</span>
        )}
      </span>
      <span className="min-w-0 grow">
        <span className="block truncate text-[15px] font-medium">{task.item.name}</span>
        <span className={cn('block text-[13px]', task.status === 'error' ? 'text-[var(--tg-danger)]' : out ? 'text-[var(--tg-out-meta)]' : 'text-[var(--tg-secondary)]')}>
          {task.status === 'error' ? errorText(task.error, t) : task.status === 'uploading' ? `${Math.round(task.progress * 100)}% · ${fmtSize(task.item.file.size)}` : fmtSize(task.item.file.size)}
        </span>
        {task.status === 'uploading' && (
          <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-black/10 dark:bg-on-brand/10">
            <span className="block h-full bg-[var(--tg-primary)] transition-[width]" style={{ width: `${Math.max(3, task.progress * 100)}%` }} />
          </span>
        )}
      </span>
      {onRemove && (
        <IconButton label={t('common.delete')} onClick={onRemove}>
          <X className="h-5 w-5" />
        </IconButton>
      )}
    </div>
  );
}

function MediaTile({ task, onRemove, big }: { task: UploadTask; onRemove?: () => void; big?: boolean }) {
  const { t } = useTranslation();
  const it = task.item;
  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-black/10', big ? 'max-h-[340px]' : 'aspect-square')}>
      {it.preview && <img src={it.preview} alt="" className={cn('h-full w-full', big ? 'max-h-[340px] object-contain' : 'object-cover')} />}
      {it.isVideo && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/50 px-1.5 text-xs text-on-brand">{fmtDuration(it.duration)}</span>}
      {task.status === 'uploading' && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Ring value={task.progress} size={40} label={t('common.cancel')} onCancel={onRemove} />
        </span>
      )}
      {task.status === 'error' && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 p-2 text-center text-xs text-on-brand">{errorText(task.error, t)}</span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={t('common.delete')} className="absolute right-1.5 top-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/50 text-on-brand hover:bg-black/70">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Yuborish oynasi: fayllar ochilishi bilanoq yuklana boshlaydi; «Yuborish» bosilganda vazifalar chatga o'tadi */
export function SendMediaDialog({
  files,
  compress: compress0,
  onClose,
  onSend,
}: {
  files: File[];
  compress: boolean;
  onClose: () => void;
  onSend: (groups: UploadTask[][], caption: string) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SendItem[]>([]);
  const [compress, setCompress] = useState(compress0);
  const [group, setGroup] = useState(true);
  const [caption, setCaption] = useState('');
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const handedOver = useRef(false);
  const addRef = useRef<HTMLInputElement>(null);
  const capRef = useRef<HTMLTextAreaElement>(null);
  useTasks(tasks);

  const addFiles = async (list: File[]) => {
    const prepared = await Promise.all(list.map(prepareItem));
    setItems((cur) => [...cur, ...prepared].slice(0, 30));
  };
  useEffect(() => {
    void addFiles(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Har element uchun yuklash vazifasi; «siqish» o'zgarsa qaytadan (baytlar boshqa)
  const tasksRef = useRef(new Map<string, UploadTask>());
  useEffect(() => {
    const m = tasksRef.current;
    for (const it of items) {
      const cur = m.get(it.key);
      const wantKind = compress && it.isImage ? 'PHOTO' : compress && it.isVideo ? 'VIDEO' : 'FILE';
      if (cur && cur.kind === wantKind) continue;
      cur?.abort();
      m.set(it.key, startUpload(it, compress));
    }
    for (const [k, task] of m) {
      if (!items.some((i) => i.key === k)) {
        task.abort();
        m.delete(k);
      }
    }
    setTasks(items.map((i) => m.get(i.key)!).filter(Boolean));
  }, [items, compress]);

  // Oyna yopilsa (yuborilmasdan) — yuklashlar bekor, oldindan ko'rish rasmlari bo'shatiladi
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(
    () => () => {
      if (handedOver.current) return;
      for (const task of tasksRef.current.values()) task.abort();
      itemsRef.current.forEach(releaseItem);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [caption]);

  const remove = (key: string) => {
    setItems((cur) => {
      const it = cur.find((x) => x.key === key);
      if (it) releaseItem(it);
      const next = cur.filter((x) => x.key !== key);
      if (!next.length) setTimeout(onClose);
      return next;
    });
  };

  const send = () => {
    if (!tasks.length) return;
    const media = tasks.filter((x) => x.kind !== 'FILE');
    const docs = tasks.filter((x) => x.kind === 'FILE');
    // Telegram qoidasi: albomda ko'pi bilan 10 ta; rasm/video va fayllar alohida albom
    const groups = group ? [...chunk(media, 10), ...chunk(docs, 10)] : tasks.map((x) => [x]);
    handedOver.current = true;
    onSend(groups, caption.trim());
    onClose();
  };

  const mediaTasks = tasks.filter((x) => x.kind !== 'FILE');
  const fileTasks = tasks.filter((x) => x.kind === 'FILE');
  const anyCompressible = items.some((i) => i.isImage || i.isVideo);
  const failed = tasks.some((x) => x.status === 'error');

  return (
    <TgModal onClose={onClose} label={t('tg.sendFiles', { count: items.length })} className="max-w-[440px]">
      <div className="flex items-center gap-2 px-5 pb-1 pt-4">
        <h2 className="grow text-xl font-medium">{t('tg.sendFiles', { count: items.length })}</h2>
      </div>
      <div
        className="tg-scroll min-h-0 grow overflow-y-auto px-5 pb-2"
        onPaste={(e) => {
          const fs = [...e.clipboardData.files];
          if (fs.length) {
            e.preventDefault();
            void addFiles(fs);
          }
        }}
      >
        {!items.length && <div className="py-8 text-center text-[var(--tg-secondary)]">{t('common.loading')}</div>}
        {mediaTasks.length === 1 && !fileTasks.length ? (
          <MediaTile task={mediaTasks[0]} big onRemove={() => remove(mediaTasks[0].item.key)} />
        ) : (
          mediaTasks.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {mediaTasks.map((x) => (
                <MediaTile key={x.item.key} task={x} onRemove={() => remove(x.item.key)} />
              ))}
            </div>
          )
        )}
        {fileTasks.length > 0 && (
          <div className={cn(mediaTasks.length > 0 && 'mt-2')}>
            {fileTasks.map((x) => (
              <FileRow key={x.item.key} task={x} onRemove={() => remove(x.item.key)} />
            ))}
          </div>
        )}
        {(anyCompressible || items.length > 1) && (
          <div className="mt-3 flex flex-col gap-2">
            {anyCompressible && (
              <Check checked={compress} onChange={setCompress}>
                {t('tg.compress')}
              </Check>
            )}
            {items.length > 1 && (
              <Check checked={group} onChange={setGroup}>
                {t('tg.groupItems')}
              </Check>
            )}
          </div>
        )}
        <textarea
          ref={capRef}
          rows={1}
          value={caption}
          maxLength={1024}
          autoFocus
          onChange={(e) => setCaption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t('tg.caption')}
          aria-label={t('tg.caption')}
          className="mt-3 w-full resize-none border-b-2 border-[var(--tg-border)] bg-transparent py-2 text-base outline-none transition-colors placeholder:text-[var(--tg-secondary)] focus:border-[var(--tg-primary)] focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>
      <div className="flex items-center gap-1 px-3 pb-3 pt-2">
        <button type="button" onClick={() => addRef.current?.click()} className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-[15px] font-semibold uppercase text-[var(--tg-primary)] hover:bg-[rgba(var(--tg-primary-rgb),0.08)]">
          <Plus className="h-4 w-4" />
          {t('common.add')}
        </button>
        <input
          ref={addRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const fs = [...(e.target.files ?? [])];
            e.target.value = '';
            if (fs.length) void addFiles(fs);
          }}
        />
        <span className="grow" />
        <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3 py-2 text-[15px] font-semibold uppercase text-[var(--tg-primary)] hover:bg-[rgba(var(--tg-primary-rgb),0.08)]">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={send}
          disabled={!tasks.length || failed}
          className="cursor-pointer rounded-lg px-3 py-2 text-[15px] font-semibold uppercase text-[var(--tg-primary)] hover:bg-[rgba(var(--tg-primary-rgb),0.08)] disabled:cursor-default disabled:opacity-50"
        >
          {t('tg.send')}
        </button>
      </div>
    </TgModal>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-[15px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-[18px] w-[18px] cursor-pointer accent-[var(--tg-primary)]" />
      {children}
    </label>
  );
}

// ---------------- 📎 menyusi ----------------

export function AttachButton({ onFiles, className, menuLeft }: { onFiles: (files: File[], compress: boolean) => void; className?: string; menuLeft?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLInputElement>(null);
  const doc = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const pick = (compress: boolean) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = [...(e.target.files ?? [])];
    e.target.value = '';
    if (fs.length) onFiles(fs, compress);
  };
  const item = 'flex w-full cursor-pointer items-center gap-4 px-4 py-2 text-left text-[15px] transition-colors hover:bg-black/5 dark:hover:bg-on-brand/10';
  return (
    <div ref={box} className={cn('relative mb-[7px] mr-1', className)}>
      <IconButton label={t('tg.attach')} onClick={() => setOpen((v) => !v)} active={open}>
        <Paperclip className="h-6 w-6 -rotate-45" />
      </IconButton>
      {open && (
        <div role="menu" className={cn('absolute bottom-full z-[3]', menuLeft ? 'left-0' : 'right-0', ' mb-2 w-[230px] animate-pop-in rounded-2xl py-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.25)] backdrop-blur-xl')} style={{ background: 'var(--tg-menu)' }}>
          <button type="button" role="menuitem" className={item} onClick={() => (setOpen(false), media.current?.click())}>
            <ImageIcon className="h-[22px] w-[22px] opacity-80" strokeWidth={1.8} />
            {t('tg.photoOrVideo')}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => (setOpen(false), doc.current?.click())}>
            <FileIcon className="h-[22px] w-[22px] opacity-80" strokeWidth={1.8} />
            {t('tg.document')}
          </button>
        </div>
      )}
      <input ref={media} type="file" accept="image/*,video/*" multiple hidden onChange={pick(true)} />
      <input ref={doc} type="file" multiple hidden onChange={pick(false)} />
    </div>
  );
}

// ---------------- Sudrab tashlash (Telegram Desktop: ikki zona) ----------------

export function DropOverlay({ onFiles, onDone }: { onFiles: (files: File[], compress: boolean) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [over, setOver] = useState<null | 'file' | 'media'>(null);
  const zone = (kind: 'file' | 'media', title: string, sub: string) => (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(kind);
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        const fs = [...e.dataTransfer.files];
        onDone();
        if (fs.length) onFiles(fs, kind === 'media');
      }}
      className={cn(
        'flex min-h-0 grow flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed text-center transition-colors',
        over === kind ? 'border-[var(--tg-primary)] bg-[rgba(var(--tg-primary-rgb),0.08)] text-[var(--tg-primary)]' : 'border-[var(--tg-border)] text-[var(--tg-secondary)]',
      )}
    >
      <span className="text-lg font-medium">{title}</span>
      <span className="text-sm">{sub}</span>
    </div>
  );
  return (
    <div
      className="absolute inset-0 z-[5] flex flex-col gap-2 p-3"
      style={{ background: 'var(--tg-bg)' }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDone();
      }}
    >
      {zone('file', t('tg.dropFiles'), t('tg.dropFilesSub'))}
      {zone('media', t('tg.dropMedia'), t('tg.dropMediaSub'))}
    </div>
  );
}

// ---------------- Chatdagi yuklanayotgan xabar ----------------

export interface MediaJob {
  key: number;
  groups: UploadTask[][];
  /** Shuncha guruh yuborib bo'lindi */
  sent: number;
  caption: string;
  replyToId: number | null;
  status: 'uploading' | 'sending' | 'failed';
  error: unknown;
}

export function PendingMedia({ job, onCancel, onRetry }: { job: MediaJob; onCancel: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const tasks = job.groups.slice(job.sent).flat();
  useTasks(tasks);
  const media = tasks.filter((x) => x.kind !== 'FILE');
  const files = tasks.filter((x) => x.kind === 'FILE');
  const avg = tasks.length ? tasks.reduce((n, x) => n + x.progress, 0) / tasks.length : 1;
  const failed = job.status === 'failed';
  return (
    <div className="mt-2 flex justify-end">
      {failed && (
        <div className="mr-2 flex items-center gap-1 self-center">
          <button type="button" onClick={onRetry} title={t('tg.retry')} className="cursor-pointer text-[var(--tg-danger)]">
            <RotateCw className="h-5 w-5" />
          </button>
          <button type="button" onClick={onCancel} title={t('common.delete')} className="cursor-pointer text-[var(--tg-secondary)]">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
      <div className="relative w-[min(360px,calc(100%-48px))] overflow-hidden rounded-[15px] shadow-[var(--tg-shadow)]" style={{ background: 'var(--tg-out)', color: 'var(--tg-out-text)' }}>
        {media.length > 0 && (
          <div className={cn('relative grid gap-0.5', media.length > 1 && 'grid-cols-2')}>
            {media.slice(0, 4).map((x, i) => (
              <div key={x.item.key} className={cn('relative bg-black/20', media.length === 1 ? 'max-h-[320px]' : 'aspect-square')}>
                {x.item.preview && <img src={x.item.preview} alt="" className={cn('h-full w-full', media.length === 1 ? 'max-h-[320px] object-contain' : 'object-cover')} />}
                {i === 3 && media.length > 4 && <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-2xl font-medium">+{media.length - 4}</span>}
              </div>
            ))}
            {!failed && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Ring value={job.status === 'sending' ? 1 : avg} size={54} label={t('common.cancel')} onCancel={onCancel} />
              </span>
            )}
          </div>
        )}
        {files.length > 0 && (
          <div className="px-2.5 py-1">
            {files.map((x) => (
              <FileRow key={x.item.key} task={x} out onRemove={media.length || failed ? undefined : onCancel} />
            ))}
          </div>
        )}
        {job.caption && <div className="whitespace-pre-wrap break-words px-2.5 pb-1 pt-1.5 text-base">{job.caption}</div>}
        <div className="flex items-center justify-end gap-1 px-2.5 pb-1.5 text-xs" style={{ color: 'var(--tg-out-meta)' }}>
          {failed ? (
            <>
              <AlertCircle className="h-3.5 w-3.5 text-[var(--tg-danger)]" />
              {errorText(job.error, t)}
            </>
          ) : job.status === 'sending' ? (
            t('tg.sending')
          ) : (
            `${t('tg.uploading')} ${Math.round(avg * 100)}%`
          )}
        </div>
      </div>
    </div>
  );
}
