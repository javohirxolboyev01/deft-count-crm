import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';

/**
 * Jadval ichidagi mijoz izohi (client.note): Hisobot topshirish va Oylik ishlar jadvallarida.
 * bo'sh -> input + saqlash; saqlangan -> matn + tahrirlash/o'chirish; tahrirlashda qalam saqlashga aylanadi.
 */
export function NoteCell({
  clientId,
  clientName,
  note,
  className,
  readOnly,
}: {
  clientId: number;
  clientName: string;
  note: string | null;
  className?: string;
  /** Faqat ko'rish (buxgalter Hisobot topshirish sahifasida): input va tugmalar yo'q */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Uzun matn bir qatorda "..." bilan kesiladi; to'liq matn faqat kesilganda hover'da chiqadi
  const textRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useMutation({
    // Mavjud PATCH /clients/:id: buxgalterga ham `note` ruxsat, audit_log'ga yoziladi
    mutationFn: (value: string | null) => api.patch(`/clients/${clientId}`, { note: value }),
    onSuccess: (_d, value) => {
      setConfirmDelete(false);
      setEditing(false);
      setDraft('');
      toast.success(value === null ? t('monthly.noteDeleted') : t('common.saved'));
      for (const key of ['grid', 'works', 'clients', 'sheets']) void qc.invalidateQueries({ queryKey: [key] });
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const open = !readOnly && (editing || !note);
  const value = editing ? draft : open ? draft : note ?? '';
  const submit = () => {
    const v = draft.trim();
    if (!v) return editing && note ? setConfirmDelete(true) : undefined;
    if (v === note) return setEditing(false);
    save.mutate(v);
  };
  const iconBtn =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40';

  return (
    // Ustun kengligi qat'iy: matn qancha uzun bo'lsa ham jadval kengaymaydi
    <td className={cn('w-[300px] min-w-[300px] max-w-[300px] border-b px-2 py-1', className)}>
      <div className="flex items-center gap-1">
        {open ? (
          <Input
            autoFocus={editing}
            className="h-8 flex-1 text-xs"
            placeholder={t('task.notePlaceholder')}
            value={value}
            maxLength={5000}
            disabled={save.isPending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape' && editing) setEditing(false);
            }}
            aria-label={`${clientName} — ${t('monthly.note')}`}
          />
        ) : (
          <>
            <div
              ref={textRef}
              className="min-w-0 flex-1 truncate px-1 text-xs text-gray-700"
              onMouseEnter={(e) => setHover(e.currentTarget.scrollWidth > e.currentTarget.clientWidth)}
              onMouseLeave={() => setHover(false)}
            >
              {note}
            </div>
            <Popover
              anchorRef={textRef}
              open={hover}
              onClose={() => setHover(false)}
              className="pointer-events-none max-w-sm whitespace-pre-line break-words border-0 bg-gray-900 px-3 py-2 text-xs text-white shadow-pop"
            >
              {note}
            </Popover>
          </>
        )}
        {readOnly ? null : open ? (
          <button
            className={cn(iconBtn, 'bg-brand-500 text-on-brand hover:bg-brand-600')}
            onClick={submit}
            disabled={save.isPending || (!draft.trim() && !editing)}
            title={t('common.save')}
            aria-label={`${clientName} — ${t('common.save')}`}
          >
            <Check className="h-4 w-4" />
          </button>
        ) : (
          <button
            className={cn(iconBtn, 'text-brand-500 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/40')}
            onClick={() => { setDraft(note ?? ''); setEditing(true); }}
            title={t('common.edit')}
            aria-label={`${clientName} — ${t('common.edit')}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {note && !readOnly && (
          <button
            className={cn(iconBtn, 'text-gray-500 hover:bg-overdue-bg hover:text-overdue')}
            onClick={() => setConfirmDelete(true)}
            disabled={save.isPending}
            title={t('common.delete')}
            aria-label={`${clientName} — ${t('common.delete')}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => save.mutate(null)}
        loading={save.isPending}
        title={`${clientName} — ${t('monthly.deleteNote')}`}
        text={note}
      />
    </td>
  );
}
