import { ChevronDown, X } from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { Popover } from './popover';

export type SelectOption = { value: string; label: string };

// WinPro trigger uslubi (my-winpro-admin/src/components/ui/select.tsx); Input bilan bir qatorda tursin deb h-10
export const triggerCls = cn(
  'flex h-10 w-full min-w-0 cursor-pointer items-center justify-between gap-1 rounded-md border border-brand-500 bg-white/80 px-3 text-left text-sm shadow-sm outline-none transition-all',
  'dark:border-brand-800 dark:bg-brand-950/20 dark:text-brand-100',
  'focus-visible:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500/20 focus-visible:ring-offset-0 dark:focus-visible:ring-brand-400/30',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

/** Tozalash belgisi: trigger tugmasi ichida, shuning uchun <button> emas (ichma-ich tugma bo'lmaydi) */
export function ClearIcon({ onClear, label }: { onClear: () => void; label: string }) {
  return (
    <span
      role="button"
      aria-label={label}
      className="flex cursor-pointer text-gray-500 hover:text-red-500"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClear();
      }}
    >
      <X className="h-4 w-4" />
    </span>
  );
}

/**
 * WinPro Select: tugma + ochiladigan ro'yxat (native <select> o'rniga).
 * clearable — qiymat "" bo'lishi mumkin bo'lgan joylar (filtr "Hammasi", "Biriktirilmagan"): bo'sh holatda placeholder,
 * tanlanganda X bilan tozalanadi. Klaviatura: ↑/↓, Enter/Space, Esc.
 */
export function Select({
  id,
  value,
  options,
  onChange,
  placeholder,
  clearable,
  disabled,
  className,
  menuClassName,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  'aria-label'?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Ro'yxat trigger kengligidan tor bo'lmaydi (matchWidth); 400px cheklovi faqat tor triggerdagi uzun matnlar uchun
  const [menuMaxW, setMenuMaxW] = useState(400);
  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = options[selectedIdx];

  const show = () => {
    setActive(selectedIdx);
    setMenuMaxW(Math.max(400, ref.current?.offsetWidth ?? 0));
    setOpen(true);
  };
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Tab') return setOpen(false);
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    if (!open) return show();
    if (e.key === 'ArrowDown') setActive((i) => (i + 1) % options.length);
    else if (e.key === 'ArrowUp') setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    else if (options[active]) pick(options[active].value);
  };

  return (
    <>
      <button
        ref={ref}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cn(triggerCls, className)}
      >
        <span className={cn('truncate', !selected && 'text-gray-500')}>{selected ? selected.label : placeholder ?? '—'}</span>
        <span className="flex shrink-0 items-center gap-1">
          {clearable && value && !disabled && <ClearIcon onClear={() => pick('')} label={t('common.clear')} />}
          <ChevronDown className={cn('h-4 w-4 opacity-70 transition-transform', open && '-rotate-180')} />
        </span>
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} matchWidth>
        <ul id={listId} role="listbox" style={{ maxWidth: menuMaxW }} className={cn('custom-scrollbar max-h-60 overflow-auto py-1 text-sm', menuClassName)}>
          {options.length === 0 && <li className="whitespace-nowrap px-3 py-2 text-gray-500">{t('common.empty')}</li>}
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              title={o.label}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
              className={cn(
                'cursor-pointer truncate whitespace-nowrap px-3 py-2.5 text-ink transition-colors',
                o.value === value ? 'bg-brand-100 dark:bg-brand-800' : i === active && 'bg-gray-100',
              )}
            >
              {o.label}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
