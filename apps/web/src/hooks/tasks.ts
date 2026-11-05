import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import type { AccountantOption, Task, TaskStatus } from '@/lib/types';

export function invalidateTasks(qc: QueryClient) {
  for (const key of ['my-day', 'transfers', 'tasks', 'task', 'grid', 'works', 'dashboard', 'clients', 'client']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/** Vazifa nomi foydalanuvchi tilida (hisobot/doimiy ish nomlari ruschasi bazada bor) */
export function taskTitle(t: Pick<Task, 'title' | 'kind' | 'reportNameRu' | 'routineNameRu'>, lang: string) {
  if (lang === 'ru') {
    if (t.kind === 'REPORT' && t.reportNameRu) return t.reportNameRu;
    if (t.kind === 'ROUTINE' && t.routineNameRu) return t.routineNameRu;
  }
  return t.title;
}

/** Rang: yashil (bajarildi) > to'q sariq (mijozdan kutilmoqda) > qizil (muddati o'tgan) > sariq (<24 soat) */
export function taskTone(t: Pick<Task, 'status' | 'overdue' | 'dueSoon'>): 'done' | 'waiting' | 'overdue' | 'soon' | null {
  if (t.status === 'DONE') return 'done';
  if (t.status === 'WAITING_CLIENT') return 'waiting';
  if (t.overdue) return 'overdue';
  if (t.dueSoon) return 'soon';
  return null;
}

export const toneClasses = {
  done: 'border-l-done bg-done-bg/40',
  waiting: 'border-l-waiting bg-waiting-bg/50',
  overdue: 'border-l-overdue bg-overdue-bg/50',
  soon: 'border-l-soon bg-soon-bg/50',
};

/**
 * "Bajarildi" + 5 soniyalik "Bekor qilish" toast'i (CLAUDE.md 6.6).
 * Server ham 5 soniyani tekshiradi; rahbarga xabar faqat undo oynasidan keyin ketadi.
 */
export function useMarkDone() {
  const qc = useQueryClient();
  const { t, i18n } = useTranslation();
  return useMutation({
    mutationFn: ({ taskId, viaGrid }: { taskId: number; viaGrid?: boolean }) =>
      api.post<Task>(viaGrid ? `/monthly-grid/cell/${taskId}/done` : `/tasks/${taskId}/done`),
    onSuccess: (task) => {
      invalidateTasks(qc);
      toast.success(t('task.doneToast', { title: taskTitle(task, i18n.language), client: task.clientName }), {
        duration: 5000,
        action: {
          label: t('task.undo'),
          onClick: () => {
            api
              .post(`/tasks/${task.id}/undo-done`)
              .then(() => {
                invalidateTasks(qc);
                toast.info(t('task.undone'));
              })
              .catch((e) => toast.error(errorText(e, t)));
          },
        },
      });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
}

export function useChangeStatus() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const done = useMarkDone();
  const m = useMutation({
    mutationFn: ({ taskId, status }: { taskId: number; status: Exclude<TaskStatus, 'DONE' | 'CANCELLED'> }) =>
      api.patch<Task>(`/tasks/${taskId}/status`, { status }),
    onSuccess: () => invalidateTasks(qc),
    onError: (e) => toast.error(errorText(e, t)),
  });
  return (taskId: number, status: TaskStatus) =>
    status === 'DONE' ? done.mutate({ taskId }) : status !== 'CANCELLED' && m.mutate({ taskId, status });
}

export function useAccountants() {
  return useQuery({ queryKey: ['accountants'], queryFn: () => api.get<AccountantOption[]>('/users/accountants'), staleTime: 60_000 });
}
