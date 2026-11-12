import { Clock, PhoneCall, PhoneMissed, Timer } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BigValue, Donut, KpiCard, Legend, Pill, pct, Segments, Tip } from '@/components/DashboardKpis';
import { CountUp } from '@/components/ui/count-up';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import type { CallStats, CallStatRow } from '@/lib/types';
import { fmtCallDuration } from './CallLog';

/*
 * Qo'ng'iroqlar analitikasi (rahbar, /calls/staff). Dashboard bilan bir xil qurilish bloklari (KpiCard, Pill, Donut,
 * Segments, Tooltip) va loyiha ranglari: chiquvchi — brend teal, kiruvchi — indigo, javobsiz — "kechikkan" qizili,
 * ichki — neytral kulrang (hamma grafikda bir xil). Ranglar dataviz validatoridan o'tgan (oddiy va daltonik ko'z
 * uchun ajraladi); har grafikda legenda va aniq raqamlar bor — rang yolg'iz ma'no tashimaydi.
 */

type SeriesKey = 'outgoing' | 'incomingAnswered' | 'missed' | 'internal';
const SERIES: { key: SeriesKey; dot: string }[] = [
  { key: 'outgoing', dot: 'bg-brand-500' },
  { key: 'incomingAnswered', dot: 'bg-indigo-500' },
  { key: 'missed', dot: 'bg-overdue' },
  { key: 'internal', dot: 'bg-gray-300' },
];

const parts = (r: Pick<CallStatRow, 'outgoing' | 'incoming' | 'missed' | 'internal'>): Record<SeriesKey, number> => ({
  outgoing: r.outgoing,
  incomingAnswered: r.incoming - r.missed,
  missed: r.missed,
  internal: r.internal,
});

/** 59400 s -> '16 soat 30 daq' */
function useHours() {
  const { t } = useTranslation();
  return (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h ? t('calls.viz.hm', { h, m }) : t('calls.viz.m', { m });
  };
}

type RateTone = 'done' | 'waiting' | 'overdue';
const rateTone = (p: number): RateTone => (p >= 90 ? 'done' : p >= 75 ? 'waiting' : 'overdue');
const RATE_TEXT: Record<RateTone, string> = { done: 'text-done', waiting: 'text-waiting', overdue: 'text-overdue' };
const RATE_PILL: Record<RateTone, string> = { done: 'bg-done-bg text-done', waiting: 'bg-waiting-bg text-waiting', overdue: 'bg-overdue-bg text-overdue' };

/** Oq blok (Dashboard bo'limlari kabi): sarlavha + o'ngda ixtiyoriy narsa. overflow yo'q — tooltip kesilmasin */
function Block({ title, subtitle, right, children, className }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-md bg-white p-4', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase leading-5 tracking-wide text-gray-500">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Gorizontal legenda (bloklar sarlavhasi yonida) */
function InlineLegend() {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
      {SERIES.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', s.dot)} aria-hidden />
          {t(`calls.viz.s.${s.key}`)}
        </li>
      ))}
    </ul>
  );
}

/** Kichik reyting: nom — ingichka chiziq — formatlangan qiymat (eng ko'p 3 tasi) */
function TopList({ items, dot }: { items: { name: string; value: number; label: string }[]; dot: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-1.5">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate text-gray-500" title={i.name}>{i.name}</span>
          <span className="block h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
            <span className={cn('block h-full rounded-full transition-[width] duration-700', dot)} style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-gray-900">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** 'Mustofaqulov Hoshim' -> 'Mustofaqulov H.' (kartalarda joy tor) */
const shortName = (full: string | null) => {
  if (!full) return '—';
  const [a, b] = full.split(/\s+/);
  return b ? `${a} ${b[0]}.` : a!;
};

// ---------- 1. KPI kartalar ----------

function Kpis({ stats }: { stats: CallStats }) {
  const { t } = useTranslation();
  const hours = useHours();
  const rows = stats.rows;
  const sum = (k: 'total' | 'outgoing' | 'incoming' | 'missed' | 'internal' | 'answered' | 'talkSec') => rows.reduce((a, r) => a + r[k], 0);
  const total = sum('total');
  const talk = sum('talkSec');
  const incoming = sum('incoming');
  const missed = sum('missed');
  const answered = sum('answered');
  const queueMissed = rows.find((r) => !r.userId)?.missed ?? 0;
  const p = parts({ outgoing: sum('outgoing'), incoming, missed, internal: sum('internal') });
  const items = SERIES.map((s) => ({ label: t(`calls.viz.s.${s.key}`), value: p[s.key], dot: s.dot }));
  const days = stats.daily.filter((d) => d.outgoing + d.incomingAnswered + d.missed + d.internal > 0).length;
  const perDay = days ? Math.round(total / days) : 0;
  const rate = pct(incoming - missed, incoming);
  const staff = rows.filter((r) => r.userId);
  const topTalk = [...staff].sort((a, b) => b.talkSec - a.talkSec).slice(0, 3);
  const topAvg = staff
    .filter((r) => r.answered > 0)
    .map((r) => ({ r, avg: r.talkSec / r.answered }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        title={t('calls.viz.kTotal')}
        pill={perDay ? <Pill tone="brand" icon={PhoneCall} tip={<Tip label={t('calls.viz.perDay')} value={perDay} />}>~{perDay}/{t('calls.viz.dayShort')}</Pill> : undefined}
      >
        <BigValue value={total} unit={t('calls.viz.callsUnit')} />
        <div className="mt-auto pt-3">
          <div className="mb-2.5"><Segments parts={items} total={total} /></div>
          <div className="grid grid-cols-2 gap-x-4"><Legend items={items.slice(0, 2)} /><Legend items={items.slice(2)} /></div>
        </div>
      </KpiCard>

      <KpiCard
        title={t('calls.viz.kTalk')}
        pill={<Pill tone="brand" icon={Clock} tip={<Tip label={t('calls.viz.kTalkNote', { n: answered })} value={hours(talk)} />}>{answered}</Pill>}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground"><CountUp value={Math.floor(talk / 3600)} /></span>
          <span className="text-base text-gray-500">{t('calls.viz.hUnit')}</span>
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground"><CountUp value={Math.round((talk % 3600) / 60)} /></span>
          <span className="text-base text-gray-500">{t('calls.viz.mUnit')}</span>
        </div>
        <div className="mt-auto pt-3">
          <TopList dot="bg-brand-500" items={topTalk.map((r) => ({ name: shortName(r.userName), value: r.talkSec, label: fmtCallDuration(r.talkSec) }))} />
        </div>
      </KpiCard>

      <KpiCard
        title={t('calls.viz.kRate')}
        pill={missed ? <Pill tone="overdue" icon={PhoneMissed} tip={<Tip label={t('calls.viz.s.missed')} value={`${missed} / ${incoming}`} dot="bg-overdue" />}>{missed}</Pill> : undefined}
      >
        <BigValue value={rate} unit="%" className={incoming ? RATE_TEXT[rateTone(rate)] : undefined} />
        <div className="mt-auto flex items-center gap-3 pt-3">
          <Donut share={rate} tone={RATE_TEXT[rateTone(rate)]} tip={<Tip label={t('calls.viz.answeredIn')} value={`${incoming - missed} / ${incoming}`} share={rate} />} />
          <div className="min-w-0 flex-1">
            <Legend
              items={[
                { label: t('calls.viz.answeredIn'), value: incoming - missed, dot: 'bg-done' },
                { label: t('calls.viz.missedStaff'), value: missed - queueMissed, dot: 'bg-overdue' },
                { label: t('calls.viz.noOne'), value: queueMissed, dot: 'bg-gray-300' },
              ]}
            />
          </div>
        </div>
      </KpiCard>

      <KpiCard title={t('calls.viz.kAvg')} pill={<Pill tone="waiting" icon={Timer} tip={<Tip label={t('calls.viz.kAvgNote')} value={answered} />}>{t('calls.viz.longest')}</Pill>}>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">{answered ? fmtCallDuration(Math.round(talk / answered)) : '—'}</div>
        <p className="mt-0.5 text-xs text-gray-500">{t('calls.viz.kAvgNote')}</p>
        <div className="mt-auto pt-3">
          <TopList dot="bg-waiting" items={topAvg.map(({ r, avg }) => ({ name: shortName(r.userName), value: avg, label: fmtCallDuration(Math.round(avg)) }))} />
        </div>
      </KpiCard>
    </div>
  );
}

// ---------- 2. Xodimlar reytingi (jadval + chiziq) ----------

function StaffTable({ rows, onPick }: { rows: CallStatRow[]; onPick: (userId: string) => void }) {
  const { t } = useTranslation();
  const sorted = [...rows].sort((a, b) => Number(!a.userId) - Number(!b.userId) || b.total - a.total);
  const max = Math.max(1, ...sorted.map((r) => r.total));
  return (
    <section className="overflow-hidden rounded-md bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h3 className="text-xs font-semibold uppercase leading-5 tracking-wide text-gray-500">{t('calls.viz.byStaff')}</h3>
        <InlineLegend />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="table-head">
            {/* Tor ekranda ikkinchi darajali ustunlar yashiriladi — jadval yonga surilmaydi (sonlar jurnal va kartalarda bor) */}
            <tr className="whitespace-nowrap">
              <th className="px-3 py-2.5 sm:px-4">{t('calls.employee')}</th>
              <th className="hidden w-[22%] px-3 py-2.5 md:table-cell">{t('calls.viz.calls')}</th>
              <th className="px-2 py-2.5 text-right">{t('calls.total')}</th>
              <th className="hidden xl:table-cell px-2 py-2.5 text-right">{t('calls.outgoing')}</th>
              <th className="hidden xl:table-cell px-2 py-2.5 text-right">{t('calls.incoming')}</th>
              <th className="px-2 py-2.5 text-right">{t('calls.missed')}</th>
              <th className="hidden xl:table-cell px-2 py-2.5 text-right">{t('calls.internal')}</th>
              <th className="px-2 py-2.5 text-right">{t('calls.viz.rateShort')}</th>
              <th className="hidden px-2 py-2.5 text-right sm:table-cell">{t('calls.viz.talkShort')}</th>
              <th className="hidden xl:table-cell px-3 py-2.5 text-right sm:px-4">{t('calls.viz.avgShort')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const p = parts(r);
              const shown = SERIES.filter((s) => p[s.key] > 0);
              const rate = r.incoming ? pct(r.incoming - r.missed, r.incoming) : null;
              return (
                <tr
                  key={r.userId ?? 'none'}
                  className="cursor-pointer border-t border-gray-200 tabular-nums transition-colors hover:bg-gray-100"
                  onClick={() => onPick(r.userId ? String(r.userId) : 'none')}
                  title={t('calls.viz.clickHint')}
                >
                  <td className="px-3 py-2.5 sm:px-4 lg:whitespace-nowrap">
                    <span className={cn('font-medium', !r.userId && 'text-gray-500')}>{r.userName ?? t('calls.unassigned')}</span>
                    {r.ext && <span className="ml-1.5 font-mono text-xs text-gray-400">{r.ext}</span>}
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell" aria-hidden>
                    {/* Chiziq uzunligi — jami qo'ng'iroq (eng ko'pga nisbatan); bo'laklar — turlar. Aniq sonlar o'ngdagi ustunlarda */}
                    <div className="h-2.5 rounded-full bg-gray-100">
                      <div className="flex h-full gap-0.5" style={{ width: `${(r.total / max) * 100}%` }}>
                        {shown.map((s, i) => (
                          <span
                            key={s.key}
                            className={cn('h-full', s.dot, i === 0 && 'rounded-l-full', i === shown.length - 1 && 'rounded-r-full')}
                            style={{ flexGrow: p[s.key], flexBasis: 0 }}
                          />
                        ))}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-right font-semibold text-foreground">{r.total}</td>
                  <td className="hidden xl:table-cell whitespace-nowrap px-2 py-2.5 text-right">
                    {r.outgoing}
                    {r.outgoing > 0 && <span className="ml-1 text-xs text-gray-400">({r.outgoingAnswered})</span>}
                  </td>
                  <td className="hidden xl:table-cell px-2 py-2.5 text-right">{r.incoming}</td>
                  <td className={cn('px-2 py-2.5 text-right', r.missed > 0 && 'font-medium text-overdue')}>{r.missed}</td>
                  <td className="hidden xl:table-cell px-2 py-2.5 text-right">{r.internal}</td>
                  <td className="px-2 py-2.5 text-right">
                    {rate == null ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-semibold', RATE_PILL[rateTone(rate)])}>{rate}%</span>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-2.5 text-right sm:table-cell">{fmtCallDuration(r.talkSec)}</td>
                  <td className="hidden xl:table-cell whitespace-nowrap px-3 py-2.5 text-right text-gray-600 sm:px-4">{r.answered ? fmtCallDuration(Math.round(r.talkSec / r.answered)) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-gray-200 px-4 py-2 text-[11px] text-gray-400">{t('calls.viz.tableHint')}</p>
    </section>
  );
}

// ---------- 3. Kunlik dinamika (HTML ustunlar, Dashboard uslubida) ----------

function Daily({ stats }: { stats: CallStats }) {
  const { t } = useTranslation();
  const byDay = new Map(stats.daily.map((d) => [d.day, d]));
  const days: CallStats['daily'] = [];
  for (let d = DateTime.fromISO(stats.from); d <= DateTime.fromISO(stats.to) && days.length < 92; d = d.plus({ days: 1 })) {
    const k = d.toISODate()!;
    days.push(byDay.get(k) ?? { day: k, outgoing: 0, incomingAnswered: 0, missed: 0, internal: 0, talkSec: 0 });
  }
  const tot = (d: CallStats['daily'][number]) => d.outgoing + d.incomingAnswered + d.missed + d.internal;
  const maxV = Math.max(1, ...days.map(tot));
  const step = Math.ceil(days.length / 10);
  return (
    <Block title={t('calls.viz.daily')} right={<InlineLegend />} className="xl:col-span-3">
      <div className="relative h-48">
        {/* Yordamchi chiziqlar: 0, yarmi, eng ko'pi */}
        {[0, 0.5, 1].map((k) => (
          <div key={k} className="absolute inset-x-0 flex translate-y-1/2 items-center gap-2" style={{ bottom: `${k * 100}%` }}>
            <span className="w-6 text-right text-[10px] tabular-nums text-gray-400">{Math.round(maxV * k)}</span>
            <span className={cn('h-px flex-1', k === 0 ? 'bg-gray-200' : 'bg-gray-100')} />
          </div>
        ))}
        <div className="absolute inset-y-0 left-8 right-0 flex items-end gap-1">
          {days.map((d) => {
            const total = tot(d);
            return (
              <Tooltip
                key={d.day}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                content={
                  <span className="block space-y-1">
                    <span className="block font-semibold">
                      {DateTime.fromISO(d.day).toFormat('dd.MM.yyyy')}, {t(`calls.viz.dowFull.${DateTime.fromISO(d.day).weekday}`)}
                    </span>
                    {SERIES.map((s) => <Tip key={s.key} label={t(`calls.viz.s.${s.key}`)} value={d[s.key]} dot={s.dot} />)}
                    <Tip label={t('calls.total')} value={total} />
                  </span>
                }
              >
                <span className="flex w-full max-w-[22px] flex-col-reverse gap-0.5 transition-[height] duration-700" style={{ height: `${(total / maxV) * 100}%` }}>
                  {SERIES.filter((s) => d[s.key] > 0).map((s, i, arr) => (
                    <span
                      key={s.key}
                      className={cn('block w-full', s.dot, i === arr.length - 1 && 'rounded-t-[4px]')}
                      style={{ flexGrow: d[s.key], flexBasis: 0, minHeight: 2 }}
                    />
                  ))}
                </span>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div className="ml-8 mt-1.5 flex gap-1">
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 text-center text-[10px] tabular-nums text-gray-400">
            {i % step === 0 ? DateTime.fromISO(d.day).toFormat('dd.MM') : ''}
          </span>
        ))}
      </div>
    </Block>
  );
}

// ---------- 4. Hafta kuni × soat ----------

/** Brend shkalasi (sequential, bir rang): kam — fonga yaqin, ko'p — to'q. Brand qorong'i rejimda aylanmaydi — dark: bilan */
const RAMP = {
  total: [
    'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200',
    'bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-100',
    'bg-brand-200 text-brand-900 dark:bg-brand-800 dark:text-brand-50',
    'bg-brand-400 text-on-brand dark:bg-brand-600',
    'bg-brand-600 text-on-brand dark:bg-brand-400 dark:text-brand-950',
  ],
  missed: [
    'bg-red-50 text-red-800',
    'bg-red-100 text-red-800',
    'bg-red-200 text-red-900',
    'bg-red-400 text-on-brand',
    'bg-red-600 text-on-brand dark:text-[#0b0b0b]',
  ],
};

function Heatmap({ hourly }: { hourly: CallStats['hourly'] }) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<'total' | 'missed'>('total');
  const [hover, setHover] = useState<{ dow: number; hour: number } | null>(null);
  const cell = new Map(hourly.map((c) => [`${c.dow}-${c.hour}`, c]));
  const withData = hourly.filter((c) => c.total > 0).map((c) => c.hour);
  const hMin = Math.min(9, ...withData);
  const hMax = Math.max(18, ...withData);
  const hours = Array.from({ length: hMax - hMin + 1 }, (_, i) => hMin + i);
  const dows = [1, 2, 3, 4, 5, 6, ...(hourly.some((c) => c.dow === 7 && c.total > 0) ? [7] : [])];
  const max = Math.max(1, ...hourly.map((c) => c[metric]));
  const bucket = (v: number) => (v <= 0 ? -1 : Math.min(4, Math.ceil((v / max) * 5) - 1));
  const perHour = hours.map((h) => ({ h, v: dows.reduce((a, d) => a + (cell.get(`${d}-${h}`)?.[metric] ?? 0), 0) }));
  const peak = perHour.reduce((a, b) => (b.v > a.v ? b : a), { h: -1, v: 0 });
  const active = hover ? cell.get(`${hover.dow}-${hover.hour}`) : undefined;

  const toggle = (
    <div className="inline-flex rounded-md bg-gray-100 p-0.5 text-xs" role="radiogroup" aria-label={t('calls.viz.heat')}>
      {(['total', 'missed'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={metric === m}
          onClick={() => setMetric(m)}
          className={cn('rounded px-2.5 py-1 font-medium transition-colors', metric === m ? 'bg-white text-foreground shadow-sm' : 'text-gray-500 hover:text-foreground')}
        >
          {t(`calls.viz.heat_${m}`)}
        </button>
      ))}
    </div>
  );

  return (
    <Block title={t('calls.viz.heat')} subtitle={t('calls.viz.heatSub')} right={toggle} className="xl:col-span-2">
      {/* Tanlangan katak ma'lumoti (tooltip o'rniga: skroll konteyneri uni kesmasin) */}
      <p className="mb-2 h-4 truncate text-xs text-gray-600">
        {hover ? (
          <>
            <b className="font-semibold text-gray-900">{t(`calls.viz.dowFull.${hover.dow}`)}, {hover.hour}:00–{hover.hour + 1}:00</b>
            {' · '}
            {t('calls.viz.cellInfo', { total: active?.total ?? 0, missed: active?.missed ?? 0 })}
          </>
        ) : peak.v > 0 ? (
          t(metric === 'total' ? 'calls.viz.peakTotal' : 'calls.viz.peakMissed', { from: `${peak.h}:00`, to: `${peak.h + 1}:00`, n: peak.v })
        ) : null}
      </p>
      <div className="custom-scrollbar overflow-x-auto">
        <table className="w-full border-separate border-spacing-[3px] text-[11px] tabular-nums sm:border-spacing-1" onPointerLeave={() => setHover(null)}>
          <thead>
            <tr>
              <th className="w-6" />
              {hours.map((h) => <th key={h} className="min-w-[1.4rem] font-normal text-gray-400 sm:min-w-[1.75rem]">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {dows.map((d) => (
              <tr key={d}>
                <th className="pr-1 text-left font-medium text-gray-500">{t(`calls.viz.dow.${d}`)}</th>
                {hours.map((h) => {
                  const v = cell.get(`${d}-${h}`)?.[metric] ?? 0;
                  const b = bucket(v);
                  return (
                    <td
                      key={h}
                      onPointerEnter={() => setHover({ dow: d, hour: h })}
                      className={cn(
                        'h-7 rounded-md text-center font-medium transition-shadow',
                        b < 0 ? 'bg-gray-50 text-transparent' : RAMP[metric][b],
                        hover?.dow === d && hover.hour === h && 'ring-2 ring-gray-400',
                      )}
                    >
                      {v || ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-gray-400">
        <span className="mr-0.5">{t('calls.viz.less')}</span>
        {/* Faqat fon sinflari (yorug' va dark:) — shkala qorong'i rejimda ham kataklar bilan bir xil */}
        {RAMP[metric].map((c) => <span key={c} className={cn('h-2.5 w-4 rounded-sm', c.split(' ').filter((x) => /^(dark:)?bg-/.test(x)).join(' '))} aria-hidden />)}
        <span className="ml-0.5">{t('calls.viz.more')}</span>
      </div>
    </Block>
  );
}

// ---------- Hammasi ----------

export function CallAnalytics({ stats, onPick }: { stats: CallStats; onPick: (userId: string) => void }) {
  return (
    <div className="space-y-3">
      <Kpis stats={stats} />
      <StaffTable rows={stats.rows} onPick={onPick} />
      <div className="grid gap-3 xl:grid-cols-5">
        <Daily stats={stats} />
        <Heatmap hourly={stats.hourly} />
      </div>
    </div>
  );
}
