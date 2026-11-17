import { useQuery } from '@tanstack/react-query';
import { Copy, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import type { TgDialog, TgMessage, TgTextEntity } from '@/lib/types';
import { FormattedText, TgAvatar, statusText } from './tgUi';

/** Xabar amallari oynalari (V53+): o'chirishni tasdiqlash, uzatish, tarjima — Telegram ko'rinishida */

export function TgModal({ onClose, children, className, label }: { onClose: () => void; children: ReactNode; className?: string; label: string }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <div className="tg fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn('flex max-h-[min(640px,calc(100dvh-32px))] w-full max-w-[400px] animate-pop-in flex-col overflow-hidden rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)]', className)}
        style={{ background: 'var(--tg-bg)', color: 'var(--tg-text)' }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function TextButton({ children, onClick, danger, disabled }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'cursor-pointer rounded-lg px-3 py-2 text-[15px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-default disabled:opacity-50',
        danger ? 'text-[var(--tg-danger)] hover:bg-[var(--tg-danger)]/10' : 'text-[var(--tg-primary)] hover:bg-[rgba(var(--tg-primary-rgb),0.08)]',
      )}
    >
      {children}
    </button>
  );
}

// ---------------- O'chirish ----------------

export function DeleteConfirm({
  count,
  revokeLabel,
  onConfirm,
  onClose,
}: {
  count: number;
  /** null — tanlov yo'q (kanal/superguruhda hammada o'chadi, yoki faqat o'zimizda) */
  revokeLabel: string | null;
  onConfirm: (revoke: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [revoke, setRevoke] = useState(true);
  return (
    <TgModal onClose={onClose} label={t('tg.deleteTitle', { count })}>
      <div className="px-6 pb-2 pt-5">
        <h2 className="text-xl font-medium">{t('tg.deleteTitle', { count })}</h2>
        <p className="mt-3 text-[15px]">{t('tg.deleteText', { count })}</p>
        {revokeLabel && (
          <label className="mt-4 flex cursor-pointer items-center gap-3 text-[15px]">
            <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} className="h-[18px] w-[18px] cursor-pointer accent-[var(--tg-primary)]" />
            {revokeLabel}
          </label>
        )}
      </div>
      <div className="flex justify-end gap-1 px-3 pb-3 pt-2">
        <TextButton onClick={onClose}>{t('common.cancel')}</TextButton>
        <TextButton
          danger
          onClick={() => {
            onConfirm(revokeLabel ? revoke : false);
            onClose();
          }}
        >
          {t('common.delete')}
        </TextButton>
      </div>
    </TgModal>
  );
}

// ---------------- Uzatish: chat tanlash ----------------

export function ForwardPicker({
  fromPeerId,
  ids,
  dialogs,
  onDone,
  onClose,
}: {
  fromPeerId: string;
  ids: number[];
  dialogs: TgDialog[];
  onDone: (toPeerId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    // Telegram kabi: tepada qadalganlar, keyin so'nggi suhbatlar; yozib bo'lmaydigan chat ko'rsatilmaydi
    return dialogs.filter((d) => d.canWrite && (!s || d.title.toLowerCase().includes(s) || (!!d.username && d.username.toLowerCase().includes(s.replace(/^@/, '')))));
  }, [dialogs, q]);

  const pick = async (to: string) => {
    if (busy) return;
    setBusy(to);
    try {
      await api.post(`/tg/dialogs/${fromPeerId}/forward`, { ids, to: [to] });
      toast.success(t('tg.forwarded', { count: ids.length }));
      onDone(to);
      onClose();
    } catch (e) {
      toast.error(errorText(e, t));
      setBusy(null);
    }
  };

  return (
    <TgModal onClose={onClose} label={t('tg.forwardTo')} className="h-[min(640px,calc(100dvh-32px))]">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h2 className="grow text-xl font-medium">{t('tg.forwardTo')}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-[var(--tg-secondary)] hover:bg-[var(--tg-hover)]">
          <X className="h-5 w-5" />
        </button>
      </div>
      <label className="mx-4 mb-2 flex h-[42px] items-center gap-3 rounded-full px-3" style={{ background: 'var(--tg-search)' }}>
        <Search className="h-5 w-5 shrink-0 text-[var(--tg-secondary)]" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('tg.search')}
          aria-label={t('tg.search')}
          className="w-full bg-transparent text-base outline-none placeholder:text-[var(--tg-secondary)] focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </label>
      <div className="tg-scroll min-h-0 grow overflow-y-auto px-2 pb-2">
        {!list.length && <div className="py-10 text-center text-[15px] text-[var(--tg-secondary)]">{t('tg.notFound')}</div>}
        {list.map((d) => (
          <button
            key={d.peerId}
            type="button"
            onClick={() => void pick(d.peerId)}
            disabled={!!busy}
            className={cn('flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--tg-hover)]', busy === d.peerId && 'opacity-60')}
          >
            <TgAvatar peerId={d.peerId} name={d.title} photoId={d.photoId} size={46} />
            <span className="min-w-0 grow">
              <span className="block truncate text-base font-medium">{d.title || '—'}</span>
              <span className="block truncate text-sm text-[var(--tg-secondary)]">{statusText(d, t)}</span>
            </span>
          </button>
        ))}
      </div>
    </TgModal>
  );
}

// ---------------- Tarjima ----------------

export function TranslateView({ peerId, m, onClose }: { peerId: string; m: TgMessage; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const to = i18n.language.startsWith('ru') ? 'ru' : 'uz';
  const [lang, setLang] = useState<'uz' | 'ru' | 'en'>(to);
  const r = useQuery({
    queryKey: ['tg', 'translate', peerId, m.id, lang],
    queryFn: () => api.post<{ text: string; entities: TgTextEntity[] }[]>(`/tg/dialogs/${peerId}/translate`, { ids: [m.id], to: lang }),
    staleTime: Infinity,
    retry: false,
  });
  const res = r.data?.[0];
  return (
    <TgModal onClose={onClose} label={t('tg.translate')}>
      <div className="flex items-center gap-2 px-4 pb-1 pt-4">
        <h2 className="grow text-xl font-medium">{t('tg.translate')}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-[var(--tg-secondary)] hover:bg-[var(--tg-hover)]">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="tg-scroll min-h-0 grow overflow-y-auto px-6 pb-2">
        <div className="text-sm font-medium text-[var(--tg-secondary)]">{t('tg.original')}</div>
        <p className="mt-1 whitespace-pre-wrap break-words text-[15px] opacity-80">{m.text}</p>
        <div className="mt-4 flex items-center gap-1">
          {(['uz', 'ru', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={cn('cursor-pointer rounded-full px-2.5 py-0.5 text-sm font-medium transition-colors', l === lang ? 'bg-[var(--tg-primary)] text-on-brand' : 'text-[var(--tg-secondary)] hover:bg-[var(--tg-hover)]')}
            >
              {t(`tg.lang.${l}`)}
            </button>
          ))}
        </div>
        <div className="mt-2 min-h-[48px] whitespace-pre-wrap break-words text-base">
          {r.isLoading && <span className="text-[var(--tg-secondary)]">{t('common.loading')}</span>}
          {r.error && <span className="text-[var(--tg-danger)]">{errorText(r.error, t)}</span>}
          {res && <FormattedText text={res.text} entities={res.entities} linkClass="text-[var(--tg-link)]" />}
        </div>
      </div>
      <div className="flex justify-end gap-1 px-3 pb-3 pt-2">
        {res && (
          <TextButton onClick={() => void navigator.clipboard.writeText(res.text).then(() => toast.success(t('tg.copied')))}>
            <span className="inline-flex items-center gap-2">
              <Copy className="h-4 w-4" />
              {t('tg.copy')}
            </span>
          </TextButton>
        )}
        <TextButton onClick={onClose}>{t('common.close')}</TextButton>
      </div>
    </TgModal>
  );
}
