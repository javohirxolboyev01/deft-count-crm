import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Siren, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { DashboardKpis } from '@/components/DashboardKpis';
import { ClientStatusBadge, TaskStatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { KpiSkeleton, TableSkeleton } from '@/components/ui/skeleton';
import { invalidateTasks, taskTitle, useAccountants } from '@/hooks/tasks';
import { useClientIssues, useDashboardClients } from '@/hooks/clientIssues';
import { useOpenTask } from '@/hooks/outlet';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { fmtDateTime, fmtDuration, startOfMonthIso, startOfWeekIso, todayIso } from '@/lib/time';
import type { DashboardAccountants, Task } from '@/lib/types';

type Range = 'day' | 'week' | 'month';

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full', value >= 80 ? 'bg-done' : value >= 40 ? 'bg-soon' : 'bg-overdue')} style={{ width: `${value}%` }} />
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-light text-xs font-semibold text-brand" aria-hidden>{initials}</span>;
}

/** Bo'sh holat rasmi: bo'sh planshet + yashil belgi. Ranglar palitradan: gray/green/white qorong'i rejimda o'zi aylanadi, `dark:` kerak emas */
function EmptyIllustration() {
  return (
    <svg viewBox="0 0 120 96" className="h-20 w-24" fill="none" aria-hidden="true">
      <ellipse cx="60" cy="88" rx="38" ry="5" className="fill-gray-100" />
      <rect x="30" y="14" width="56" height="70" rx="8" className="fill-white stroke-gray-200" strokeWidth="2" />
      <rect x="46" y="8" width="24" height="12" rx="4" className="fill-gray-100 stroke-gray-300" strokeWidth="2" />
      <rect x="40" y="32" width="8" height="8" rx="2" className="stroke-gray-300" strokeWidth="2" />
      <rect x="53" y="34" width="24" height="4" rx="2" className="fill-gray-200" />
      <rect x="40" y="48" width="8" height="8" rx="2" className="stroke-gray-300" strokeWidth="2" />
      <rect x="53" y="50" width="18" height="4" rx="2" className="fill-gray-200" />
      <rect x="40" y="64" width="8" height="8" rx="2" className="stroke-gray-300" strokeWidth="2" />
      <rect x="53" y="66" width="21" height="4" rx="2" className="fill-gray-200" />
      <circle cx="86" cy="72" r="14" className="fill-green-500 stroke-white" strokeWidth="3" />
      <path d="M80 72.5l4 4 8-8.5" className="stroke-on-brand" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Muddati o'tgan / shoshilinch kartalari bo'sh bo'lsa: rasm + matn (ro'yxat balandligiga yaqin) */
function CardEmpty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 pb-6 pt-2 text-center sm:px-5">
      <EmptyIllustration />
      <span className="text-sm font-medium text-gray-500">{text}</span>
    </div>
  );
}

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const openTask = useOpenTask();
  const accountants = useAccountants();
  const [range, setRange] = useState<Range>('month');
  const [clientFilter, setClientFilter] = useState<'ALL' | 'OVERDUE' | 'IN_PROGRESS' | 'READY'>('ALL');
  const from = range === 'day' ? todayIso() : range === 'week' ? startOfWeekIso() : startOfMonthIso();

  // Mijozlar bo'yicha ko'rsatkichlar belgilanadigan oy bo'yicha (rahbar qarori): noyabrda oktyabr — jadvallar bilan bir xil
  const clients = useDashboardClients();
  const accs = useQuery({
    queryKey: ['dashboard', 'accountants', from],
    queryFn: () => api.get<DashboardAccountants>(`/dashboard/accountants${qs({ from, to: todayIso() })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  // Barcha ochiq shoshilinch vazifalar (rahbar hammasini ko'radi). 'tasks' kaliti: o'chirish/holat o'zgarsa yangilanadi
  const urgent = useQuery({
    queryKey: ['tasks', 'urgent-open'],
    queryFn: () => api.get<Task[]>(`/tasks${qs({ kind: 'URGENT', status: 'OPEN' })}`),
    refetchInterval: 60_000,
  });
  // Shoshilinch vazifani kartaning o'zidan o'chirish (serverda CANCELLED / LEADER_DELETED, audit'da qoladi)
  const [deleting, setDeleting] = useState<Task | null>(null);
  const deleteTask = useMutation({
    mutationFn: (id: number) => api.del(`/tasks/${id}`),
    onSuccess: () => {
      setDeleting(null);
      toast.success(t('task.deleted'));
      invalidateTasks(qc);
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const assign = useMutation({
    mutationFn: (p: { clientId: number; accountantId: number | null }) => api.patch(`/clients/${p.clientId}`, { accountantId: p.accountantId }),
    onSuccess: () => {
      toast.success(t('dashboard.assigned'));
      invalidateTasks(qc);
      void qc.invalidateQueries({ queryKey: ['accountants'] });
      void qc.invalidateQueries({ queryKey: ['sheets', 'review'] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  const issues = useClientIssues(clients.data);
  const rows = clients.data?.clients?.filter((c) => clientFilter === 'ALL' || c.state === clientFilter) ?? [];

  return (
    <div className="space-y-4">
      <QueryState q={clients} skeleton={<KpiSkeleton />}>
        {clients.data?.summary ? <DashboardKpis data={clients.data} /> : <Empty />}
      </QueryState>

      {issues.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-l-4 border-l-amber-400 px-4 py-3 text-sm sm:px-5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="flex-1">{t('dashboard.issues', { n: issues.length })}</span>
          <Link to="/client-issues" className="font-medium text-brand-500 hover:text-ink dark:text-brand-400">{t('dashboard.incompleteOpen')}</Link>
        </Card>
      )}

      {/* Yonma-yon, teng yarmidan (telefonda ustma-ust): muddati o'tganlar va shoshilinch vazifalar */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex min-w-0 flex-col border-l-4 border-l-overdue">
          <CardHeader title={<span className="flex items-center gap-2 text-overdue"><AlertTriangle className="h-4 w-4" /> {t('dashboard.alerts')} ({clients.data?.summary?.tasksOverdue ?? 0})</span>} />
          {!clients.data?.overdueTasks.length ? (
            <CardEmpty text={t('dashboard.noOverdue')} />
          ) : (
            <ul className="max-h-72 divide-y overflow-y-auto text-sm">
              {clients.data.overdueTasks.map((o) => (
                <li key={o.id}>
                  <button className="w-full px-4 py-2 text-left transition-colors hover:bg-red-50 sm:px-5" onClick={() => openTask(o.id)}>
                    <span className="block truncate font-medium">{o.title}</span>
                    <span className="flex gap-2 text-xs text-gray-500">
                      <span className="truncate">{o.clientName}</span>
                      <span className="ml-auto shrink-0 text-overdue">{fmtDateTime(o.dueAt)}</span>
                      <span className="w-28 shrink-0 truncate text-right">{o.assigneeName ?? t('task.unassigned')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex min-w-0 flex-col border-l-4 border-l-red-500">
          <CardHeader title={<span className="flex items-center gap-2 text-red-600"><Siren className="h-4 w-4" /> {t('dashboard.urgent')} ({urgent.data?.length ?? 0})</span>} />
          <QueryState q={urgent}>
            {!urgent.data?.length ? (
              <CardEmpty text={t('dashboard.noUrgent')} />
            ) : (
              <ul className="max-h-72 divide-y overflow-y-auto text-sm">
                {urgent.data.map((u) => (
                  <li key={u.id} className="flex items-stretch transition-colors hover:bg-red-50">
                    <button className="min-w-0 flex-1 py-2 pl-4 text-left sm:pl-5" onClick={() => openTask(u.id)}>
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{u.title}</span>
                        <span className="ml-auto shrink-0"><TaskStatusBadge status={u.status} /></span>
                      </span>
                      <span className="flex gap-2 text-xs text-gray-500">
                        <span className="truncate">{u.clientName}</span>
                        <span className={cn('ml-auto shrink-0', u.overdue ? 'font-medium text-overdue' : u.dueSoon ? 'text-soon' : '')}>{u.dueAt ? fmtDateTime(u.dueAt) : '—'}</span>
                        <span className="w-28 shrink-0 truncate text-right">{u.assigneeName ?? t('task.unassigned')}</span>
                      </span>
                    </button>
                    <span className="flex shrink-0 items-center px-3 sm:pr-4">
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-red-200 bg-red-50 text-red-600 transition-colors hover:border-red-500 hover:bg-red-500 hover:text-on-brand"
                        title={t('task.delete')}
                        aria-label={t('task.delete')}
                        onClick={() => setDeleting(u)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
          <ConfirmDialog
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            onConfirm={() => deleting && deleteTask.mutate(deleting.id)}
            loading={deleteTask.isPending}
            title={t('task.deleteTitle')}
            text={deleting ? t('task.deleteText', { title: taskTitle(deleting, i18n.language), client: deleting.clientName }) : undefined}
          />
        </Card>
      </div>

      <Card>
        <CardHeader
          title={t('dashboard.accountants')}
          actions={
            <div className="flex gap-1 text-xs" role="group">
              {(['day', 'week', 'month'] as Range[]).map((r) => (
                <button
                  key={r}
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                  className={cn('cursor-pointer rounded-md px-3 py-1.5 font-medium transition-colors', range === r ? 'bg-brand-500 text-on-brand' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900')}
                >
                  {t(`dashboard.range.${r}`)}
                </button>
              ))}
            </div>
          }
        />
        <QueryState q={accs} skeleton={<TableSkeleton rows={5} cols={9} />}>
          {!accs.data?.accountants?.length ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-2.5">{t('dashboard.accountant')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.done')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.doneTodayWeekMonth')}</th>
                  <th className="px-4 py-2.5">{t('dashboard.onTime')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.overdue')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.waiting')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.openTasks')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.clients')}</th>
                  <th className="px-4 py-2.5 text-right">{t('dashboard.spent')}</th>
                </tr>
              </thead>
              <tbody>
                {accs.data?.accountants.map((a) => (
                  <tr key={a.id} className="border-t border-gray-200 transition-colors hover:bg-gray-100">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium"><div className="flex items-center gap-2.5"><Avatar name={a.fullName} />{a.fullName}</div></td>
                    <td className="px-4 py-2.5 text-right">{a.done}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-gray-500">{a.doneToday} / {a.doneWeek} / {a.doneMonth}</td>
                    <td className="w-40 px-4 py-2.5">
                      {a.onTimePercent === null ? '—' : (<div className="flex items-center gap-2"><Bar value={a.onTimePercent} /><span className="w-10 text-right text-xs">{a.onTimePercent}%</span></div>)}
                    </td>
                    <td className={cn('px-4 py-2 text-right', a.overdue > 0 && 'font-medium text-overdue')}>{a.overdue}</td>
                    <td className="px-4 py-2.5 text-right text-waiting">{a.waiting}</td>
                    <td className="px-4 py-2.5 text-right">{a.openTasks}</td>
                    <td className="px-4 py-2.5 text-right">{a.clients}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtDuration(a.spentSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </QueryState>
      </Card>

      <Card>
        <CardHeader
          title={t('dashboard.clientsTable')}
          actions={
            <Select
              className="h-8 w-auto min-w-40"
              value={clientFilter}
              onChange={(v) => setClientFilter(v as any)}
              aria-label={t('common.filter')}
              options={[
                { value: 'ALL', label: t('common.all') },
                { value: 'OVERDUE', label: t('dashboard.overdueClients') },
                { value: 'IN_PROGRESS', label: t('dashboard.inProgress') },
                { value: 'READY', label: t('dashboard.ready') },
              ]}
            />
          }
        />
        <QueryState q={clients} skeleton={<TableSkeleton rows={8} cols={5} />}>
          {rows.length === 0 ? <Empty /> : (
            <div className="max-h-[600px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 table-head">
                  <tr>
                    <th className="px-4 py-2.5">{t('clients.name')}</th>
                    <th className="px-4 py-2.5">{t('clients.status')}</th>
                    <th className="w-48 px-4 py-2.5">{t('dashboard.progress')}</th>
                    <th className="px-4 py-2.5 text-right">{t('dashboard.overdue')}</th>
                    <th className="px-4 py-2.5">{t('clients.accountant')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.clientId} className={cn('border-t border-gray-200 transition-colors hover:bg-gray-100', c.state === 'OVERDUE' && 'bg-overdue-bg/30')}>
                      <td className="px-4 py-2.5"><Link className="font-medium text-brand hover:text-ink" to={`/clients/${c.clientId}`}>{c.name}</Link> <span className="text-xs text-gray-500">{c.taxType}</span></td>
                      <td className="px-4 py-2.5"><ClientStatusBadge status={c.status} /></td>
                      <td className="px-4 py-2.5">
                        {c.percent === null ? <span className="text-xs text-gray-400">{t('dashboard.noTasks')}</span> : (
                          <div className="flex items-center gap-2"><Bar value={c.percent} /><span className="w-16 text-right text-xs">{c.done}/{c.total}</span></div>
                        )}
                      </td>
                      <td className={cn('px-4 py-2 text-right', c.overdue > 0 && 'font-medium text-overdue')}>{c.overdue}</td>
                      <td className="px-4 py-2.5">
                        <Select
                          className="h-8"
                          value={String(c.accountantId ?? '')}
                          onChange={(v) => assign.mutate({ clientId: c.clientId, accountantId: v ? Number(v) : null })}
                          aria-label={`${t('clients.accountant')}: ${c.name}`}
                          placeholder={t('clients.noAccountant')}
                          clearable
                          options={accountants.data?.map((a) => ({ value: String(a.id), label: `${a.fullName} (${a.openCount})` })) ?? []}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Card>
      <div className="text-right">
        <Link to="/audit"><Button variant="outline" size="sm">{t('dashboard.toAudit')}</Button></Link>
      </div>
    </div>
  );
}
