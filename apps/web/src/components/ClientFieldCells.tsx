import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import type { TaxType } from '@/lib/types';

/**
 * "Buxgalter ishlari" jadvalidagi mijoz maydonlari Excel'dagidek katak ichida tahrirlanadi.
 * Saqlash — mavjud PATCH /clients/:id (ruxsat serverda: buxgalterga faqat bank-klyuch, xodim soni, sana,
 * login, parol; audit_log'ga yoziladi). Matn katagi: bosish -> input, Enter/fokusdan chiqish saqlaydi, Esc bekor.
 */
export type ClientPatch = Partial<{
  stir: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  taxType: TaxType;
  status: string;
  monthlyFee: number | null;
  accountantId: number | null;
  bankKey: boolean | null;
  employeeCount: number | null;
  mehnatCheckedAt: string | null;
  mehnatLogin: string | null;
  mehnatPassword: string;
}>;

export function useClientPatch(clientId: number) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ClientPatch) => api.patch(`/clients/${clientId}`, body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      for (const key of ['works', 'grid', 'clients', 'tasks', 'sheets', 'dashboard']) void qc.invalidateQueries({ queryKey: [key] });
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
}

// Katak ichidagi boshqaruv: chegarasiz, hover/fokusda ko'rinadi (jadval Excel'dagidek tekis tursin)
const CELL_CTRL =
  'h-8 rounded border border-transparent bg-transparent px-1.5 text-xs shadow-none hover:border-brand-300 focus-visible:border-brand-500 dark:border-transparent dark:bg-transparent dark:hover:border-brand-700';

/** Matn/son katagi. parse: input matni -> saqlanadigan qiymat (undefined = noto'g'ri, saqlanmaydi) */
export function EditableTextCell<T extends string | number | null>({
  value,
  display,
  parse,
  onSave,
  readOnly,
  label,
  className,
  inputMode,
  mono,
  format,
}: {
  value: T;
  display?: string;
  parse: (raw: string) => T | undefined;
  onSave: (v: T) => void;
  readOnly?: boolean;
  label: string;
  className?: string;
  inputMode?: 'numeric' | 'text';
  mono?: boolean;
  /** Yozish paytida matnni formatlash (masalan raqam: 1500000 -> 1,500,000) */
  format?: (raw: string) => string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = display ?? (value == null ? '' : String(value));
  if (readOnly) return <span className={cn('block truncate px-1.5', mono && 'font-mono', className)}>{shown}</span>;

  const commit = () => {
    if (draft === null) return;
    const v = parse(draft);
    setDraft(null);
    if (v !== undefined && v !== value) onSave(v);
  };
  if (draft !== null) {
    return (
      <Input
        autoFocus
        className={cn('h-8 rounded px-1.5 text-xs', mono && 'font-mono', className)}
        value={draft}
        inputMode={inputMode}
        maxLength={200}
        onChange={(e) => {
          if (!format) return setDraft(e.target.value);
          // Kursor o'rni: undan oldingi raqamlar soni bo'yicha tiklanadi (ajratgich qo'shilganda sakramasin)
          const el = e.target;
          const digitsBefore = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/\D/g, '').length;
          const next = format(el.value);
          setDraft(next);
          requestAnimationFrame(() => {
            let pos = 0;
            for (let seen = 0; pos < next.length && seen < digitsBefore; pos++) if (/\d/.test(next[pos])) seen++;
            el.setSelectionRange(pos, pos);
          });
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        aria-label={label}
      />
    );
  }
  return (
    <button
      type="button"
      className={cn(CELL_CTRL, 'flex w-full min-w-0 items-center text-left', mono && 'font-mono', className)}
      onClick={() => setDraft(value == null ? '' : format ? format(String(value)) : String(value))}
      aria-label={label}
    >
      <span className="truncate">{shown}</span>
    </button>
  );
}

/** "1 000 000", "1,000,000" -> 1000000; bo'sh -> null */
export const parseIntCell = (max: number) => (raw: string) => {
  const s = raw.replace(/[\s,.]/g, '');
  if (!s) return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n <= max ? n : undefined;
};
export const parseTextCell = (raw: string) => raw.trim() || null;
/** Faqat raqamlar, mingliklar vergul bilan (jadvaldagi fmtMoney bilan bir xil: 1,500,000) */
export const formatIntCell = (raw: string) => {
  const d = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return d ? Number(d).toLocaleString('en-US') : '';
};

export function SelectCell({
  value,
  options,
  onChange,
  readOnly,
  label,
  display,
  clearable = true,
  placeholder = '',
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  readOnly?: boolean;
  label: string;
  display?: React.ReactNode;
  /** false: qiymat majburiy (soliq turi, holat) */
  clearable?: boolean;
  placeholder?: string;
}) {
  if (readOnly) return <span className="block truncate px-1.5">{display ?? options.find((o) => o.value === value)?.label ?? ''}</span>;
  return <Select className={CELL_CTRL} value={value} options={options} onChange={onChange} placeholder={placeholder} clearable={clearable} aria-label={label} />;
}

export function DateCell({ value, onChange, readOnly, label }: { value: string; onChange: (iso: string) => void; readOnly?: boolean; label: string }) {
  if (readOnly) return <span className="block px-1.5 text-center tabular-nums">{value ? value.split('-').reverse().join('.') : ''}</span>;
  return <DatePicker className={cn(CELL_CTRL, 'tabular-nums')} value={value} onChange={onChange} placeholder="" aria-label={label} />;
}

/** my.mehnat.uz paroli: ko'rsatish/nusxalash (server ochadi, audit) + katakni bosib yangi parol yozish */
export function PasswordCell({ clientId, label, hasPassword, onSave }: { clientId: number; label: string; hasPassword: boolean; onSave: (pw: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => api.post<{ password: string }>(`/clients/${clientId}/mehnat-password/reveal`),
    onSuccess: (r) => setValue(r.password),
    onError: (e) => toast.error(errorText(e, t)),
  });
  const btn = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-brand-500 disabled:opacity-40';

  if (draft !== null) {
    // Bo'sh qoldirilsa o'zgarmaydi (tasodifan o'chib ketmasin); o'chirish — mijoz kartasida
    const commit = () => {
      const v = draft.trim();
      setDraft(null);
      if (v && v !== value) {
        onSave(v);
        setValue(null);
      }
    };
    return (
      <Input
        autoFocus
        className="h-8 rounded px-1.5 font-mono text-xs"
        value={draft}
        maxLength={200}
        autoComplete="off"
        placeholder={t('works.newPassword')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        aria-label={`${label} — ${t('works.newPassword')}`}
      />
    );
  }
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={cn(CELL_CTRL, 'flex min-w-0 flex-1 items-center text-left font-mono')}
        onClick={() => setDraft(value ?? '')}
        title={t('works.editPassword')}
        aria-label={`${label} — ${t('works.editPassword')}`}
      >
        <span className="truncate">{hasPassword ? value ?? '••••••••' : ''}</span>
      </button>
      {hasPassword &&
        (value === null ? (
          <button className={btn} onClick={() => reveal.mutate()} disabled={reveal.isPending} title={t('works.showPassword')} aria-label={`${label} — ${t('works.showPassword')}`}>
            <Eye className="h-3.5 w-3.5" />
          </button>
        ) : (
          <>
            <button
              className={btn}
              onClick={() => navigator.clipboard.writeText(value).then(() => toast.success(t('works.copied')), () => undefined)}
              title={t('works.copy')}
              aria-label={`${label} — ${t('works.copy')}`}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button className={btn} onClick={() => setValue(null)} title={t('works.hidePassword')} aria-label={`${label} — ${t('works.hidePassword')}`}>
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          </>
        ))}
    </div>
  );
}
