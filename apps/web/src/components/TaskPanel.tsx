import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorText } from '@/lib/errors';
import { fmtDateTime, fmtDuration } from '@/lib/time';
import type { TaskDetail, TaskStatus } from '@/lib/types';
import { invalidateTasks, taskTitle, taskTone, useChangeStatus } from '@/hooks/tasks';
import { TaskStatusBadge } from './StatusBadge';
import { TransferSection } from './TaskTransfer';
import { Button } from './ui/button';
import { ConfirmDialog, Drawer } from './ui/dialog';
import { Input, Textarea } from './ui/input';
import { QueryState } from './ui/states';

/** Checklist hozircha yashirin (ishlatilmayapti); kerak bo'lsa true qilinadi — server API va ma'lumotlar joyida. */
export const SHOW_CHECKLIST = false;
/** Izoh ham hozircha yashirin; faqat "Boshqa ishlar" (erkin matn, CLAUDE.md 6.2/7) vazifasida ko'rinadi — u yerda ish matni shu maydonga yoziladi. */
const SHOW_NOTE = false;

function LiveTimer({ startedAt, base }: { startedAt: string | null; base: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [startedAt]);
  // base serverda hisoblangan (ochiq yozuv so'rov vaqtigacha); qolganini mahalliy qo'shamiz
  const [fetchedAt] = useState(Date.now());
  const extra = startedAt ? Math.max(0, Math.floor((now - fetchedAt) / 1000)) : 0;
  return <span className="font-mono">{fmtDuration(base + extra)}</span>;
}

const NEXT: Record<TaskStatus, TaskStatus[]> = {
  TODO: ['IN_PROGRESS', 'WAITING_CLIENT'],
  IN_PROGRESS: ['WAITING_CLIENT', 'TODO'],
  WAITING_CLIENT: ['IN_PROGRESS', 'TODO'],
  DONE: [],
  CANCELLED: [],
};

export function TaskPanel({ taskId, onClose }: { taskId: number | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { isLeader, user } = useAuth();
  const qc = useQueryClient();
  const changeStatus = useChangeStatus();
  const q = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}`),
    enabled: taskId !== null,
  });
  const task = q.data;
  const [note, setNote] = useState('');
  const [item, setItem] = useState('');
  useEffect(() => setNote(task?.note ?? ''), [task?.id, task?.note]);

  const onErr = (e: unknown) => toast.error(errorText(e, t));
  const refresh = () => invalidateTasks(qc);
  const saveNote = useMutation({ mutationFn: () => api.patch(`/tasks/${taskId}`, { note }), onSuccess: () => { refresh(); toast.success(t('common.saved')); }, onError: onErr });
  const addItem = useMutation({ mutationFn: () => api.post(`/tasks/${taskId}/checklist`, { text: item }), onSuccess: () => { setItem(''); refresh(); }, onError: onErr });
  const toggle = useMutation({ mutationFn: (p: { id: number; done: boolean }) => api.patch(`/tasks/${taskId}/checklist/${p.id}`, { done: p.done }), onSuccess: refresh, onError: onErr });
  const [removing, setRemoving] = useState<{ id: number; text: string } | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/tasks/${taskId}/checklist/${id}`), onSuccess: () => { setRemoving(null); refresh(); }, onError: onErr });

  const tone = task ? taskTone(task) : null;
  // Qabul qiluvchi o'ziga o'tkazilayotgan vazifani faqat ko'radi va qaror qiladi (holatni o'zgartirmaydi)
  const viewOnly = !!task && !isLeader && task.assigneeId !== user?.id && task.pendingTransfer?.toUserId === user?.id;
  return (
    <Drawer open={taskId !== null} onClose={onClose} title={task ? taskTitle(task, i18n.language) : t('task.title')}>
      <QueryState q={q}>
        {task && (
          <div className="space-y-4 text-[13px]">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-gray-50 p-3">
              <dt className="text-gray-500">{t('task.client')}</dt>
              <dd>
                <Link className="text-brand hover:underline" to={`/clients/${task.clientId}`} onClick={onClose}>
                  {task.clientName}
                </Link>
              </dd>
              <dt className="text-gray-500">{t('task.kind')}</dt>
              <dd>{t(`taskKind.${task.kind}`)} · {task.period}</dd>
              <dt className="text-gray-500">{t('task.due')}</dt>
              <dd className={tone === 'overdue' ? 'font-medium text-overdue' : tone === 'soon' ? 'font-medium text-soon' : ''}>
                {task.dueAt ? fmtDateTime(task.dueAt) : t('task.noDue')}
                {tone === 'overdue' && ` · ${t('task.overdue')}`}
                {tone === 'soon' && ` · ${t('task.dueSoon')}`}
              </dd>
              <dt className="text-gray-500">{t('task.assignee')}</dt>
              <dd>{task.assigneeName ?? t('task.unassigned')}</dd>
              <dt className="text-gray-500">{t('task.status')}</dt>
              <dd><TaskStatusBadge status={task.status} /></dd>
              <dt className="text-gray-500">{t('task.spent')}</dt>
              <dd>
                <LiveTimer key={task.updatedAt} startedAt={task.timerStartedAt} base={task.spentSec} />
                {task.timerStartedAt && <span className="ml-2 text-xs text-blue-700">● {t('task.timerOn')}</span>}
              </dd>
              {task.doneAt && (
                <>
                  <dt className="text-gray-500">{t('task.doneAt')}</dt>
                  <dd>{fmtDateTime(task.doneAt)} {task.onTime === false && <span className="text-overdue">({t('task.late')})</span>}</dd>
                </>
              )}
            </dl>

            {!viewOnly && <div className="flex flex-wrap gap-1.5">
              {NEXT[task.status].map((s) => (
                <Button key={s} variant="outline" size="sm" onClick={() => changeStatus(task.id, s)}>
                  {t(`task.to.${s}`)}
                </Button>
              ))}
              {task.status !== 'DONE' && task.status !== 'CANCELLED' && (
                <Button variant="success" size="sm" onClick={() => changeStatus(task.id, 'DONE')}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t('task.done')}
                </Button>
              )}
              {task.status === 'DONE' && isLeader && (
                <Button variant="outline" size="sm" onClick={() => changeStatus(task.id, 'TODO')}>
                  {t('task.reopen')}
                </Button>
              )}
            </div>}

            <TransferSection task={task} />

            {SHOW_CHECKLIST && (
            <section>
              <h3 className="mb-1.5 text-sm font-semibold text-foreground">{t('task.checklist')} ({task.checklist.filter((c) => c.done).length}/{task.checklist.length})</h3>
              <ul className="space-y-1">
                {task.checklist.map((c) => (
                  <li key={c.id} className="group flex items-center gap-2">
                    <input type="checkbox" className="h-3.5 w-3.5 accent-brand-500" checked={c.done} onChange={(e) => toggle.mutate({ id: c.id, done: e.target.checked })} aria-label={c.text} />
                    <span className={c.done ? 'text-gray-400 line-through' : ''}>{c.text}</span>
                    <button className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setRemoving(c)} aria-label={t('common.delete')}>
                      <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-600" />
                    </button>
                  </li>
                ))}
              </ul>
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (item.trim()) addItem.mutate(); }}>
                <Input className="h-8 text-[13px]" value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('task.addItem')} />
                <Button type="submit" variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label={t('common.add')}><Plus className="h-4 w-4" /></Button>
              </form>
            </section>
            )}

            {(SHOW_NOTE || task.isFreeText) && (
            <section>
              <h3 className="mb-1.5 text-sm font-semibold text-foreground">{t('task.note')}</h3>
              {task.isFreeText && <p className="mb-2 text-xs text-gray-500">{t('task.freeTextHint')}</p>}
              <Textarea className="min-h-[64px] text-[13px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('task.notePlaceholder')} />
              <Button className="mt-2" size="sm" variant="outline" disabled={note === (task.note ?? '') || saveNote.isPending} onClick={() => saveNote.mutate()}>
                {t('common.save')}
              </Button>
            </section>
            )}

            {task.timeEntries.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-sm font-semibold text-foreground">{t('task.timeEntries')}</h3>
                <ul className="space-y-1 text-xs text-gray-600">
                  {task.timeEntries.map((e) => (
                    <li key={e.id}>
                      {e.userName}: {fmtDateTime(e.startedAt)} — {e.endedAt ? fmtDateTime(e.endedAt) : t('task.timerOn')}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.id)}
        loading={remove.isPending}
        text={removing?.text}
      />
    </Drawer>
  );
}
