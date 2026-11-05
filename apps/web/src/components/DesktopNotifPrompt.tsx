import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useDesktopPermission } from '@/lib/desktopNotify';

const SNOOZE_KEY = 'desktop-notif-prompt-snoozed-at';
/** "Keyinroq" bosilsa bir kundan keyin yana so'raladi (ruxsat berilmaguncha yoki brauzerda taqiqlanmaguncha) */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

const snoozed = () => {
  try {
    const at = Number(localStorage.getItem(SNOOZE_KEY));
    return !!at && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
};

/**
 * Kompyuter bildirishnomalarini yoqish oynasi. Faqat ruxsat hali so'ralmagan bo'lsa ("default") chiqadi:
 * berilgan yoki taqiqlangan bo'lsa ko'rsatilmaydi (taqiqni faqat brauzer sozlamasidan qaytarish mumkin — Profil'da yozilgan).
 * Ranglar: oq/gray palitrasi qorong'i rejimda o'zi aylanadi; brand esa aylanmaydi, shuning uchun `dark:` bilan.
 */
export function DesktopNotifPrompt({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const { perm, request } = useDesktopPermission();
  const [hidden, setHidden] = useState(snoozed);
  const titleId = useId();
  const allowRef = useRef<HTMLButtonElement>(null);
  const open = enabled && perm === 'default' && !hidden;

  const later = () => {
    setHidden(true);
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!open) return;
    allowRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && later();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex animate-fade-in items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[460px] animate-pop-in rounded-2xl border border-gray-200 bg-white px-6 pb-7 pt-8 text-center shadow-2xl sm:px-10"
      >
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-amber-50 ring-8 ring-amber-50/50">
          <span className="animate-bell-ring origin-top select-none text-[44px] leading-none drop-shadow-sm" aria-hidden>
            🔔
          </span>
        </div>
        <h2 id={titleId} className="text-xl font-bold text-ink sm:text-[22px]">
          {t('desktopNotif.modalTitle')}
        </h2>
        <p className="mx-auto mt-3 max-w-[360px] text-[15px] leading-relaxed text-gray-600">{t('desktopNotif.modalText')}</p>
        <div className="mt-7 flex flex-col-reverse justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={later}
            className="h-11 cursor-pointer rounded-lg bg-gray-100 px-6 text-[15px] font-medium text-gray-800 transition-[background-color,transform] hover:bg-gray-200 active:scale-95"
          >
            {t('desktopNotif.later')}
          </button>
          <button
            ref={allowRef}
            type="button"
            onClick={() => void request()}
            className="h-11 cursor-pointer rounded-lg bg-brand-500 px-6 text-[15px] font-medium text-on-brand shadow-sm transition-[background-color,transform] hover:bg-brand-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/30 active:scale-95 dark:bg-brand-600 dark:hover:bg-brand-500"
          >
            {t('desktopNotif.allow')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
