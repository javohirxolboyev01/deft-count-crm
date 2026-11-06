import { AlertTriangle, CheckCircle2, Hourglass, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CountUp } from '@/components/ui/count-up';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import type { DashboardClients } from '@/lib/types';

export const pct = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

/** KPI karta: kichik bosh harfli sarlavha, o'ng burchakda ixtiyoriy belgi (pill), pastda diagramma */
export function KpiCard({ title, pill, children }: { title: string; pill?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[184px] flex-col rounded-md bg-white p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase leading-5 tracking-wide text-gray-500">{title}</h3>
        {pill}
      </div>
      {children}
    </div>
  );
}

export type PillTone = 'done' | 'overdue' | 'brand' | 'waiting';
export function Pill({ tone, icon: Icon, tip, children }: { tone: PillTone; icon?: typeof CheckCircle2; tip?: ReactNode; children: ReactNode }) {
  const cls = { done: 'bg-done-bg text-done', overdue: 'bg-overdue-bg text-overdue', brand: 'bg-brand-light text-brand', waiting: 'bg-waiting-bg text-waiting' }[tone];
  const pill = (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', cls)}>
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />} {children}
    </span>
  );
  return tip ? <Tooltip content={tip}>{pill}</Tooltip> : pill;
}

/** Tooltip ichi: rangli nuqta + nom + qiymat (+ ixtiyoriy ulush) */
export function Tip({ label, value, dot, share }: { label: ReactNode; value: ReactNode; dot?: string; share?: number }) {
  return (
    <span className="flex items-center gap-2">
      {dot && <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />}
      <span className="opacity-80">{label}</span>
      <b className="font-semibold tabular-nums">{value}</b>
      {share !== undefined && <span className="tabular-nums opacity-60">· {share}%</span>}
    </span>
  );
}

export function BigValue({ value, unit, className }: { value: number; unit?: ReactNode; className?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn('text-3xl font-semibold tabular-nums tracking-tight text-foreground', className)}><CountUp value={value} /></span>
      {unit && <span className="text-base text-gray-500">{unit}</span>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; value: number; dot: string }[] }) {
  return (
    <ul className="space-y-1.5 text-xs">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', i.dot)} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-gray-500">{i.label}</span>
          <span className="font-semibold tabular-nums text-gray-900"><CountUp value={i.value} /></span>
        </li>
      ))}
    </ul>
  );
}

/** 1. Umumiy bajarilish: foiz + vazifalar oqimi + qalin progress chiziq */
function PercentCard({ s }: { s: DashboardClients['summary'] }) {
  const { t } = useTranslation();
  return (
    <KpiCard title={t('dashboard.percent')} pill={<Pill tone="brand" icon={TrendingUp} tip={<Tip label={t('dashboard.kpi.doneShort')} value={`${s.tasksDone} / ${s.tasksTotal}`} />}><CountUp value={s.percent} />%</Pill>}>
      <BigValue value={s.percent} unit="%" />
      <p className="mt-auto pb-2.5 pt-3 text-xs text-gray-500">
        <b className="font-semibold text-gray-900">{s.tasksTotal}</b> {t('dashboard.kpi.tasks')} → <b className="font-semibold text-gray-900">{s.tasksDone}</b> {t('dashboard.kpi.done')}
      </p>
      <Tooltip className="block" content={<Tip label={t('dashboard.percent')} value={`${s.percent}%`} dot="bg-brand-500" />}>
        <div className="h-2.5 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={s.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width] duration-700" style={{ width: `${s.percent}%` }} />
        </div>
      </Tooltip>
    </KpiCard>
  );
}

/** Donut: bitta ulush (0–100) iz ustida, markazda foiz; tooltip bilan */
export function Donut({ share, tip, tone = 'text-done' }: { share: number; tip: ReactNode; tone?: string }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <Tooltip className="block h-[72px] w-[72px] shrink-0" content={tip}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="14" className="stroke-gray-100" />
        {share > 0 && (
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="14" stroke="currentColor" strokeLinecap="round" className={cn('transition-[stroke-dashoffset] duration-700', tone)} strokeDasharray={c} strokeDashoffset={c * (1 - share / 100)} />
        )}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-foreground"><CountUp value={share} />%</span>
    </Tooltip>
  );
}

/** Bo'lakli chiziq: har bo'lak o'z ulushi kengligida, tooltip bilan */
export function Segments({ parts, total }: { parts: { label: string; value: number; dot: string }[]; total: number }) {
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="flex h-2.5 gap-0.5 rounded-full bg-gray-100">
      {shown.map((p, i) => (
        <Tooltip
          key={p.label}
          className={cn('block h-full transition-[width] duration-700', p.dot, i === 0 && 'rounded-l-full', i === shown.length - 1 && 'rounded-r-full')}
          style={{ width: `${pct(p.value, total)}%` }}
          content={<Tip label={p.label} value={p.value} dot={p.dot} share={pct(p.value, total)} />}
        >
          <span />
        </Tooltip>
      ))}
    </div>
  );
}

/** Gorizontal ustunlar (eng ko'p 3 tasi): nom — chiziq — son */
export function TopBars({ items, total, dot = 'bg-overdue' }: { items: [string, number][]; total: number; dot?: string }) {
  const max = Math.max(1, ...items.map(([, n]) => n));
  return (
    <ul className="space-y-1.5">
      {items.map(([name, n]) => (
        <li key={name} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 truncate text-gray-500">{name}</span>
          <Tooltip className="block flex-1" content={<Tip label={name} value={n} dot={dot} share={pct(n, total)} />}>
            <div className="h-2 overflow-hidden rounded-full bg-gray-100">
              <div className={cn('h-full rounded-full transition-[width] duration-700', dot)} style={{ width: `${(n / max) * 100}%` }} />
            </div>
          </Tooltip>
          <span className="w-5 text-right font-semibold tabular-nums text-gray-900"><CountUp value={n} /></span>
        </li>
      ))}
    </ul>
  );
}

/** 2. Tayyor mijozlar: donut (tayyor / qolgan), markazda ulush */
function ReadyCard({ s }: { s: DashboardClients['summary'] }) {
  const { t } = useTranslation();
  // Maxraj — vazifasi bor mijozlar (vazifasizlar hech qachon "tayyor" bo'lmaydi)
  const share = pct(s.ready, s.withTasks);
  return (
    <KpiCard title={t('dashboard.ready')}>
      <BigValue value={s.ready} unit={`/ ${s.withTasks}`} className="text-done" />
      <div className="mt-auto flex items-center gap-3 pt-3">
        <Donut share={share} tip={<Tip label={t('dashboard.kpi.readyShort')} value={`${s.ready} / ${s.withTasks}`} dot="bg-done" share={share} />} />
        <div className="min-w-0 flex-1">
          <Legend
            items={[
              { label: t('dashboard.kpi.readyShort'), value: s.ready, dot: 'bg-done' },
              { label: t('dashboard.kpi.rest'), value: s.withTasks - s.ready, dot: 'bg-gray-200' },
            ]}
          />
        </div>
      </div>
    </KpiCard>
  );
}

/**
 * 3. Jarayonda: jarayondagi mijozlarning tanlangan oydagi vazifalari holat bo'yicha (6.4, oqim tartibida) — har holat
 * o'z ustuni: tepada rangli son, balandligi songa mos, pastda nomi.
 * Pill — mijozdan hujjat kutilayotgan mijozlar soni (6.5, to'q sariq).
 */
function InProgressCard({ data }: { data: DashboardClients }) {
  const { t } = useTranslation();
  const list = (data.clients ?? []).filter((c) => c.state === 'IN_PROGRESS');
  const waitingClients = list.filter((c) => c.waiting > 0).length;
  const sum = (k: 'done' | 'inProgress' | 'waiting' | 'todo') => list.reduce((n, c) => n + (c[k] ?? 0), 0);
  const total = list.reduce((n, c) => n + c.total, 0);
  const parts = [
    { label: t('taskStatus.TODO'), value: sum('todo'), dot: 'bg-gray-400', text: 'text-gray-500' },
    { label: t('taskStatus.IN_PROGRESS'), value: sum('inProgress'), dot: 'bg-brand-500', text: 'text-brand-500 dark:text-brand-400' },
    { label: t('taskStatus.WAITING_CLIENT'), value: sum('waiting'), dot: 'bg-waiting', text: 'text-waiting' },
    { label: t('taskStatus.DONE'), value: sum('done'), dot: 'bg-done', text: 'text-done' },
  ];
  const max = Math.max(1, ...parts.map((p) => p.value));
  return (
    <KpiCard
      title={t('dashboard.inProgress')}
      pill={waitingClients ? <Pill tone="waiting" icon={Hourglass} tip={<Tip label={t('dashboard.waiting')} value={`${waitingClients} ${t('dashboard.kpi.clientsUnit')}`} dot="bg-waiting" />}><CountUp value={waitingClients} /></Pill> : undefined}
    >
      <BigValue value={data.summary.inProgress} unit={t('dashboard.kpi.clientsUnit')} />
      <p className="mt-0.5 text-xs text-gray-500">
        <b className="font-semibold tabular-nums text-gray-900"><CountUp value={total} /></b> {t('dashboard.kpi.tasks')}
      </p>
      <div className="mt-auto grid grid-cols-4 items-end gap-1.5 pt-3">
        {parts.map((p) => (
          <Tooltip key={p.label} className="flex min-w-0 flex-col items-center" content={<Tip label={p.label} value={p.value} dot={p.dot} share={pct(p.value, total)} />}>
            <span className={cn('mb-1 text-sm font-semibold tabular-nums', p.text)}><CountUp value={p.value} /></span>
            {/* Balandlik: 0 — ingichka iz, aks holda 10–28px songa mos */}
            <span
              className={cn('block w-full rounded-md transition-[height] duration-700', p.value ? p.dot : 'bg-gray-100')}
              style={{ height: p.value ? `${10 + (p.value / max) * 18}px` : '4px' }}
            />
            <span className="mt-1.5 w-full truncate text-center text-[10px] text-gray-500">{p.label}</span>
          </Tooltip>
        ))}
      </div>
    </KpiCard>
  );
}

/** 4. Kechikkan mijozlar: buxgalterlar kesimida gorizontal ustunlar (eng ko'p 3 tasi) */
function OverdueCard({ data }: { data: DashboardClients }) {
  const { t } = useTranslation();
  const s = data.summary;
  const by = new Map<string, number>();
  for (const c of data.clients) if (c.state === 'OVERDUE') {
    const name = c.accountantName ?? t('clients.noAccountant');
    by.set(name, (by.get(name) ?? 0) + 1);
  }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <KpiCard title={t('dashboard.overdueClients')} pill={s.overdue ? <Pill tone="overdue" icon={AlertTriangle} tip={<Tip label={t('dashboard.alerts')} value={s.tasksOverdue} />}><CountUp value={pct(s.overdue, s.withTasks)} />%</Pill> : undefined}>
      <BigValue value={s.overdue} unit={t('dashboard.kpi.clientsUnit')} className={s.overdue ? 'text-overdue' : undefined} />
      {top.length ? (
        <div className="mt-auto pt-3"><TopBars items={top} total={s.overdue} /></div>
      ) : (
        <p className="mt-auto flex items-center gap-1.5 pt-3 text-xs font-medium text-done">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('dashboard.kpi.noOverdue')}
        </p>
      )}
    </KpiCard>
  );
}

/** 5. Vazifalar (joriy oy): bajarildi / kechikkan / ochiq — bo'lakli chiziq + legenda */
function TasksCard({ s }: { s: DashboardClients['summary'] }) {
  const { t } = useTranslation();
  const open = Math.max(0, s.tasksTotal - s.tasksDone - s.tasksOverdueMonth);
  const parts = [
    { label: t('dashboard.kpi.doneShort'), value: s.tasksDone, dot: 'bg-done' },
    { label: t('dashboard.overdue'), value: s.tasksOverdueMonth, dot: 'bg-overdue' },
    { label: t('dashboard.kpi.open'), value: open, dot: 'bg-gray-300' },
  ];
  return (
    <KpiCard title={t('dashboard.tasksDone')} pill={<Pill tone="done" icon={CheckCircle2} tip={<Tip label={t('dashboard.kpi.doneShort')} value={`${s.tasksDone} / ${s.tasksTotal}`} />}><CountUp value={pct(s.tasksDone, s.tasksTotal)} />%</Pill>}>
      <BigValue value={s.tasksDone} unit={`/ ${s.tasksTotal}`} />
      <div className="mt-auto pt-3">
        <div className="mb-2.5"><Segments parts={parts} total={s.tasksTotal} /></div>
        <Legend items={parts} />
      </div>
    </KpiCard>
  );
}

/** Dashboard tepasidagi 5 ta ko'rsatkich (6.11), har biri o'z mini diagrammasi bilan */
export function DashboardKpis({ data }: { data: DashboardClients }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <PercentCard s={data.summary} />
      <ReadyCard s={data.summary} />
      <InProgressCard data={data} />
      <OverdueCard data={data} />
      <TasksCard s={data.summary} />
    </div>
  );
}
