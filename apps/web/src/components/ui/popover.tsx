import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * Jadvalning yopishqoq sarlavhasi (thead) pastki cheti: trigger jadval tanasida bo'lsa. Katak sarlavha ostiga
 * kirganda panel ham uning ostiga "kirib ketadi" (sarlavha ustiga chiqmaydi).
 */
function stickyHeaderBottom(anchor: HTMLElement): number | null {
  const table = anchor.closest('table');
  if (!table?.tHead || table.tHead.contains(anchor)) return null;
  let bottom: number | null = null;
  for (const th of table.tHead.querySelectorAll('th')) bottom = Math.max(bottom ?? -Infinity, th.getBoundingClientRect().bottom);
  return bottom;
}

/** Trigger oyna yoki scroll qilinadigan ota bloklarning (jadval, modal) ko'rinadigan qismidan butunlay chiqdimi */
function outOfView(anchor: HTMLElement, a: DOMRect) {
  let top = 0;
  let left = 0;
  let bottom = window.innerHeight;
  let right = window.innerWidth;
  for (let node = anchor.parentElement; node && node !== document.body; node = node.parentElement) {
    const st = getComputedStyle(node);
    if (!/(auto|scroll|hidden|clip)/.test(st.overflowX + st.overflowY)) continue;
    const r = node.getBoundingClientRect();
    top = Math.max(top, r.top);
    left = Math.max(left, r.left);
    bottom = Math.min(bottom, r.bottom);
    right = Math.min(right, r.right);
  }
  return a.bottom <= top || a.top >= bottom || a.right <= left || a.left >= right;
}

/**
 * Trigger ostida suzuvchi panel (Select menyusi, kalendar). WinPro'da absolute bo'lgan, bu yerda body'ga portal +
 * fixed pozitsiya: jadval/modal ichidagi overflow kesib qo'ymasin. Pastda joy bo'lmasa tepaga ochiladi.
 * Tashqariga bosish yoki Esc — yopadi (Esc modalni yopmasligi uchun capture bosqichida to'xtatiladi).
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  className,
  matchWidth,
  align = 'start',
}: {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Panel kamida trigger kengligida bo'lsin (Select) */
  matchWidth?: boolean;
  align?: 'start' | 'end';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const update = () => {
      const anchor = anchorRef.current;
      const a = anchor?.getBoundingClientRect();
      if (!anchor || !a) return;
      // Scroll'da panel yopilmaydi, trigger bilan birga yuradi (faqat tashqariga bosish/Esc yopadi). Trigger ko'rinadigan
      // joydan chiqsa — vaqtincha yashiriladi (oyna chetiga yopishib, boshqa katak ustida "osilib" qolmasin), qaytsa ko'rinadi
      if (outOfView(anchor, a)) {
        el.style.visibility = 'hidden';
        return;
      }
      if (matchWidth) el.style.minWidth = `${a.width}px`;
      const h = el.offsetHeight;
      const w = el.offsetWidth;
      const below = window.innerHeight - a.bottom;
      const top = below < h + 8 && a.top > below ? a.top - h - 4 : a.bottom + 4;
      const left = align === 'end' ? a.right - w : a.left;
      const y = Math.max(4, top);
      el.style.top = `${y}px`;
      el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
      // Jadval sarlavhasi ostiga kirgan qismi kesiladi — panel sarlavha ostiga "kirib ketadi", ustiga chiqmaydi
      // (clip-path bosishni ham kesadi). Butunlay kirsa — yashiriladi
      const headerBottom = stickyHeaderBottom(anchor);
      const hidden = headerBottom !== null ? headerBottom - y : 0;
      el.style.clipPath = hidden > 0 ? `inset(${hidden}px 0 0 0)` : '';
      if (hidden >= h) {
        el.style.visibility = 'hidden';
        return;
      }
      el.style.visibility = 'visible';
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, matchWidth, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchorRef.current?.contains(target)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
      className={cn('z-[70] animate-fade-in rounded-md border border-gray-200 bg-white shadow-lg', className)}
    >
      {children}
    </div>,
    document.body,
  );
}
