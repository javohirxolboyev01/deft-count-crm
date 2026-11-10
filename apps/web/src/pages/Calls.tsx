import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, PlugZap } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CallIcon, dispositionText, fmtCallDuration, fmtCallNumber, isMissed, RecordingPlayer } from '@/components/CallLog';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Checkbox, Field, Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDateTime, startOfMonthIso, todayIso } from '@/lib/time';
import type { CallList, CallStatRow, CallsStatus, User } from '@/lib/types';

/** Agentdan shuncha vaqt xabar bo'lmasa — ogohlantirish (agent har daqiqada "tirikman" yuboradi) */
const STALE_MIN = 10;

/** Rahbar: agent ulanishi va xodimga biriktirilmagan ichki raqamlar */
function StatusCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['calls', 'status'], queryFn: () => api.get<CallsStatus>('/calls/status'), refetchInterval: 60_000 });
  const s = q.data;
  if (!s) return null;
  const stale = s.lastSeenAt && DateTime.fromISO(s.lastSeenAt).diffNow('minutes').minutes < -STALE_MIN;
  const ok = s.enabled && s.lastSeenAt && !stale;
  const text = !s.enabled
    ? t('calls.status.off')
    : !s.lastSeenAt
      ? t('calls.status.never')
      : t(stale ? 'calls.status.stale' : 'calls.status.ok', { at: fmtDateTime(s.lastSeenAt) });
  const Icon = ok ? CheckCircle2 : s.enabled ? AlertTriangle : PlugZap;
  return (
    <Card className="mb-2 px-4 py-3">
      <div className={cn('flex items-center gap-2 text-sm', ok ? 'text-done' : 'text-soon')}>
        <Icon className="h-4 w-4 shrink-0" />
        <span>
          <b>{t('calls.status.title')}:</b> {text}
        </span>
      </div>
      {!!s.unassignedExts.length && (
        <div className="mt-2 text-sm">
          <div className="text-gray-700">
            {t('calls.status.unassigned')}:{' '}
            {s.unassignedExts.map((e, i) => (
              <span key={e.ext}>
                {i > 0 && ', '}
                <b className="font-mono">{e.ext}</b> <span className="text-gray-500">({t('calls.status.calls', { n: e.calls })})</span>
              </span>
            ))}
          </div>
          <Link to="/users" className="text-xs text-brand hover:text-ink">{t('calls.status.unassignedHint')}</Link>
        </div>
      )}
    </Card>
  );
}

function StatsTable({ from, to, onPick }: { from: string; to: string; onPick: (userId: string) => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['calls', 'stats', from, to],
    queryFn: () => api.get<{ rows: CallStatRow[] }>(`/calls/stats${qs({ from, to })}`),
    placeholderData: (p) => p,
  });
  return (
    <Card className="mb-2">
      <CardHeader title={t('calls.byStaff')} />
      <QueryState q={q} skeleton={<TableSkeleton rows={4} cols={7} />}>
        {!q.data?.rows.length ? <Empty text={t('calls.noCalls')} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-2.5">{t('calls.employee')}</th>
                  <th className="px-4 py-2.5 text-right">{t('calls.total')}</th>
                  <th className="px-4 py-2.5 text-right">{t('calls.outgoing')}</th>
                  <th className="px-4 py-2.5 text-right">{t('calls.incoming')}</th>
                  <th className="px-4 py-2.5 text-right">{t('calls.missed')}</th>
                  <th className="px-4 py-2.5 text-right">{t('calls.internal')}</th>
                  <th className="px-4 py-2.5 text-right">{t('calls.talkTime')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr
                    key={r.userId ?? 'none'}
                    className="cursor-pointer border-t border-gray-200 tabular-nums transition-colors hover:bg-gray-100"
                    onClick={() => onPick(r.userId ? String(r.userId) : 'none')}
                  >
                    <td className="px-4 py-2.5 font-medium">
                      {r.userName ?? <span className="text-gray-500">{t('calls.unassigned')}</span>}
                      {r.ext && <span className="ml-1.5 font-mono text-xs text-gray-500">{r.ext}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">{r.total}</td>
                    <td className="px-4 py-2.5 text-right">
                      {r.outgoing}
                      {r.outgoing > 0 && <span className="ml-1 text-xs text-gray-500">({r.outgoingAnswered})</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">{r.incoming}</td>
                    <td className={cn('px-4 py-2.5 text-right', r.missed > 0 && 'text-overdue')}>{r.missed}</td>
                    <td className="px-4 py-2.5 text-right">{r.internal}</td>
                    <td className="px-4 py-2.5 text-right">{fmtCallDuration(r.talkSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </Card>
  );
}

export default function Calls() {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const [f, setF] = useState({
    from: startOfMonthIso(),
    to: todayIso(),
    userId: '',
    direction: '',
    missed: false,
    search: '',
    page: 1,
    pageSize: 50,
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, page: 1, ...p });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users'), enabled: isLeader });
  const q = useQuery({
    queryKey: ['calls', 'list', f],
    queryFn: () =>
      api.get<CallList>(
        `/calls${qs({ ...f, missed: f.missed ? 'true' : undefined, userId: f.userId || undefined, direction: f.direction || undefined, search: f.search || undefined })}`,
      ),
    placeholderData: (p) => p,
  });
  const from = f.from || startOfMonthIso();
  const to = f.to || todayIso();

  return (
    <div>
      <PageHeader title={t('calls.title')} />
      {isLeader && <StatusCard />}
      {isLeader && <StatsTable from={from} to={to} onPick={(userId) => set({ userId })} />}
      <Card>
        <CardHeader title={t('calls.journal')} />
        <div className={cn('grid gap-3 border-b px-4 pb-3', isLeader ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-2 lg:grid-cols-5')}>
          <Field label={t('calls.from')}><DatePicker value={f.from} onChange={(v) => set({ from: v })} clearable={false} /></Field>
          <Field label={t('calls.to')}><DatePicker value={f.to} onChange={(v) => set({ to: v })} clearable={false} /></Field>
          {isLeader && (
            <Field label={t('calls.employee')}>
              <Select
                value={f.userId}
                onChange={(v) => set({ userId: v })}
                placeholder={t('common.all')}
                clearable
                options={[
                  ...(users.data?.map((u) => ({ value: String(u.id), label: u.fullName })) ?? []),
                  { value: 'none', label: t('calls.unassigned') },
                ]}
              />
            </Field>
          )}
          <Field label={t('calls.direction')}>
            <Select
              value={f.direction}
              onChange={(v) => set({ direction: v })}
              placeholder={t('common.all')}
              clearable
              options={(['IN', 'OUT', 'INTERNAL'] as const).map((d) => ({ value: d, label: t(`calls.dir.${d}`) }))}
            />
          </Field>
          <Field label={t('calls.searchNumber')}>
            <Input inputMode="tel" value={f.search} onChange={(e) => set({ search: e.target.value })} placeholder="90 123 45 67" />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox label={t('calls.onlyMissed')} checked={f.missed} onChange={(v) => set({ missed: v })} />
          </div>
        </div>
        <QueryState q={q} skeleton={<TableSkeleton rows={10} cols={6} />}>
          {!q.data?.items.length ? <Empty text={t('calls.noCalls')} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="w-8 px-4 py-2.5" aria-label={t('calls.direction')} />
                    <th className="px-4 py-2.5">{t('calls.time')}</th>
                    <th className="px-4 py-2.5">{t('calls.number')}</th>
                    <th className="px-4 py-2.5">{t('calls.who')}</th>
                    <th className="px-4 py-2.5">{t('calls.employee')}</th>
                    <th className="px-4 py-2.5 text-right">{t('calls.talk')}</th>
                    {isLeader && <th className="px-4 py-2.5">{t('calls.recording')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((c) => (
                    <tr key={c.id} className="border-t border-gray-200 transition-colors hover:bg-gray-100">
                      <td className="px-4 py-2.5"><CallIcon call={c} /></td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">{fmtDateTime(c.startedAt)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">
                        {c.direction === 'INTERNAL' ? `${c.src ?? ''} → ${c.dst ?? ''}` : fmtCallNumber(c.externalNumber)}
                      </td>
                      <td className="px-4 py-2.5">
                        {c.client ? (
                          <Link className="text-brand hover:text-ink" to={`/clients/${c.client.id}`}>{c.client.name}</Link>
                        ) : c.lead ? (
                          <span>{c.lead.name} <span className="text-xs text-gray-500">({t('nav.leads')})</span></span>
                        ) : c.direction === 'INTERNAL' ? (
                          c.peerUserName ?? '—'
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {c.userName ?? <span className="text-gray-500">{c.ext ? `${t('calls.unassigned')} (${c.ext})` : '—'}</span>}
                      </td>
                      <td className={cn('whitespace-nowrap px-4 py-2.5 text-right tabular-nums', isMissed(c) && 'text-overdue')}>
                        {isMissed(c) ? dispositionText(c.disposition, t) : fmtCallDuration(c.billsec)}
                      </td>
                      {isLeader && <td className="px-4 py-1.5">{c.recordingId ? <RecordingPlayer id={c.recordingId} /> : null}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            className="border-t px-4 py-2.5"
            page={f.page}
            pageSize={f.pageSize}
            total={q.data?.total ?? 0}
            onPage={(page) => setF({ ...f, page })}
            onPageSize={(pageSize) => set({ pageSize })}
          />
        </QueryState>
      </Card>
    </div>
  );
}
