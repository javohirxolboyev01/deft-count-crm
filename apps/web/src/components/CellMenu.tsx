import { useRef, useState } from 'react';
import { REPORT_CELL } from '@/components/StatusBadge';
import { Popover } from '@/components/ui/popover';
import { cn } from '@/lib/cn';

export type CellValue = '1' | '0' | 'X';
const PICK: CellValue[] = ['1', '0', 'X'];

/**
 * Excel kabi katak (Hisobot topshirish va Buxgalter ishlari, V30/V31): bosilsa 1 / 0 / X menyusi, qoida to'smaydi.
 * O'ng tugma — vazifani ochish (bo'lsa). Belgilar "Hisobot topshirish" bilan bir xil (✓ ○ —).
 */
export function CellMenu({
  current,
  className,
  symbol,
  labels,
  title,
  label,
  busy,
  onPick,
  onOpenTask,
  locked,
}: {
  current: CellValue;
  /** Katak tugmasining rangi (holatiga qarab) */
  className: string;
  symbol: React.ReactNode;
  labels: Record<CellValue, string>;
  title: string;
  label: string;
  busy: boolean;
  onPick: (v: CellValue) => void;
  onOpenTask?: () => void;
  /** Tanlab bo'lmaydigan qiymatlar (ko'rinadi, lekin o'chiq) va sababi — masalan buxgalter uchun 0 / X */
  locked?: Partial<Record<CellValue, string>>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        className={cn('flex h-8 w-full items-center justify-center rounded', className, busy && 'opacity-60', open && 'relative z-[1] ring-2 ring-inset ring-brand-500')}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          if (!onOpenTask) return;
          e.preventDefault();
          onOpenTask();
        }}
      >
        {symbol}
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
        <div role="menu" className="w-44 py-1 text-sm">
          {PICK.map((v) => (
            <button
              key={v}
              role="menuitemradio"
              aria-checked={current === v}
              disabled={current !== v && !!locked?.[v]}
              title={current !== v ? locked?.[v] : undefined}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-ink hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                current === v && 'bg-brand-100 dark:bg-brand-800',
              )}
              onClick={() => {
                setOpen(false);
                if (current !== v) onPick(v);
              }}
            >
              <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded border text-xs', REPORT_CELL[v].cls)}>{REPORT_CELL[v].sym}</span>
              <span className="font-mono text-xs text-gray-500">{v}</span>
              {labels[v]}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
