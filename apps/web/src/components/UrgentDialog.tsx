import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Search, Send, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { localInputToIso, todayAtLocalInput } from '@/lib/time';
import type { AccountantOption, Client, Paged, UrgentTemplate } from '@/lib/types';
import { invalidateTasks } from '@/hooks/tasks';
import { Button } from './ui/button';
import { Dialog, isTouch } from './ui/dialog';
import { DatePicker, TimePicker } from './ui/date-picker';
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
      className="max-w-4xl"
      title={
        <span className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-light text-brand">
            <Zap className="h-5 w-5" />
          </span>
          {t('urgent.title')}
        </span>
      }
      footer={
        <div className="flex w-full flex-col-reverse items-stretch gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="hidden text-xs text-gray-500 sm:block">{t('urgent.kbdHint')}</p>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!canSubmit} loading={create.isPending} onClick={submit}>
              <Send className="mr-1.5 h-4 w-4" />
              {t('urgent.submit')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}>
        {/* Chap ustun: nima va kimga (mijoz) */}
        <div className="min-w-0 space-y-4">
          <Field label={t('urgent.client')} group>
            {client ? (
              <div className="flex items-center gap-3 rounded-lg border border-brand bg-brand-light px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-on-brand">
                  <Building2 className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground" title={client.name}>{client.name}</span>
                  <span className="block truncate text-xs text-gray-500">
                    {client.stir ?? '—'} · {client.accountantName ?? '—'}
                  </span>
                </span>
                <button className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-white/60 dark:hover:bg-white/10" onClick={() => setClient(null)}>
                  {t('common.change')}
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <Input
                    autoFocus={!isTouch()}
                    aria-label={t('urgent.client')}
                    className="pl-9"
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
                </div>
                <ul className="custom-scrollbar mt-2 max-h-56 divide-y overflow-y-auto rounded-lg border">
                  {list.map((c, i) => (
                    <li key={c.id}>
                      <button
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-50 focus:bg-gray-100 focus:outline-none',
                          i === 0 && search && 'bg-gray-50',
                        )}
                        onClick={() => setClient(c)}
                      >
                        <Building2 className="h-4 w-4 shrink-0 text-gray-400" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground" title={c.name}>{c.name}</span>
                          <span className="block truncate text-xs text-gray-500">{c.stir ?? '—'} · {c.accountantName ?? '—'}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {list.length === 0 && <li className="px-3 py-4 text-center text-xs text-gray-500">{t('common.empty')}</li>}
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
              placeholder={t('urgent.templatePlaceholder')}
              options={templates.data?.map((tpl) => ({ value: tpl.id, label: tpl.text })) ?? []}
            />
          </Field>
          <Field label={t('urgent.text')} hint={t('urgent.textHint')}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </Field>
        </div>

        {/* O'ng ustun: kim bajaradi va qachongacha */}
        <div className="min-w-0 space-y-4">
          <Field label={t('urgent.assignee')} group>
            {/* Buxgalterlar soni oshsa ro'yxat modalni cho'zmasin */}
            <div className="custom-scrollbar flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
              {suggest.data?.map((a, i) => {
                const active = assigneeId === a.id;
                return (
                  <label
                    key={a.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-gray-50',
                      active && 'border-brand bg-brand-light hover:bg-brand-light',
                    )}
                  >
                    <input type="radio" name="assignee" className="h-4 w-4 shrink-0 cursor-pointer accent-brand-500" checked={active} onChange={() => setAssigneeId(a.id)} />
                    <span
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                        active ? 'bg-brand-500 text-on-brand' : 'bg-gray-100 text-gray-600',
                      )}
                    >
                      {initials(a.fullName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{a.fullName}</span>
                      {i === 0 && <span className="block text-xs text-green-600 dark:text-green-400">{t('urgent.leastBusy')}</span>}
                    </span>
                    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs', active ? 'bg-white/70 text-brand dark:bg-white/10' : 'bg-gray-100 text-gray-500')}>
                      {t('urgent.load', { count: a.openCount })}
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>
          {/* datetime-local o'rniga: WinPro DatePicker + vaqt maydoni; holat avvalgidek 'yyyy-MM-ddTHH:mm' satri */}
          <Field label={t('urgent.due')} group>
            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
              <DatePicker value={due.slice(0, 10)} clearable={false} aria-label={t('urgent.due')} onChange={(d) => setDue(`${d}T${due.slice(11, 16) || '18:00'}`)} />
              <TimePicker value={due.slice(11, 16)} aria-label={t('urgent.due')} onChange={(v) => v && setDue(`${due.slice(0, 10)}T${v}`)} />
            </div>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
