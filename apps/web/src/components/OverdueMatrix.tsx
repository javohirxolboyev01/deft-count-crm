import { DateTime } from 'luxon';
import { AlertTriangle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { taskTitle, taskTone } from '@/hooks/tasks';
import { cn } from '@/lib/cn';
import { TZ } from '@/lib/time';
import type { Task } from '@/lib/types';
import { Card, CardHeader } from './ui/card';

const TH = 'border-r border-brand-400 px-2 py-2 text-xs';
const TD = 'whitespace-nowrap border-b border-r px-2 py-1.5 text-xs';

/** Ustun kaliti: doimiy ish / hisobot turi bo'yicha; erkin (shoshilinch, qo'lda) vazifa — o'z nomi bilan */
const colKey = (t: Task) =>
  t.routineTypeId ? `R${t.routineTypeId}` : t.reportTypeId ? `P${t.reportTypeId}` : `T${t.title}`;

/** Kechikish = muddatdan beri kalendar kunlar, Asia/Tashkent (CLAUDE.md 6.7) */
const lateDays = (dueAt: string | null, today: DateTime) =>
  dueAt ? Math.max(0, Math.floor(today.diff(DateTime.fromISO(dueAt).setZone(TZ).startOf('day'), 'days').days)) : 0;

/**
 * Kechikkan vazifalar: kartalar o'rniga korxona × ish turi matritsasi (Excel jadvallari kabi).
 * Qator — korxona (eng ko'p kechikkan tepada), ustun — ish turi, katak — muddat; bosilsa vazifa ochiladi, ✓ — "Bajarildi".
 */
export function OverdueMatrix({ tasks, onOpen, onDone }: { tasks?: Task[]; onOpen: (id: number) => void; onDone: (id: number) => void }) {
  const { t, i18n } = useTranslation();
  if (!tasks?.length) return null;
  const today = DateTime.now().setZone(TZ).startOf('day');

  const cols = new Map<string, { label: string; count: number; order: number }>();
  const clients = new Map<number, { name: string; cells: Map<string, Task[]>; maxLate: number }>();
  for (const task of tasks) {
    const k = colKey(task);
    const c = cols.get(k) ?? { label: taskTitle(task, i18n.language), count: 0, order: task.kind === 'ROUTINE' ? 1 : task.kind === 'REPORT' ? 0 : 2 };
    c.count++;
    cols.set(k, c);
    const row = clients.get(task.clientId) ?? { name: task.clientName, cells: new Map(), maxLate: 0 };
    // Bir korxona+turda bir nechta oy: katakda eng eskisi (u birinchi yopilishi kerak) va "+n"
    row.cells.set(k, [...(row.cells.get(k) ?? []), task].sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')));
    row.maxLate = Math.max(row.maxLate, lateDays(task.dueAt, today));
    clients.set(task.clientId, row);
  }
  // Hisobotlar, keyin doimiy ishlar (sozlama tartibida emas — id bo'yicha barqaror), oxirida erkin vazifalar
  const colList = [...cols.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0], undefined, { numeric: true }));
  const rows = [...clients.entries()].sort((a, b) => b[1].maxLate - a[1].maxLate || b[1].cells.size - a[1].cells.size || a[1].name.localeCompare(b[1].name));

  return (
    <Card className="border-l-4 border-l-overdue">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-overdue" /> {t('myDay.overdue')} ({tasks.length})
            <span className="text-xs font-normal text-gray-500">· {t('myDay.matrix.clients', { n: rows.length })}</span>
          </span>
        }
      />
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="table-head sticky top-0 z-20">
            <tr>
              <th className={cn(TH, 'sticky left-0 z-10 min-w-56 text-left')}>{t('myDay.matrix.client')}</th>
              <th className={cn(TH, 'text-center')}>{t('myDay.matrix.late')}</th>
              {colList.map(([k, c]) => (
                <th key={k} className={cn(TH, 'max-w-28 whitespace-normal text-center font-medium leading-tight')} title={c.label}>
                  {c.label} <span className="font-normal opacity-80">({c.count})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([clientId, r]) => (
              <tr key={clientId} className="group">
                <td className={cn(TD, 'sticky left-0 z-10 max-w-72 truncate bg-white font-medium group-hover:bg-gray-50')} title={r.name}>
                  {r.name} <span className="ml-1 rounded-full bg-overdue-bg px-1.5 text-[11px] font-semibold text-overdue">{[...r.cells.values()].reduce((n, l) => n + l.length, 0)}</span>
                </td>
                <td className={cn(TD, 'text-center font-semibold text-overdue group-hover:bg-gray-50')}>{t('myDay.matrix.days', { n: r.maxLate })}</td>
                {colList.map(([k]) => {
                  const list = r.cells.get(k);
                  const task = list?.[0];
                  if (!task) return <td key={k} className={cn(TD, 'text-center text-gray-300 group-hover:bg-gray-50')}>·</td>;
                  const tone = taskTone(task);
                  return (
                    <td key={k} className={cn(TD, 'p-1 text-center', tone === 'waiting' ? 'bg-waiting-bg/60' : 'bg-overdue-bg/60')}>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => onOpen(task.id)}
                          className={cn('rounded px-1 font-medium hover:underline', tone === 'waiting' ? 'text-waiting' : 'text-overdue')}
                          title={`${taskTitle(task, i18n.language)} · ${tone === 'waiting' ? t('taskStatus.WAITING_CLIENT') : t('task.overdue')}`}
                        >
                          {task.dueAt ? DateTime.fromISO(task.dueAt).setZone(TZ).toFormat('dd.MM') : '—'}
                        </button>
                        {list.length > 1 && <span className="text-[11px] font-semibold text-overdue">+{list.length - 1}</span>}
                        <button
                          onClick={() => onDone(task.id)}
                          className="rounded border border-green-300 bg-white p-0.5 text-green-700 hover:bg-green-50"
                          title={t('task.done')}
                          aria-label={`${t('task.done')}: ${taskTitle(task, i18n.language)}, ${r.name}`}
                        >
                          <Check className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t px-3 py-2 text-xs text-gray-500">{t('myDay.matrix.hint')}</p>
    </Card>
  );
}
