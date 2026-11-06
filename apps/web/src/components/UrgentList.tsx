import { CheckCircle2, Play, Siren, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { taskTitle } from '@/hooks/tasks';
import { cn } from '@/lib/cn';
import { fmtShortDue } from '@/lib/time';
import type { Task, TaskStatus } from '@/lib/types';
import { Card, CardHeader } from './ui/card';

/**
 * Shoshilinch vazifalar (6.9): har biri keng qator — matn, mijoz va muddat,
 * o'ngda tezkor "Boshlash" / "Bajarildi". Muddati eng yaqini (yoki eng ko'p kechikkani) tepada.
 */
export function UrgentList({
  tasks,
  onOpen,
  onDone,
  onStatus,
}: {
  tasks?: Task[];
  onOpen: (id: number) => void;
  onDone: (id: number) => void;
  onStatus: (id: number, status: TaskStatus) => void;
}) {
  const { t, i18n } = useTranslation();
  if (!tasks?.length) return null;
  const sorted = [...tasks].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));

  return (
    <Card className="border-l-4 border-l-red-600">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Siren className="h-4 w-4 text-red-600" /> {t('myDay.urgent')} ({tasks.length})
          </span>
        }
      />
      <ul className="divide-y border-t">
        {sorted.map((task) => {
          return (
            <li key={task.id} className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-gray-50 sm:flex-row sm:items-center">
              <button type="button" onClick={() => onOpen(task.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground" title={taskTitle(task, i18n.language)}>
                    {taskTitle(task, i18n.language)}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                    <span className="truncate">{task.clientName}</span>
                    {task.dueAt && <span className={cn(task.overdue && 'font-medium text-overdue')}>· {fmtShortDue(task.dueAt)}</span>}
                    {task.createdByName && <span>· {t('myDay.urgentList.from', { name: task.createdByName })}</span>}
                    {task.status !== 'TODO' && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                          task.status === 'WAITING_CLIENT' ? 'bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400' : 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
                        )}
                      >
                        {task.timerStartedAt && <Timer className="h-3 w-3 animate-pulse" />}
                        {t(`taskStatus.${task.status}`)}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 justify-end gap-2">
                {task.status === 'TODO' && (
                  <button
                    type="button"
                    onClick={() => onStatus(task.id, 'IN_PROGRESS')}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                  >
                    <Play className="h-3 w-3" /> {t('myDay.urgentList.start')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDone(task.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-green-300 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 dark:border-green-500/40 dark:text-green-400 dark:hover:bg-green-500/10"
                >
                  <CheckCircle2 className="h-3 w-3" /> {t('task.done')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
