import { AlertTriangle, CheckCircle2, Hourglass, Timer, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BigValue, Donut, KpiCard, Legend, Pill, Segments, Tip, TopBars, pct } from '@/components/DashboardKpis';
import { CountUp } from '@/components/ui/count-up';
import { Tooltip } from '@/components/ui/tooltip';
import type { MyDay } from '@/lib/types';

/**
 * Buxgalterning "Mening kunim" tepasidagi 5 ta ko'rsatkich — rahbar dashboard kartalari uslubida.
 * Ochiq / kechikkan — barcha oylar (o'tgan oydan qolgan qarz ham, pastdagi ro'yxatlar bilan bir xil);
 * "Bugun / Shu oy bajarildi" va "O'z vaqtida" — rahbar dashboardidagi Buxgalterlar jadvali bilan bir xil
 * (shu kalendar kun/oyda buxgalterning o'zi bosgani; o'z vaqtida foizi muddatsizlarsiz).
 */
export function MyDayKpis({ d }: { d: MyDay }) {
  const { t } = useTranslation();
  const s = d.stats ?? { done: 0, doneOnTime: 0, doneNoDue: 0, doneToday: 0, open: 0, monthOpen: 0, overdue: 0 };
  const todo = d.columns?.TODO ?? [];
  const inProgress = d.columns?.IN_PROGRESS ?? [];
  const waiting = d.columns?.WAITING_CLIENT ?? [];
  const open = [...todo, ...inProgress, ...waiting];

  // 2. Kechikkan: mijozlar kesimida eng ko'p 3 tasi
  const byClient = new Map<string, number>();
  for (const x of open) if (x.overdue) byClient.set(x.clientName, (byClient.get(x.clientName) ?? 0) + 1);
  const topOverdue = [...byClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // 3. Bugun: bajarilganlar / bugun muddati tugaydigan ochiqlar
  const todayLeft = d.groups?.today?.length ?? 0;
  const todayShare = pct(s.doneToday, s.doneToday + todayLeft);

  // 4. Shu oy: bajarildi / jami (bajarildi + shu oyning ochiqlari)
  const monthTotal = s.done + s.monthOpen;
  const monthShare = pct(s.done, monthTotal);

  // 5. O'z vaqtida: rahbar jadvalidagi formula — done_at <= due_at, muddatsizlar maxrajga kirmaydi; bo'linma — o'z vaqtida / kechikib / muddatsiz
  const noDue = s.doneNoDue ?? 0;
  const withDue = s.done - noDue;
  const onTimePct = pct(s.doneOnTime, withDue);
  const late = Math.max(0, withDue - s.doneOnTime);

  const statusParts = [
    { label: t('taskStatus.TODO'), value: todo.length, dot: 'bg-gray-300' },
    { label: t('taskStatus.IN_PROGRESS'), value: inProgress.length, dot: 'bg-brand-500' },
    { label: t('taskStatus.WAITING_CLIENT'), value: waiting.length, dot: 'bg-waiting' },
  ];
  const onTimeParts = [
    { label: t('myDay.stats.onTime'), value: s.doneOnTime, dot: 'bg-done' },
    { label: t('myDay.kpi.late'), value: late, dot: 'bg-overdue' },
    { label: t('myDay.kpi.noDue'), value: noDue, dot: 'bg-gray-300' },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {/* 1. Ochiq vazifalar: holatlar bo'yicha bo'lakli chiziq */}
      <KpiCard
        title={t('myDay.stats.open')}
        pill={waiting.length ? <Pill tone="waiting" icon={Hourglass} tip={<Tip label={t('taskStatus.WAITING_CLIENT')} value={waiting.length} dot="bg-waiting" />}><CountUp value={waiting.length} /></Pill> : undefined}
      >
        <BigValue value={s.open} unit={t('dashboard.kpi.tasks')} />
        <div className="mt-auto pt-3">
          <div className="mb-2.5"><Segments parts={statusParts} total={open.length} /></div>
          <Legend items={statusParts} />
        </div>
      </KpiCard>

      {/* 2. Kechikkan: mijozlar kesimida gorizontal ustunlar */}
      <KpiCard
        title={t('myDay.stats.overdue')}
        pill={s.overdue ? <Pill tone="overdue" icon={AlertTriangle} tip={<Tip label={t('myDay.kpi.ofOpen')} value={`${s.overdue} / ${s.open}`} />}><CountUp value={pct(s.overdue, s.open)} />%</Pill> : undefined}
      >
        <BigValue value={s.overdue} unit={t('dashboard.kpi.tasks')} className={s.overdue ? 'text-overdue' : undefined} />
        {topOverdue.length ? (
          <div className="mt-auto pt-3"><TopBars items={topOverdue} total={s.overdue} /></div>
        ) : (
          <p className="mt-auto flex items-center gap-1.5 pt-3 text-xs font-medium text-done">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('dashboard.kpi.noOverdue')}
          </p>
        )}
      </KpiCard>

      {/* 3. Bugun bajarildi: donut (bajarildi / bugun qoldi) */}
      <KpiCard title={t('myDay.stats.doneToday')}>
        <BigValue value={s.doneToday} unit={t('dashboard.kpi.tasks')} className="text-done" />
        <div className="mt-auto flex items-center gap-3 pt-3">
          <Donut share={todayShare} tip={<Tip label={t('myDay.stats.doneToday')} value={`${s.doneToday} / ${s.doneToday + todayLeft}`} dot="bg-done" share={todayShare} />} />
          <div className="min-w-0 flex-1">
            <Legend
              items={[
                { label: t('dashboard.kpi.doneShort'), value: s.doneToday, dot: 'bg-done' },
                { label: t('myDay.kpi.todayLeft'), value: todayLeft, dot: 'bg-gray-200' },
              ]}
            />
          </div>
        </div>
      </KpiCard>

      {/* 4. Shu oy bajarildi: foiz pill + oqim matni + progress chiziq */}
      <KpiCard
        title={t('myDay.stats.done')}
        pill={<Pill tone="done" icon={TrendingUp} tip={<Tip label={t('dashboard.kpi.doneShort')} value={`${s.done} / ${monthTotal}`} />}><CountUp value={monthShare} />%</Pill>}
      >
        <BigValue value={s.done} unit={`/ ${monthTotal}`} />
        <p className="mt-auto pb-2.5 pt-3 text-xs text-gray-500">
          <b className="font-semibold text-gray-900">{monthTotal}</b> {t('dashboard.kpi.tasks')} → <b className="font-semibold text-gray-900">{s.done}</b> {t('dashboard.kpi.done')}
        </p>
        <Tooltip className="block" content={<Tip label={t('myDay.stats.done')} value={`${monthShare}%`} dot="bg-done" />}>
          <div className="h-2.5 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={monthShare} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-done transition-[width] duration-700" style={{ width: `${monthShare}%` }} />
          </div>
        </Tooltip>
      </KpiCard>

      {/* 5. O'z vaqtida: foiz + bo'lakli chiziq (o'z vaqtida / kechikib / muddatsiz) */}
      <KpiCard
        title={t('myDay.stats.onTime')}
        pill={s.done ? <Pill tone="brand" icon={Timer} tip={<Tip label={t('myDay.stats.onTime')} value={`${s.doneOnTime} / ${s.done}`} />}><CountUp value={s.doneOnTime} /></Pill> : undefined}
      >
        {s.done ? (
          <>
            {/* Faqat muddatsiz vazifalar bajarilgan bo'lsa foiz yo'q (rahbar jadvalida ham "—") */}
            {withDue ? <BigValue value={onTimePct} unit="%" /> : <span className="text-3xl font-semibold text-gray-400">—</span>}
            <div className="mt-auto pt-3">
              <div className="mb-2.5"><Segments parts={onTimeParts} total={s.done} /></div>
              <Legend items={onTimeParts} />
            </div>
          </>
        ) : (
          <>
            <span className="text-3xl font-semibold text-gray-400">—</span>
            <p className="mt-auto pt-3 text-xs text-gray-500">{t('myDay.kpi.noDoneYet')}</p>
          </>
        )}
      </KpiCard>
    </div>
  );
}
