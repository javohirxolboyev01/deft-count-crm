import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { localInputToIso, todayAtLocalInput } from '@/lib/time';
import type { AccountantOption, Client, Paged, UrgentTemplate } from '@/lib/types';
import { invalidateTasks } from '@/hooks/tasks';
import { Button } from './ui/button';
import { Dialog, isTouch } from './ui/dialog';
import { DatePicker } from './ui/date-picker';
import { Field, Input, Textarea } from './ui/input';
import { Select } from './ui/select';

/**
 * "+ Shoshilinch" (6.9): 10 soniyada berish uchun minimal bosish.
 * Mijoz qidiruvida Enter = birinchi natija; buxgalter = eng kam bandi oldindan tanlangan; Ctrl+Enter = yuborish.
 */
export function UrgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [client, setClient] = useState<Client | null>(null);
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [assigneeId, setAssigneeId] = useState<number | ''>('');
  const [due, setDue] = useState('');

  const general = useQuery({ queryKey: ['settings', 'general'], queryFn: () => api.get<{ taskDueTime: string }>('/settings/general'), enabled: open });
  const templates = useQuery({ queryKey: ['settings', 'templates'], queryFn: () => api.get<UrgentTemplate[]>('/settings/urgent-templates'), enabled: open });
  const suggest = useQuery({ queryKey: ['urgent-suggest'], queryFn: () => api.get<AccountantOption[]>('/tasks/urgent/suggest-assignee'), enabled: open });
  const clients = useQuery({
    queryKey: ['clients', 'urgent-search', search],
    queryFn: () => api.get<Paged<Client>>(`/clients${qs({ search, pageSize: 8 })}`),
    enabled: open && !client,
  });

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setClient(null);
    setText('');
    setTemplateId('');
    setAssigneeId('');
  }, [open]);
  useEffect(() => {
    if (open && general.data) setDue(todayAtLocalInput(general.data.taskDueTime));
  }, [open, general.data]);
  useEffect(() => {
    if (open && assigneeId === '' && suggest.data?.length) setAssigneeId(suggest.data[0].id);
  }, [open, suggest.data, assigneeId]);

  const create = useMutation({
    mutationFn: () =>
      api.post('/tasks/urgent', {
        clientId: client!.id,
        text: text.trim() || undefined,
        templateId: !text.trim() && templateId ? templateId : undefined,
        assigneeId,
        dueAt: due ? localInputToIso(due) : undefined,
      }),
    onSuccess: () => {
      invalidateTasks(qc);
      void qc.invalidateQueries({ queryKey: ['urgent-suggest'] });
      toast.success(t('urgent.created'));
      onClose();
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  const canSubmit = !!client && !!assigneeId && (!!text.trim() || !!templateId) && !create.isPending;
  const submit = () => canSubmit && create.mutate();
  const list = useMemo(() => clients.data?.items ?? [], [clients.data]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('urgent.title')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!canSubmit} onClick={submit}>{t('urgent.submit')}</Button>
        </>
      }
    >
      <div className="space-y-4" onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}>
        <Field label={t('urgent.client')} group>
          {client ? (
            <div className="flex items-center justify-between rounded-md border bg-gray-50 px-3 py-2 text-sm">
              <span><b>{client.name}</b> · {client.stir ?? '—'}</span>
              <button className="text-xs text-brand hover:underline" onClick={() => setClient(null)}>{t('common.change')}</button>
            </div>
          ) : (
            <>
              <Input
                autoFocus={!isTouch()}
                aria-label={t('urgent.client')}
                value={search}
                placeholder={t('urgent.searchClient')}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && list[0]) {
                    e.preventDefault();
                    setClient(list[0]);
                  }
                }}
              />
              <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border">
                {list.map((c) => (
                  <li key={c.id}>
                    <button className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 focus:bg-gray-100" onClick={() => setClient(c)}>
                      {c.name} <span className="text-xs text-gray-500">· {c.stir ?? '—'} · {c.accountantName ?? '—'}</span>
                    </button>
                  </li>
                ))}
                {list.length === 0 && <li className="px-3 py-2 text-xs text-gray-500">{t('common.empty')}</li>}
              </ul>
            </>
          )}
        </Field>
        <Field label={t('urgent.template')}>
          <Select
            value={templateId}
            onChange={(v) => {
              setTemplateId(v);
              const tpl = templates.data?.find((x) => x.id === v);
              if (tpl) setText(tpl.text);
            }}
            clearable
            options={templates.data?.map((tpl) => ({ value: tpl.id, label: tpl.text })) ?? []}
          />
        </Field>
        <Field label={t('urgent.text')} hint={t('urgent.textHint')}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
        </Field>
        <Field label={t('urgent.assignee')} group>
          {/* Buxgalterlar soni oshsa ro'yxat modalni cho'zmasin */}
          <div className="custom-scrollbar flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
            {suggest.data?.map((a, i) => (
              <label key={a.id} className={cn('flex cursor-pointer items-center justify-between rounded-md border px-3 py-1.5 text-sm', assigneeId === a.id && 'border-brand bg-brand-light')}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="assignee" checked={assigneeId === a.id} onChange={() => setAssigneeId(a.id)} />
                  {a.fullName} {i === 0 && <span className="text-xs text-green-700">({t('urgent.leastBusy')})</span>}
                </span>
                <span className="text-xs text-gray-500">{t('urgent.load', { count: a.openCount })}</span>
              </label>
            ))}
          </div>
        </Field>
        {/* datetime-local o'rniga: WinPro DatePicker + vaqt maydoni; holat avvalgidek 'yyyy-MM-ddTHH:mm' satri */}
        <Field label={t('urgent.due')} group>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <DatePicker value={due.slice(0, 10)} clearable={false} aria-label={t('urgent.due')} onChange={(d) => setDue(`${d}T${due.slice(11, 16) || '18:00'}`)} />
            <Input type="time" value={due.slice(11, 16)} aria-label={t('urgent.due')} onChange={(e) => e.target.value && setDue(`${due.slice(0, 10)}T${e.target.value}`)} />
          </div>
        </Field>
        <p className="text-xs text-gray-500">{t('urgent.kbdHint')}</p>
      </div>
    </Dialog>
  );
}
