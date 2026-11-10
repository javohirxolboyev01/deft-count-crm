import { DateTime } from 'luxon';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TZ } from '@/lib/time';

/*
 * "Server tahlili" grafiklari: SVG haqiqiy piksel kengligida chiziladi (doira/chiziq cho'zilmaydi),
 * har grafik bitta seriya — legend yo'q, sarlavha nomlaydi. Kutubxonasiz: 3 ta kichik grafik uchun yetarli.
 * `drawKey` (fetchedAt) o'zgarsa chiziq/ustunlar qayta chiziladi — "Yangilash" natijasi ko'zga ko'rinadi.
 */

export type TrendPoint = { at: string; value: number | null };
type Point = { at: string; value: number };

const H = 176;
const PAD = { top: 12, right: 10, bottom: 24, left: 44 };

/** Y o'qi uchun yaxlit yuqori chegara: 1, 2, 2.5, 5, 10 × 10^n */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const fmtAt = (at: string, period: 'short' | 'long') => DateTime.fromISO(at).setZone(TZ).toFormat(period === 'short' ? 'HH:mm' : 'dd.MM');
const fmtAtFull = (at: string, period: 'short' | 'long') =>
  DateTime.fromISO(at).setZone(TZ).toFormat(period === 'short' ? 'HH:mm' : 'dd.MM.yyyy');

const stats = (vals: number[]) =>
  vals.length
    ? { min: Math.min(...vals), max: Math.max(...vals), avg: vals.reduce((a, b) => a + b, 0) / vals.length }
    : { min: null, max: null, avg: null };

/** Davr boshiga nisbatan o'zgarish — neytral rangda (CPU o'sishi o'z-o'zidan yomon emas) */
function Delta({ first, last, title }: { first: number | undefined; last: number | undefined; title: string }) {
  if (first == null || last == null) return null;
  const diff = last - first;
  const pct = first > 0 ? (diff / first) * 100 : null;
  const flat = Math.abs(diff) < 1e-9 || (pct != null && Math.abs(pct) < 0.5);
  const Icon = flat ? Minus : diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span title={title} className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-gray-600 dark:bg-gray-800 dark:text-gray-300">
      <Icon className="h-3 w-3" />
      {flat ? '0%' : pct == null ? '—' : `${Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`}
    </span>
  );
}

function Frame({
  label,
  subtitle,
  value,
  valueLabel,
  badge,
  footer,
  children,
}: {
  label: string;
  subtitle: string;
  value: string;
  valueLabel: string;
  badge?: React.ReactNode;
  footer: { label: string; value: string }[];
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-gray-100 p-4 dark:border-gray-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{label}</h3>
          <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="whitespace-nowrap text-2xl font-semibold leading-none tabular-nums text-foreground">{value}</div>
          <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-gray-400">
            {badge}
            <span>{valueLabel}</span>
          </div>
        </div>
      </div>
      <div className="mt-3">{children}</div>
      <dl className="mt-3 grid grid-cols-3 divide-x divide-gray-100 rounded-md bg-gray-50 py-2 text-center text-xs dark:divide-gray-800 dark:bg-gray-800/40">
        {footer.map((f) => (
          <div key={f.label} className="min-w-0 px-1">
            <dt className="truncate text-gray-500">{f.label}</dt>
            <dd className="mt-0.5 truncate font-semibold tabular-nums text-foreground">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** O'q: 5 ta gorizontal chiziq (0, ¼, ½, ¾, max) — qiymatni ko'z bilan aniq o'qish uchun */
function Axes({ width, top, axis, y }: { width: number; top: number; axis: (v: number) => string; y: (v: number) => number }) {
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((k) => (
        <g key={k}>
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={y(top * k)}
            y2={y(top * k)}
            className={k === 0 ? 'stroke-gray-300 dark:stroke-gray-600' : 'stroke-gray-100 dark:stroke-gray-800'}
          />
          <text x={PAD.left - 8} y={y(top * k)} dy="0.32em" textAnchor="end" className="fill-gray-400 text-[10px] tabular-nums">
            {axis(top * k)}
          </text>
        </g>
      ))}
    </>
  );
}

function Tooltip({ left, width, title, value }: { left: number; width: number; title: string; value: string }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-[calc(100%+4px)] whitespace-nowrap rounded-md bg-navy px-2.5 py-1.5 text-xs shadow-lg dark:bg-gray-700"
      style={{ left: Math.min(Math.max(left, 64), Math.max(64, width - 64)) }}
    >
      <div className="text-[11px] text-white/70">{title}</div>
      <div className="font-semibold tabular-nums text-white">{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-gray-200 px-3 text-center text-xs text-gray-500 dark:border-gray-700" style={{ height: H }}>
      {text}
    </div>
  );
}

/** Chiziqli trend (CPU, xotira): maydon, o'rtacha chizig'i, har nuqta, krosxeyr */
export function LineTrend({
  label,
  subtitle,
  points,
  format,
  axis,
  color,
  emptyText,
  drawKey,
}: {
  label: string;
  subtitle: string;
  points: TrendPoint[];
  format: (v: number) => string;
  axis: (v: number) => string;
  color: string;
  emptyText: string;
  drawKey: string | null;
}) {
  const { t } = useTranslation();
  const gradId = useId();
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const valid = points.filter((p): p is Point => p.value != null && Number.isFinite(p.value));
  const { min, max, avg } = stats(valid.map((p) => p.value));
  const latest = valid.at(-1);
  const top = niceMax((max ?? 0) * 1.15);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const x = (i: number) => PAD.left + (valid.length <= 1 ? plotW / 2 : (i / (valid.length - 1)) * plotW);
  const y = (v: number) => baseY - (v / top) * plotH;
  const line = valid.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = valid.length > 1 ? `${line} L${x(valid.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z` : '';
  const xTicks = valid.length > 4 ? [0, Math.round((valid.length - 1) / 3), Math.round(((valid.length - 1) * 2) / 3), valid.length - 1] : valid.map((_, i) => i);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = Math.min(1, Math.max(0, (e.clientX - r.left - 8) / Math.max(1, r.width - 16)));
    setHover(valid.length <= 1 ? 0 : Math.round(rel * (valid.length - 1)));
  };
  const active = hover != null ? valid[hover] : undefined;
  const focusI = hover ?? valid.length - 1;

  return (
    <Frame
      label={label}
      subtitle={subtitle}
      value={latest ? format(latest.value) : '—'}
      valueLabel={t('server.now')}
      badge={<Delta first={valid[0]?.value} last={latest?.value} title={t('server.vsStart')} />}
      footer={[
        { label: t('server.min'), value: min != null ? format(min) : '—' },
        { label: t('server.avg'), value: avg != null ? format(avg) : '—' },
        { label: t('server.peak'), value: max != null ? format(max) : '—' },
      ]}
    >
      <div ref={boxRef} className="relative">
        {!valid.length ? (
          <Empty text={emptyText} />
        ) : (
          width > 0 && (
            <>
              <svg width={width} height={H} role="img" aria-label={`${label}: ${latest ? format(latest.value) : '—'}`} className="block select-none">
                <defs>
                  <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.25" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <Axes width={width} top={top} axis={axis} y={y} />
                {xTicks.map((i, k) => (
                  <text
                    key={i}
                    x={x(i)}
                    y={H - 6}
                    textAnchor={xTicks.length === 1 ? 'middle' : k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}
                    className="fill-gray-400 text-[10px] tabular-nums"
                  >
                    {fmtAt(valid[i]!.at, 'short')}
                  </text>
                ))}
                <g key={drawKey ?? ''}>
                  {area && <path d={area} fill={`url(#${gradId})`} className="chart-fade" />}
                  {valid.length > 1 && (
                    <path d={line} pathLength={1} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="chart-draw" />
                  )}
                  {avg != null && valid.length > 1 && (
                    <>
                      <line x1={PAD.left} x2={width - PAD.right} y1={y(avg)} y2={y(avg)} stroke={color} strokeOpacity="0.55" strokeDasharray="4 4" />
                      <text x={width - PAD.right} y={y(avg) - 4} textAnchor="end" className="fill-gray-500 text-[10px] dark:fill-gray-400">
                        {t('server.avgShort')} {format(avg)}
                      </text>
                    </>
                  )}
                  {valid.length <= 40 &&
                    valid.map((p, i) => (
                      <circle key={p.at} cx={x(i)} cy={y(p.value)} r="2.5" fill={color} className="chart-fade stroke-white dark:stroke-gray-900" strokeWidth="1" />
                    ))}
                </g>
                {active && (
                  <line x1={x(focusI)} x2={x(focusI)} y1={PAD.top} y2={baseY} className="stroke-gray-400 dark:stroke-gray-500" strokeDasharray="2 3" />
                )}
                <circle cx={x(focusI)} cy={y(valid[focusI]!.value)} r="5" fill={color} className="stroke-white dark:stroke-gray-900" strokeWidth="2" />
                <rect
                  x={PAD.left - 8}
                  y={0}
                  width={plotW + 16}
                  height={H}
                  fill="transparent"
                  className="cursor-crosshair touch-none"
                  onPointerMove={onMove}
                  onPointerDown={onMove}
                  onPointerLeave={() => setHover(null)}
                />
              </svg>
              {active && <Tooltip left={x(focusI)} width={width} title={fmtAtFull(active.at, 'short')} value={format(active.value)} />}
            </>
          )
        )}
      </div>
    </Frame>
  );
}

/**
 * Kunlik xarajat ustunlari. Railway faqat davr bo'yicha yig'ilgan summani beradi (server_cost_snapshot):
 * kun xarajati = shu kunning oxirgi namunasi − oldingi kunniki; summa kamaysa (yangi billing davri) — shu kunning o'zi.
 */
export function CostBars({
  label,
  subtitle,
  points,
  emptyText,
  drawKey,
  color,
}: {
  label: string;
  subtitle: string;
  points: { at: string; amount: number }[];
  emptyText: string;
  drawKey: string | null;
  color: string;
}) {
  const { t } = useTranslation();
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const usd = (v: number) => `$${v.toFixed(2)}`;

  const lastPerDay = new Map<string, number>();
  for (const p of points) lastPerDay.set(DateTime.fromISO(p.at).setZone(TZ).toISODate()!, p.amount);
  const dayList = [...lastPerDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const bars: Point[] = [];
  for (let i = 1; i < dayList.length; i++) {
    const [day, cur] = dayList[i]!;
    const prev = dayList[i - 1]![1];
    bars.push({ at: day, value: cur >= prev ? cur - prev : cur });
  }
  const periodTotal = dayList.at(-1)?.[1];
  const { min, max, avg } = stats(bars.map((b) => b.value));
  const top = niceMax((max ?? 0) * 1.15);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const slot = bars.length ? plotW / bars.length : 0;
  const barW = Math.max(3, Math.min(22, slot - 2));
  const cx = (i: number) => PAD.left + slot * (i + 0.5);
  const y = (v: number) => baseY - (v / top) * plotH;
  const step = Math.max(1, Math.ceil(bars.length / 5));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * bars.length);
    setHover(Math.min(bars.length - 1, Math.max(0, i)));
  };
  const active = hover != null ? bars[hover] : undefined;

  // Namunalar hali bitta kunniki — kunlik farq yo'q. Bo'sh joy o'rniga shu kun ichida davr xarajati qanday o'sganini chizamiz
  if (!bars.length && points.length) {
    return (
      <LineTrend
        label={label}
        subtitle={t('server.costCumulative')}
        points={points.map((p) => ({ at: p.at, value: p.amount }))}
        format={usd}
        axis={(v) => `$${+v.toFixed(v < 1 ? 2 : 1)}`}
        color={color}
        emptyText={emptyText}
        drawKey={drawKey}
      />
    );
  }

  return (
    <Frame
      label={label}
      subtitle={subtitle}
      value={periodTotal != null ? usd(periodTotal) : '—'}
      valueLabel={t('server.thisPeriod')}
      footer={[
        { label: t('server.minDay'), value: min != null ? usd(min) : '—' },
        { label: t('server.avgDay'), value: avg != null ? usd(avg) : '—' },
        { label: t('server.maxDay'), value: max != null ? usd(max) : '—' },
      ]}
    >
      <div ref={boxRef} className="relative">
        {!bars.length ? (
          <Empty text={emptyText} />
        ) : (
          width > 0 && (
            <>
              <svg width={width} height={H} role="img" aria-label={`${label}: ${periodTotal != null ? usd(periodTotal) : '—'}`} className="block select-none">
                <Axes width={width} top={top} axis={(v) => `$${+v.toFixed(v < 1 ? 2 : 1)}`} y={y} />
                {bars.map((b, i) =>
                  i % step === 0 || i === bars.length - 1 ? (
                    <text key={b.at} x={cx(i)} y={H - 6} textAnchor="middle" className="fill-gray-400 text-[10px] tabular-nums">
                      {fmtAt(b.at, 'long')}
                    </text>
                  ) : null,
                )}
                <g key={drawKey ?? ''}>
                  {bars.map((b, i) => {
                    const h = Math.max(b.value > 0 ? 2 : 0, baseY - y(b.value));
                    const r = Math.min(4, barW / 2, h);
                    const x0 = cx(i) - barW / 2;
                    // Faqat yuqori burchaklar yumaloq, pastki — o'qqa tayangan
                    const d = `M${x0},${baseY} V${baseY - h + r} Q${x0},${baseY - h} ${x0 + r},${baseY - h} H${x0 + barW - r} Q${x0 + barW},${baseY - h} ${x0 + barW},${baseY - h + r} V${baseY} Z`;
                    return <path key={b.at} d={d} fill={color} opacity={hover == null || hover === i ? 1 : 0.45} className="chart-grow transition-opacity" />;
                  })}
                </g>
                {avg != null && bars.length > 1 && (
                  <>
                    <line x1={PAD.left} x2={width - PAD.right} y1={y(avg)} y2={y(avg)} className="stroke-gray-500 dark:stroke-gray-400" strokeDasharray="4 4" />
                    <text x={width - PAD.right} y={y(avg) - 4} textAnchor="end" className="fill-gray-500 text-[10px] dark:fill-gray-400">
                      {t('server.avgShort')} {usd(avg)}
                    </text>
                  </>
                )}
                <rect
                  x={PAD.left}
                  y={0}
                  width={plotW}
                  height={H}
                  fill="transparent"
                  className="cursor-pointer touch-none"
                  onPointerMove={onMove}
                  onPointerDown={onMove}
                  onPointerLeave={() => setHover(null)}
                />
              </svg>
              {active && hover != null && <Tooltip left={cx(hover)} width={width} title={DateTime.fromISO(active.at).toFormat('dd.MM.yyyy')} value={usd(active.value)} />}
            </>
          )
        )}
      </div>
    </Frame>
  );
}
