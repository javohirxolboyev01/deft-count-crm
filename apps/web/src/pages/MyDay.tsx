import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MyDayKpis } from '@/components/MyDayKpis';
import { OverdueMatrix } from '@/components/OverdueMatrix';
import { TaskCard } from '@/components/TaskCard';
import { IncomingTransfers } from '@/components/TaskTransfer';
import { UrgentList } from '@/components/UrgentList';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { QueryState } from '@/components/ui/states';
import { KpiSkeleton, Skeleton } from '@/components/ui/skeleton';
import { useChangeStatus, useMarkDone } from '@/hooks/tasks';
import { useOpenTask } from '@/hooks/outlet';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import type { MyDay as MyDayData, StatRange, Task, TaskStatus } from '@/lib/types';

const COLUMNS = ['TODO', 'IN_PROGRESS', 'WAITING_CLIENT', 'DONE'] as const;
const RANGES: StatRange[] = ['week', 'month', 'quarter', 'year'];

function Group({ title, icon, tasks, tone, onOpen, onDone }: { title: string; icon: React.ReactNode; tasks?: Task[]; tone: string; onOpen: (id: number) => void; onDone: (id: number) => void }) {
  if (!tasks?.length) return null;
  return (
    <Card className={cn('border-l-4', tone)}>
      <CardHeader title={<span className="flex items-center gap-2">{icon} {title} ({tasks.length})</span>} />
      <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {tasks.map((t) => <TaskCard key={t.id} task={t} onOpen={onOpen} onDone={onDone} />)}
      </div>
    </Card>
  );
}

export default function MyDay() {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const openTask = useOpenTask();
  const done = useMarkDone();
  const changeStatus = useChangeStatus();
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Davr: "Bajarildi" ustuni va kartalari shu hafta / oy / chorak / yil boshidan (ochiq vazifalar — doim hammasi)
  const [range, setRange] = useState<StatRange>('month');
  const q = useQuery({
    queryKey: ['my-day', range],
    queryFn: () => api.get<MyDayData>(`/tasks/my-day?range=${range}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const d = q.data;
  const onDone = (id: number) => done.mutate({ taskId: id });

  return (
    <div>
      <PageHeader
        title={isLeader ? t('myDay.title') : t('myDay.myTasks')}
        breadcrumb={false}
        actions={
          <div className="inline-flex rounded-md bg-gray-100 p-0.5" role="group">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={cn(
                  'h-7 cursor-pointer rounded px-3 text-sm font-medium transition-colors',
                  range === r ? 'bg-brand-500 text-on-brand shadow-sm' : 'text-gray-500 hover:text-foreground',
                )}
              >
                {t(`myDay.period.ranges.${r}`)}
              </button>
            ))}
          </div>
        }
      />
      <QueryState
        q={q}
        skeleton={
          <div className="space-y-4">
            <KpiSkeleton />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {COLUMNS.map((col) => (
                <div key={col} className="space-y-2 rounded-md bg-white p-2">
                  <Skeleton className="m-1 h-3.5 w-1/3" />
                  {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-md" />)}
                </div>
              ))}
            </div>
          </div>
        }
      >
        {d && (
          <div className="space-y-4">
            <MyDayKpis d={d} />

            <IncomingTransfers onOpen={openTask} />

            <UrgentList tasks={d.groups?.urgent} onOpen={openTask} onDone={onDone} onStatus={changeStatus} />
            <OverdueMatrix tasks={d.groups?.overdue} onOpen={openTask} onDone={onDone} />
            {/* Shoshilinch vazifa yuqoridagi o'z blokida — Bugungida takrorlanmaydi ("Bugun qoldi" kartasi esa uni ham sanaydi) */}
            <Group title={t('myDay.today')} icon={<CalendarDays className="h-4 w-4 text-soon" />} tasks={d.groups?.today?.filter((x) => x.kind !== 'URGENT')} tone="border-l-soon" onOpen={openTask} onDone={onDone} />

            <p className="text-xs text-gray-500">{t('myDay.dragHint')}</p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {COLUMNS.map((col) => (
                <section
                  key={col}
                  aria-label={t(`taskStatus.${col}`)}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(col); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    setDragOver(null);
                    const id = Number(e.dataTransfer.getData('text/task-id'));
                    const task = Object.values(d.columns ?? {}).flat().find((x) => x.id === id);
                    if (task && task.status !== col) changeStatus(id, col as TaskStatus);
                  }}
                  className={cn('rounded-md bg-white p-2', dragOver === col && 'ring-2 ring-brand-500')}
                >
                  <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                    {t(`taskStatus.${col}`)} <span className="text-xs font-normal text-gray-500">{d.columns?.[col]?.length ?? 0}</span>
                  </h2>
                  <div className="max-h-[70vh] space-y-2 overflow-y-auto">
                    {d.columns?.[col]?.map((task) => (
                      <TaskCard key={task.id} task={task} onOpen={openTask} onDone={col !== 'DONE' ? onDone : undefined} draggable={col !== 'DONE'} />
                    ))}
                    {!d.columns?.[col]?.length && <p className="px-1 py-4 text-center text-xs text-gray-400">{t('myDay.emptyColumn')}</p>}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
