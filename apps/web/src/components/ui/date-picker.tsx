import { CalendarIcon, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { DateTime } from 'luxon';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { todayIso } from '@/lib/time';
import { Button } from './button';
import { Popover } from './popover';
import { ClearIcon, triggerCls } from './select';

// WinPro DatePicker + Calendar (my-winpro-admin/src/components/ui/date-picker, calendar.tsx) ko'rinishi.
// react-day-picker o'rniga luxon bilan: loyihada sana kutubxonasi allaqachon luxon, yangi bog'liqlik kerak emas.
// Qiymatlar native input'dagidek satr: 'yyyy-MM-dd' (DatePicker), 'yyyy-MM' (MonthPicker).

const navBtn = 'absolute h-7 w-7 bg-transparent p-0 opacity-80 hover:opacity-100';
const cellCls = 'flex items-center justify-center rounded-md text-sm transition-colors hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-900/50 dark:hover:text-brand-300';
const selectedCls = 'bg-navy font-medium text-brand-500 hover:bg-navy hover:text-brand-500 dark:hover:bg-navy dark:hover:text-brand-500';
const currentCls = 'bg-gray-200 text-gray-900';

function Header({ label, onLabel, onPrev, onNext }: { label: ReactNode; onLabel?: () => void; onPrev: () => void; onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-7 items-center justify-center">
      <Button variant="outline" className={cn(navBtn, 'left-0')} onClick={onPrev} aria-label={t('common.prev')}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {onLabel ? (
        <Button variant="ghost" className="mx-9 h-7 flex-1 truncate px-2 text-sm font-medium" onClick={onLabel}>{label}</Button>
      ) : (
        <span className="truncate text-sm font-medium">{label}</span>
      )}
      <Button variant="outline" className={cn(navBtn, 'right-0')} onClick={onNext} aria-label={t('common.next')}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** Sarlavhani bosganda 12 yillik to'r (WinPro Calendar'dagi YearGrid) */
function YearGrid({ from, value, onPick }: { from: number; value?: number; onPick: (y: number) => void }) {
  const now = DateTime.now().year;
  return (
    <div className="mt-4 grid grid-cols-4 gap-y-2">
      {Array.from({ length: 12 }, (_, i) => from + i).map((y) => (
        <button key={y} type="button" onClick={() => onPick(y)} className={cn(cellCls, 'h-7', y === value ? selectedCls : y === now && currentCls)}>
          {y}
        </button>
      ))}
    </div>
  );
}

function Calendar({ value, onPick }: { value: string; onPick: (iso: string) => void }) {
  const { t } = useTranslation();
  const months = t('months', { returnObjects: true }) as string[];
  const weekdays = t('weekdaysShort', { returnObjects: true }) as string[];
  const [cursor, setCursor] = useState(() => (value ? DateTime.fromISO(value) : DateTime.fromISO(todayIso())).startOf('month'));
  const [years, setYears] = useState<number | null>(null);
  const today = todayIso();

  const days: DateTime[] = [];
  for (let d = cursor.startOf('week'); d <= cursor.endOf('month').endOf('week'); d = d.plus({ days: 1 })) days.push(d);

  return (
    <div className="w-[248px] p-3">
      {years === null ? (
        <>
          <Header
            label={`${months[cursor.month - 1]} ${cursor.year}`}
            onLabel={() => setYears(cursor.year - 5)}
            onPrev={() => setCursor(cursor.minus({ months: 1 }))}
            onNext={() => setCursor(cursor.plus({ months: 1 }))}
          />
          <div className="mt-4 grid grid-cols-7">
            {weekdays.map((w) => <span key={w} className="flex h-8 items-center justify-center text-sm text-gray-500">{w}</span>)}
            {days.map((d) => {
              const iso = d.toISODate()!;
              const outside = d.month !== cursor.month;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => onPick(iso)}
                  className={cn(cellCls, 'size-8', iso === value ? selectedCls : iso === today && currentCls, outside && iso !== value && 'text-gray-500 opacity-50')}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <Header label={`${years} - ${years + 11}`} onLabel={() => setYears(null)} onPrev={() => setYears(years - 12)} onNext={() => setYears(years + 12)} />
          <YearGrid
            from={years}
            value={value ? DateTime.fromISO(value).year : undefined}
            onPick={(y) => {
              setCursor(cursor.set({ year: y }));
              setYears(null);
            }}
          />
        </>
      )}
    </div>
  );
}

function Trigger({
  id,
  open,
  text,
  placeholder,
  disabled,
  clearable,
  onToggle,
  onClear,
  className,
  btnRef,
  ariaLabel,
  icon: Icon = CalendarIcon,
}: {
  ariaLabel?: string;
  icon?: typeof CalendarIcon;
  id?: string;
  open: boolean;
  text: string;
  placeholder: string;
  disabled?: boolean;
  clearable?: boolean;
  onToggle: () => void;
  onClear: () => void;
  className?: string;
  btnRef: React.RefObject<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  return (
    <button ref={btnRef} id={id} type="button" aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={onToggle} className={cn(triggerCls, className)}>
      <span className={cn('truncate', !text && 'text-gray-500')}>{text || placeholder}</span>
      <span className="flex shrink-0 items-center gap-1">
        {clearable && text && !disabled && <ClearIcon onClear={onClear} label={t('common.clear')} />}
        <Icon className={cn('h-4 w-4 transition-colors', text ? 'text-brand-500 dark:text-brand-400' : 'text-gray-500')} />
      </span>
    </button>
  );
}

/** Sana tanlash: 'yyyy-MM-dd'. Ko'rinishi dd.MM.yyyy (ilovadagi fmtDate bilan bir xil) */
export function DatePicker({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  clearable = true,
  className,
  'aria-label': ariaLabel,
}: {
  'aria-label'?: string;
  id?: string;
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Trigger
        btnRef={ref}
        id={id}
        open={open}
        text={value ? DateTime.fromISO(value).toFormat('dd.MM.yyyy') : ''}
        placeholder={placeholder ?? t('common.pickDate')}
        disabled={disabled}
        clearable={clearable}
        onToggle={() => setOpen(!open)}
        onClear={() => onChange('')}
        className={className}
        ariaLabel={ariaLabel}
      />
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
        <Calendar
          value={value}
          onPick={(iso) => {
            onChange(iso);
            setOpen(false);
          }}
        />
      </Popover>
    </>
  );
}

/** Oy tanlash: 'yyyy-MM' (native type="month" o'rniga) */
export function MonthPicker({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  clearable,
  className,
  'aria-label': ariaLabel,
}: {
  'aria-label'?: string;
  id?: string;
  value: string;
  onChange: (month: string) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const months = t('months', { returnObjects: true }) as string[];
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(DateTime.now().year);
  const [years, setYears] = useState<number | null>(null);
  const [vy, vm] = value ? value.split('-').map(Number) : [];
  const nowMonth = DateTime.now().toFormat('yyyy-MM');

  const toggle = () => {
    if (!open) {
      setYear(vy || DateTime.now().year);
      setYears(null);
    }
    setOpen(!open);
  };

  return (
    <>
      <Trigger
        btnRef={ref}
        id={id}
        open={open}
        text={value ? `${months[vm - 1]} ${vy}` : ''}
        placeholder={placeholder ?? t('common.pickMonth')}
        disabled={disabled}
        clearable={clearable}
        onToggle={toggle}
        onClear={() => onChange('')}
        className={className}
        ariaLabel={ariaLabel}
      />
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
        <div className="w-[248px] p-3">
          {years === null ? (
            <>
              <Header label={year} onLabel={() => setYears(year - 5)} onPrev={() => setYear(year - 1)} onNext={() => setYear(year + 1)} />
              <div className="mt-4 grid grid-cols-3 gap-2">
                {months.map((name, i) => {
                  const m = `${year}-${String(i + 1).padStart(2, '0')}`;
                  return (
                    <button
                      key={m}
                      type="button"
                      title={name}
                      onClick={() => {
                        onChange(m);
                        setOpen(false);
                      }}
                      className={cn(cellCls, 'h-9', m === value ? selectedCls : m === nowMonth && currentCls)}
                    >
                      {name.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <Header label={`${years} - ${years + 11}`} onLabel={() => setYears(null)} onPrev={() => setYears(years - 12)} onNext={() => setYears(years + 12)} />
              <YearGrid
                from={years}
                value={vy}
                onPick={(y) => {
                  setYear(y);
                  setYears(null);
                }}
              />
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad(i * 5));

/** Vaqt ustuni: ochilganda tanlangan qiymat ko'rinadigan joyga (o'rtaga) suriladi */
function TimeColumn({ label, items, value, onPick }: { label: string; items: string[]; value: string; onPick: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-selected]');
    if (el && ref.current) ref.current.scrollTop = el.offsetTop - ref.current.clientHeight / 2 + el.clientHeight / 2;
  }, []);
  return (
    <div className="flex flex-col">
      <span className="pb-1.5 text-center text-xs font-medium text-gray-500">{label}</span>
      <div ref={ref} className="custom-scrollbar relative flex h-52 w-14 flex-col gap-1 overflow-y-auto pr-1">
        {items.map((v) => (
          <button
            key={v}
            type="button"
            data-selected={v === value || undefined}
            onClick={() => onPick(v)}
            className={cn(cellCls, 'h-8 w-full shrink-0 tabular-nums', v === value && selectedCls)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Vaqt tanlash: 'HH:mm' (native type="time" o'rniga — brauzer/OS'ga qarab AM/PM va o'z uslubida chiqardi).
 * 24 soatlik format (Asia/Tashkent). Daqiqa 5 qadam bilan; boshqa qiymat kelsa ham ro'yxatda ko'rinadi.
 */
export function TimePicker({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  'aria-label'?: string;
  id?: string;
  value: string;
  onChange: (time: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [h = '', m = ''] = value ? value.split(':') : [];
  const minutes = m && !MINUTES.includes(m) ? [...MINUTES, m].sort() : MINUTES;
  return (
    <>
      <Trigger
        btnRef={ref}
        id={id}
        open={open}
        text={value ? `${h}:${m}` : ''}
        placeholder={placeholder ?? t('common.pickTime')}
        disabled={disabled}
        onToggle={() => setOpen(!open)}
        onClear={() => onChange('')}
        className={className}
        ariaLabel={ariaLabel}
        icon={Clock}
      />
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
        <div className="flex gap-2 p-3">
          <TimeColumn label={t('common.hour')} items={HOURS} value={h} onPick={(v) => onChange(`${v}:${m || '00'}`)} />
          <div className="w-px bg-gray-200" />
          <TimeColumn
            label={t('common.minute')}
            items={minutes}
            value={m}
            onPick={(v) => {
              onChange(`${h || '00'}:${v}`);
              setOpen(false);
            }}
          />
        </div>
      </Popover>
    </>
  );
}
