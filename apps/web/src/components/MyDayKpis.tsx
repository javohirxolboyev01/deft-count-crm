import { CheckCircle2, Hourglass, Timer, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BigValue, Donut, KpiCard, Legend, Pill, Segments, Tip, pct } from '@/components/DashboardKpis';
import { CountUp } from '@/components/ui/count-up';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import type { MyDay } from '@/lib/types';

/**
 * Buxgalterning "Mening kunim" tepasidagi 5 ta ko'rsatkich — rahbar dashboard kartalari uslubida.
 * Tepadagi Hafta / Oy / Chorak / Yil tugmasi bo'yicha: ochiq = muddati davr oxirigacha (qarz ham) yoki muddatsiz;
 * bajarilgan va "O'z vaqtida" — davrda o'zi bosgani, rahbar dashboardidagi Buxgalterlar jadvali bilan bir xil;
 * kechikkan — muddati o'tgan (har doim davr ichida); "Bugun" — bugungi kun.
 */
export function MyDayKpis({ d }: { d: MyDay }) {
  const { t } = useTranslation();
  const s = d.stats ?? {
    open: 0, openTodo: 0, openInProgress: 0, openWaiting: 0, overdue: 0, overdueInProgress: 0, overdueWaiting: 0,
    done: 0, doneOnTime: 0, doneLate: 0, doneNoDue: 0, doneToday: 0,
  };

  // Hamma raqam serverda tanlangan davr bo'yicha hisoblanadi (bitta qoida, /tasks/my-day):
  // ochiq = muddati davr oxirigacha yoki muddatsiz; bajarilgan = done_at davr ichida (o'zi bosgan).

  // 2. Kechikkan: muddati o'tgan barcha ochiq vazifalar + davrda kechikib bajarilganlar = 100%. "Jarayonda" /
  // "Mijozdan kutilmoqda"ga o'tkazilgani va kechikib bajarilgani yashil, "Bajarilishi kerak"da qolgani qizil
  const overdueLeft = s.overdue;
  const overdueAll = overdueLeft + s.overdueInProgress + s.overdueWaiting + s.doneLate;
  const overdueShare = pct(overdueLeft, overdueAll);
  const overdueParts = [
    { label: t('myDay.kpi.overdueLeft'), value: overdueLeft, dot: 'bg-overdue' },
    { label: t('taskStatus.IN_PROGRESS'), value: s.overdueInProgress, dot: 'bg-done/65' },
    { label: t('taskStatus.WAITING_CLIENT'), value: s.overdueWaiting, dot: 'bg-done/35' },
    { label: t('taskStatus.DONE'), value: s.doneLate, dot: 'bg-done' },
  ];

  // 3. Bugun: bajarilganlar / bugun muddati tugaydigan ochiqlar (har doim bugungi kun)
  const todayLeft = d.groups?.today?.length ?? 0;
  const todayShare = pct(s.doneToday, s.doneToday + todayLeft);

  // 4. Shu davr: bajarildi / jami (davrda bajarilgan + davrning ochiqlari)
  const monthTotal = s.done + s.open;
  const monthShare = pct(s.done, monthTotal);

  // 5. O'z vaqtida: rahbar jadvalidagi formula — done_at <= due_at, muddatsizlar maxrajga kirmaydi
  const noDue = s.doneNoDue;
  const withDue = s.done - noDue;
  const onTimePct = pct(s.doneOnTime, withDue);
  const late = s.doneLate;

  const statusParts = [
    { label: t('taskStatus.TODO'), value: s.openTodo, dot: 'bg-gray-300', text: 'text-gray-500' },
    { label: t('taskStatus.IN_PROGRESS'), value: s.openInProgress, dot: 'bg-brand-500', text: 'text-brand-500 dark:text-brand-400' },
    { label: t('taskStatus.WAITING_CLIENT'), value: s.openWaiting, dot: 'bg-waiting', text: 'text-waiting' },
  ];
  const onTimeParts = [
    { label: t('myDay.stats.onTime'), value: s.doneOnTime, dot: 'bg-done' },
    { label: t('myDay.kpi.late'), value: late, dot: 'bg-overdue' },
    { label: t('myDay.kpi.noDue'), value: noDue, dot: 'bg-gray-300' },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {/* 1. Ochiq vazifalar: holatlar bo'yicha ustunlar (tepada son, pastda nom) */}
      <KpiCard
        title={t('myDay.stats.open')}
        pill={s.openWaiting ? <Pill tone="waiting" icon={Hourglass} tip={<Tip label={t('taskStatus.WAITING_CLIENT')} value={s.openWaiting} dot="bg-waiting" />}><CountUp value={s.openWaiting} /></Pill> : undefined}
      >
        <BigValue value={s.open} unit={t('dashboard.kpi.tasks')} />
        <div className="mt-auto pt-3"><StatusColumns parts={statusParts} total={s.open} /></div>
      </KpiCard>

      {/* 2. Kechikkan: bitta umumiy chiziq — qizil qolgan kechikkan, yashil ishga olingan */}
      <KpiCard
        title={t('myDay.stats.overdue')}
        pill={overdueLeft ? <Pill tone="overdue" tip={<Tip label={t('myDay.kpi.overdueLeft')} value={`${overdueLeft} / ${overdueAll}`} />}><CountUp value={overdueShare} />%</Pill> : undefined}
      >
        <BigValue value={overdueLeft} unit={t('dashboard.kpi.tasks')} className={overdueLeft ? 'text-overdue' : undefined} />
        {overdueAll ? (
          <div className="mt-auto pt-3">
            <div className="mb-2.5"><Segments parts={overdueParts} total={overdueAll} /></div>
            <Legend items={overdueParts} />
          </div>
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

      {/* 4. Shu davr (hafta/oy/chorak/yil) bajarildi: foiz pill + oqim matni + progress chiziq */}
      <KpiCard
        title={t(`myDay.period.done.${d.range ?? 'month'}`)}
        pill={<Pill tone="done" icon={TrendingUp} tip={<Tip label={t('dashboard.kpi.doneShort')} value={`${s.done} / ${monthTotal}`} />}><CountUp value={monthShare} />%</Pill>}
      >
        <BigValue value={s.done} unit={`/ ${monthTotal}`} />
        <p className="mt-auto pb-2.5 pt-3 text-xs text-gray-500">
          <b className="font-semibold text-gray-900">{monthTotal}</b> {t('dashboard.kpi.tasks')} → <b className="font-semibold text-gray-900">{s.done}</b> {t('dashboard.kpi.done')}
        </p>
        <Tooltip className="block" content={<Tip label={t(`myDay.period.done.${d.range ?? 'month'}`)} value={`${monthShare}%`} dot="bg-done" />}>
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

/**
 * Holatlar bo'yicha yonma-yon ustunlar: tepada rangli son, o'rtada ustun (balandligi soniga mos), pastda nom.
 * Ustunlar pastki chiziq bo'yicha tekislanadi; 0 bo'lsa ham ingichka ustun qoladi (holat ko'rinib tursin).
 */
function StatusColumns({ parts, total }: { parts: { label: string; value: number; dot: string; text: string }[]; total: number }) {
  const max = Math.max(1, ...parts.map((p) => p.value));
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${parts.length}, minmax(0, 1fr))` }}>
      {parts.map((p) => (
        <Tooltip key={p.label} className="flex min-w-0 flex-col items-stretch" content={<Tip label={p.label} value={p.value} dot={p.dot} share={pct(p.value, total)} />}>
          <span className={cn('mb-1 text-center text-sm font-semibold tabular-nums', p.text)}><CountUp value={p.value} /></span>
          <span className="flex h-9 items-end">
            <span
              className={cn('block w-full rounded-md transition-[height] duration-700', p.dot)}
              style={{ height: `${Math.max(8, Math.round((p.value / max) * 36))}px` }}
            />
          </span>
          <span className="mt-1.5 text-center text-[11px] leading-tight text-gray-500">{p.label}</span>
        </Tooltip>
      ))}
    </div>
  );
}
