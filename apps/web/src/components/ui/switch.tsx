import { cn } from '@/lib/cn';

/** Yoqish/o'chirish tugmasi (checkbox o'rniga — "ha/yo'q" sozlamalari bir qarashda ko'rinsin) */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-500' : 'bg-gray-300',
      )}
    >
      <span className={cn('inline-block h-5 w-5 rounded-full bg-on-brand shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  );
}
