import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { Button } from './button';

function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      data-close
      type="button"
      onClick={onClick}
      aria-label={label}
      className="absolute right-4 top-4 z-20 cursor-pointer rounded-md text-gray-500 transition-all hover:text-gray-700 active:scale-90"
    >
      <X className="h-6 w-6" strokeWidth={2} />
    </button>
  );
}

// Modal/Drawer ochiqligida orqa sahifa aylanmaydi (telefonda modal bilan birga siljimasin).
// Hisoblagich: Drawer ustida ConfirmDialog ochilsa ham ichkisi yopilganda qulf ochilib ketmaydi
let lockCount = 0;
function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (lockCount++ === 0) document.documentElement.style.overflow = 'hidden';
    return () => {
      if (--lockCount === 0) document.documentElement.style.overflow = '';
    };
  }, [active]);
}

// Sensorli ekranda inputga avtomatik fokus klaviaturani ochib, sahifani zoom/siljitadi
export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

/** Modal oyna (WinPro Modal ko'rinishi): Esc bilan yopiladi, fokus ichkarida boshlanadi */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // onClose odatda inline funksiya: har renderda yangilanadi. Effekt unga bog'lansa,
  // har harf yozilganda qayta ishlab fokusni birinchi inputga qaytarardi — shuning uchun ref orqali
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    setTimeout(() => {
      if (isTouch()) ref.current?.focus({ preventScroll: true });
      else ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  useBodyScrollLock(open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex animate-fade-in items-start justify-center overflow-y-auto overflow-x-hidden overscroll-contain bg-black/50 no-scrollbar p-4 sm:items-center" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn('relative w-full min-w-0 max-w-lg animate-pop-in rounded-lg bg-white p-4 outline-none sm:p-6', className)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <CloseButton onClick={onClose} label={t('common.close')} />
        <h2 className="mb-4 pr-8 text-lg font-semibold text-foreground">{title}</h2>
        <div className="no-scrollbar -mx-1 max-h-[70vh] max-h-[70dvh] overflow-y-auto overscroll-contain px-1">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * O'chirishdan oldin tasdiqlash oynasi. Body'ga portal qilinadi: jadval katagi, sticky header yoki
 * Drawer ichidan ochilsa ham hammasining ustida turadi.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  text,
  confirmLabel,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: ReactNode;
  text?: ReactNode;
  confirmLabel?: ReactNode;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? t('common.deleteTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={loading} onClick={onConfirm}>{confirmLabel ?? t('common.delete')}</Button>
        </>
      }
    >
      <p className="text-sm text-gray-600">{text ?? t('common.deleteText')}</p>
    </Dialog>,
    document.body,
  );
}

/** O'ng tomondan chiqadigan panel (vazifa tafsilotlari) */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useBodyScrollLock(open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex animate-fade-in justify-end overflow-hidden bg-black/50" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        className="flex h-full w-full max-w-[380px] animate-slide-in flex-col bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Bildirishnomalar paneli bilan bir xil sarlavha: chapda yumaloq yopish tugmasi */}
        <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-gray-200 text-gray-600 transition-all hover:bg-gray-50 hover:text-gray-900 active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">{title}</h2>
        </header>
        <div className="custom-scrollbar flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
      </aside>
    </div>
  );
}
