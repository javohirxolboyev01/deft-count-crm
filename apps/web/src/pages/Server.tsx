import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, CreditCard, ExternalLink, PlugZap, RefreshCw, Server as ServerIcon, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CostBars, LineTrend } from '@/components/ServerCharts';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader, Stat } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryState } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtIsoDate, fmtShortDue } from '@/lib/time';
import type { ServerStatus } from '@/lib/types';

/*
 * Server va to'lov (rahbar): Railway ma'lumoti CRM dizaynida, oddiy tilda.
 * Deploy tarixi yo'q (rahbar qarori). To'lovning o'zi Railway sahifasida — CRM to'lov qabul qilmaydi.
 */

const usd = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
const fmtCpu = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} vCPU`;
const fmtMb = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
const axisNum = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(v < 1 ? 2 : 1)}`);
const STATE_TONE = { UP: 'done', DOWN: 'overdue', SLEEPING: 'soon', DEPLOYING: 'waiting', UNKNOWN: 'brand' } as const;

/** Yuklama chizig'i: 70% dan sariq, 90% dan qizil */
function LoadBar({ label, used, limit, text }: { label: string; used: number; limit: number | null; text: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const tone = pct == null ? 'bg-brand-500' : pct >= 90 ? 'bg-overdue' : pct >= 70 ? 'bg-soon' : 'bg-done';
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-gray-500">
          {text}
          {pct != null && <b className="ml-2 font-semibold text-foreground">{pct}%</b>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-label={label} aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-100 py-2.5 text-sm last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function PartError({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-sm text-soon">
      <AlertTriangle className="h-4 w-4 shrink-0" /> {text}
    </div>
  );
}

/** Yuklanayotganda — sahifaning o'z shaklida: 3 karta, To'lov / Yuklama bloklari, 3 grafik */
function ServerSkeleton() {
  const rows = ['w-20', 'w-16', 'w-28', 'w-24'];
  return (
    <div role="status" aria-busy>
      <div className="mb-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {['w-24', 'w-32', 'w-28'].map((w, i) => (
          <Card key={i} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Skeleton className={cn('h-3.5', w)} />
                <Skeleton className="mt-3 h-8 w-2/5" />
              </div>
              <Skeleton className="h-11 w-11 shrink-0 rounded-lg" />
            </div>
            <Skeleton className="mt-3 h-2.5 w-3/5" />
          </Card>
        ))}
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Card>
          <div className="px-4 py-3">
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="px-4 pb-4">
            {rows.map((w, i) => (
              <div key={i} className="flex items-center justify-between gap-3 border-b border-gray-100 py-3 last:border-0">
                <Skeleton className="h-3 w-24" />
                <Skeleton className={cn('h-3', w)} />
              </div>
            ))}
            <Skeleton className="mt-4 h-2.5 w-4/5" />
            <Skeleton className="mt-4 h-10 w-44 rounded-md" />
          </div>
        </Card>

        <Card>
          <div className="px-4 py-3">
            <Skeleton className="h-5 w-24" />
          </div>
          <div className="space-y-5 px-4 pb-5 pt-1">
            {['w-1/4', 'w-2/5'].map((fill, i) => (
              <div key={i}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Skeleton className="h-3.5 w-12" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <Skeleton className={cn('h-full rounded-full', fill)} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-2">
        <div className="px-4 py-3">
          <Skeleton className="h-5 w-28" />
        </div>
        <div className="grid gap-3 px-4 pb-4 md:grid-cols-3">
          {[
            'M20 104 L100 92 L180 98 L260 70 L340 80 L420 52 L500 60 L580 40',
            'M20 80 L100 84 L180 76 L260 78 L340 66 L420 70 L500 62 L580 64',
            'M20 120 L100 112 L180 104 L260 94 L340 82 L420 70 L500 56 L580 44',
          ].map((d, i) => (
            <div key={i} className="min-w-0 rounded-lg border border-gray-100 p-3 dark:border-gray-800">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3.5 w-14" />
              </div>
              <svg viewBox="0 0 600 144" preserveAspectRatio="none" className="mt-3 h-32 w-full animate-pulse" aria-hidden>
                {[16, 72, 128].map((y) => (
                  <line key={y} x1="20" x2="580" y1={y} y2={y} className="stroke-gray-200 dark:stroke-gray-700" strokeDasharray="3 5" />
                ))}
                <path d={d} fill="none" className="stroke-gray-200" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="mt-1 flex justify-between">
                <Skeleton className="h-2.5 w-10" />
                <Skeleton className="h-2.5 w-10" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function Server() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['server', 'status'],
    queryFn: () => api.get<ServerStatus>('/server/status'),
    // Avtomatik so'rov yo'q: sahifa ochilganda yoki "Yangilash" bosilganda. 1 daqiqa — server keshi bilan bir xil
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  // "Yangilash" natijasi: kartalar yonadi, grafiklar qayta chiziladi, toast. Server keshi 1 daqiqa — ichida bosilsa
  // ma'lumot o'sha, buni ham aytamiz (jim qolmaydi)
  const [flash, setFlash] = useState(0);
  const refresh = async () => {
    const before = q.data?.fetchedAt;
    const r = await q.refetch();
    if (r.isError) {
      toast.error(t('server.refreshFailed'));
      return;
    }
    const after = r.data?.fetchedAt;
    setFlash((n) => n + 1);
    if (after && after !== before) toast.success(t('server.refreshed', { at: fmtShortDue(after) }));
    else toast.info(t('server.upToDate'));
  };
  const s = q.data;
  const b = s?.billing;
  const srv = s?.server;
  const u = s?.usage;
  const trial = b?.trial;

  const days = b?.daysLeft;
  const payTone = b?.paymentFailed || (days != null && days < 0) ? 'overdue' : days != null && days <= 3 ? 'soon' : 'done';
  const payValue = b?.paymentFailed
    ? t('server.failed')
    : days == null
      ? '—'
      : days === 0
        ? t('server.today')
        : days < 0
          ? t('server.daysPast', { n: -days })
          : t('server.days', { n: days });

  return (
    <div>
      <PageHeader
        title={t('server.title')}
        actions={
          s?.configured && (
            <Button variant="outline" size="sm" onClick={refresh} loading={q.isFetching && !q.isLoading}>
              <RefreshCw className="h-4 w-4" /> {t('server.refresh')}
            </Button>
          )
        }
      />
      <QueryState q={q} skeleton={<ServerSkeleton />}>
        {s && !s.configured && (
          <Card className="flex items-start gap-3 px-4 py-4">
            <PlugZap className="mt-0.5 h-5 w-5 shrink-0 text-soon" />
            <div>
              <div className="font-medium text-foreground">{t('server.notConfigured')}</div>
              <div className="mt-1 text-sm text-gray-500">{t('server.notConfiguredHint')}</div>
            </div>
          </Card>
        )}

        {s?.configured && (
          <div key={flash} className={cn('transition-opacity duration-300', q.isFetching && !q.isLoading && 'pointer-events-none opacity-60')}>
            <div className={cn('mb-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3', flash > 0 && 'refresh-flash')}>
              <Stat
                label={t('server.state')}
                icon={ServerIcon}
                value={srv ? t(`server.states.${srv.state}`) : '—'}
                tone={srv ? STATE_TONE[srv.state] : undefined}
                hint={srv ? t(`server.stateHint.${srv.state}`) || undefined : t('server.partError')}
              />
              <Stat
                label={t(trial ? 'server.untilTrialEnd' : 'server.untilPayment')}
                icon={CalendarClock}
                value={payValue}
                tone={b ? payTone : undefined}
                hint={
                  !b
                    ? t('server.partError')
                    : b.paymentFailed
                      ? t('server.failedHint')
                      : b.nextPaymentDate
                        ? t(trial ? 'server.trialEnds' : 'server.nextPayment', { date: fmtIsoDate(b.nextPaymentDate) })
                        : undefined
                }
              />
              <Stat
                label={t('server.spent')}
                icon={Wallet}
                value={b ? usd(b.currentUsage) : '—'}
                hint={
                  trial?.creditLeft != null
                    ? t('server.creditLeft', { left: usd(trial.creditLeft), total: usd(trial.creditTotal) })
                    : b?.nextAmount != null
                      ? t('server.nextAmount', { amount: usd(b.nextAmount) })
                      : undefined
                }
              />
            </div>

            <div className={cn('grid gap-2 lg:grid-cols-2', flash > 0 && 'refresh-flash')}>
              <Card>
                <CardHeader title={t('server.payment')} />
                {!b ? (
                  <PartError text={t('server.billingError')} />
                ) : (
                  <div className="px-4 pb-4">
                    {trial && (
                      <div className="mb-2 flex items-start gap-2 rounded-md bg-soon-bg px-3 py-2.5 text-sm text-soon">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{t('server.trialWarning')}</span>
                      </div>
                    )}
                    <Row label={t('server.billingStatus')}>
                      {trial ? (
                        <span className="text-soon">{t('server.trialStatus')}</span>
                      ) : (
                        <span className={cn(b.paymentFailed ? 'text-overdue' : 'text-done')}>
                          {t(`server.billingState.${b.state}`, { defaultValue: b.state })}
                        </span>
                      )}
                    </Row>
                    <Row label={t('server.plan')}>{trial ? t('server.trialPlan') : b.plan ? b.plan.charAt(0).toUpperCase() + b.plan.slice(1) : '—'}</Row>
                    {trial?.creditLeft != null && (
                      <Row label={t('server.freeCredit')}>
                        {usd(trial.creditLeft)} <span className="text-gray-500">/ {usd(trial.creditTotal)}</span>
                      </Row>
                    )}
                    <Row label={t('server.card')}>
                      {b.card ? (
                        <span className="inline-flex items-center gap-1.5">
                          <CreditCard className="h-4 w-4 text-gray-400" />
                          <span className="capitalize">{b.card.brand}</span> •••• {b.card.last4}
                        </span>
                      ) : (
                        <span className="text-overdue">{t('server.noCard')}</span>
                      )}
                    </Row>
                    <Row label={t(trial ? 'server.trialEndLabel' : 'server.nextPaymentLabel')}>
                      {b.nextPaymentDate ? fmtIsoDate(b.nextPaymentDate) : '—'}
                      {b.nextAmount != null && <span className="ml-1.5 text-gray-500">(~{usd(b.nextAmount)})</span>}
                    </Row>
                    <p className="mt-3 text-xs text-gray-500">{t(trial ? 'server.trialHint' : 'server.autoPay')}</p>
                    <a
                      href={s.billingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-brand-500 px-4 text-sm font-medium text-on-brand shadow-sm transition-colors hover:bg-brand-600"
                    >
                      <CreditCard className="h-4 w-4" /> {t(trial ? 'server.choosePlan' : 'server.pay')} <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                    </a>
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader title={t('server.load')} />
                {!u ? (
                  <PartError text={t('server.partError')} />
                ) : (
                  <div className="space-y-5 px-4 pb-5 pt-1">
                    <LoadBar
                      label={t('server.cpu')}
                      used={u.cpu}
                      limit={u.cpuLimit}
                      text={u.cpuLimit ? t('server.of', { used: `${u.cpu.toFixed(2)} vCPU`, limit: `${+u.cpuLimit.toFixed(1)} vCPU` }) : `${u.cpu.toFixed(2)} vCPU`}
                    />
                    <LoadBar
                      label={t('server.memory')}
                      used={u.memoryGb}
                      limit={u.memoryLimitGb}
                      text={
                        u.memoryLimitGb
                          ? t('server.of', { used: `${Math.round(u.memoryGb * 1024)} MB`, limit: `${+u.memoryLimitGb.toFixed(1)} GB` })
                          : `${Math.round(u.memoryGb * 1024)} MB`
                      }
                    />
                  </div>
                )}
              </Card>
            </div>

            <Card className="mt-2">
              <CardHeader title={t('server.analytics')} />
              <div className={cn('grid gap-3 px-4 pb-4 md:grid-cols-2 xl:grid-cols-3', flash > 0 && 'refresh-flash')}>
                <LineTrend
                  label={t('server.cpuTrend')}
                  subtitle={t('server.last15Minutes')}
                  points={u?.history.map((point) => ({ at: point.at, value: point.cpu })) ?? []}
                  format={fmtCpu}
                  axis={axisNum}
                  color="#37a0ad"
                  drawKey={s.fetchedAt}
                  emptyText={t('server.noChartData', { period: t('server.last15Minutes') })}
                />
                <LineTrend
                  label={t('server.memoryTrend')}
                  subtitle={t('server.last15Minutes')}
                  points={u?.history.map((point) => ({ at: point.at, value: point.memoryGb == null ? null : point.memoryGb * 1024 })) ?? []}
                  format={fmtMb}
                  axis={axisNum}
                  color="#7c6cf2"
                  drawKey={s.fetchedAt}
                  emptyText={t('server.noChartData', { period: t('server.last15Minutes') })}
                />
                <CostBars
                  label={t('server.costTrend')}
                  subtitle={t('server.dailyCost')}
                  points={s.costHistory}
                  color="#3b82f6"
                  drawKey={s.fetchedAt}
                  emptyText={t('server.noCostData')}
                />
              </div>
            </Card>

            {s.fetchedAt && (
              <p className="mt-2 inline-flex items-center gap-1.5 px-1 text-xs text-gray-500">
                <CheckCircle2 className={cn('h-3.5 w-3.5 text-done', flash > 0 && 'animate-pulse')} />
                {t('server.checkedAt', { at: fmtDateTime(s.fetchedAt) })}
              </p>
            )}
          </div>
        )}
      </QueryState>
    </div>
  );
}
