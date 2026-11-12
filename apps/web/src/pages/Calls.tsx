import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, PlugZap } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Outlet, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { CallAnalytics } from '@/components/CallAnalytics';
import { CallIcon, dispositionText, fmtCallDuration, fmtCallNumber, isMissed, RecordingPlayer } from '@/components/CallLog';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { DateRangePicker } from '@/components/ui/date-picker';
import { Checkbox, Field, Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDateTime, startOfMonthIso, todayIso } from '@/lib/time';
import type { CallList, CallRecord, CallStats, CallsStatus, User } from '@/lib/types';

/*
 * Qo'ng'iroqlar bo'limi (V46): ikki ichki sahifa —
 *   /calls/staff   — «Xodimlar bo'yicha» analitika (faqat rahbar; server ham requireLeader)
 *   /calls/journal — «Qo'ng'iroqlar jurnali» (rahbar hammasini, boshqa xodim faqat o'zinikini — server cheklaydi)
 * /calls rahbarni analitikaga, boshqalarni jurnalga yo'naltiradi.
 */

/** Agentdan shuncha vaqt xabar bo'lmasa — ogohlantirish (agent har daqiqada "tirikman" yuboradi) */
const STALE_MIN = 10;

/** Bo'lim qobig'i: sarlavha + (rahbarga) ichki sahifalar tablari */
export default function Calls() {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  // Jurnal ekran balandligiga sig'adi (page-fill): skroll jadval ichida, sarlavha qatori qotib turadi (Audit sahifasidagidek)
  const journal = useMatch('/calls/journal');
  const tabs = [
    { to: 'staff', label: t('calls.byStaff') },
    { to: 'journal', label: t('calls.journal') },
  ];
  return (
    <div className={cn(journal && 'page-fill')}>
      <PageHeader title={t('calls.title')} />
      {isLeader && (
        <nav className="section-container mb-2 flex shrink-0 flex-wrap gap-1 py-1.5" aria-label={t('calls.title')}>
          {tabs.map((x) => (
            <NavLink
              key={x.to}
              to={x.to}
              className={({ isActive }) =>
                cn('relative rounded-md px-3 py-2 text-sm font-medium transition-colors', isActive ? 'border-button text-brand' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
              }
            >
              {x.label}
            </NavLink>
          ))}
        </nav>
      )}
      <Outlet />
    </div>
  );
}

/** /calls — rahbar analitikaga, boshqalar jurnalga */
export function CallsIndex() {
  const { isLeader } = useAuth();
  return <Navigate to={isLeader ? 'staff' : 'journal'} replace />;
}

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

/** «Xodimlar bo'yicha» (rahbar): davr filtri + analitika. Xodim qatori bosilsa — jurnal shu xodim bo'yicha */
export function CallsStaff() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [range, setRange] = useState({ from: startOfMonthIso(), to: todayIso() });
  const from = range.from || startOfMonthIso();
  const to = range.to || todayIso();
  const q = useQuery({
    queryKey: ['calls', 'stats', from, to],
    queryFn: () => api.get<CallStats>(`/calls/stats${qs({ from, to })}`),
    placeholderData: (p) => p,
  });
  return (
    <div>
      <StatusCard />
      <div className="section-container mb-2">
        <div className="sm:w-72"><Field label={t('calls.period')} group><DateRangePicker value={range} onChange={setRange} aria-label={t('calls.period')} /></Field></div>
      </div>
      <QueryState q={q} skeleton={<Card><TableSkeleton rows={6} cols={6} /></Card>}>
        {!q.data?.rows.length ? (
          <Card><Empty text={t('calls.noCalls')} /></Card>
        ) : (
          <div className={cn('transition-opacity', q.isPlaceholderData && 'opacity-60')}>
            <CallAnalytics stats={q.data} onPick={(userId) => navigate(`/calls/journal${qs({ userId, from, to })}`)} />
          </div>
        )}
      </QueryState>
    </div>
  );
}

/** «Qo'ng'iroqlar jurnali»: filtrlar URL'dan ham boshlanadi (analitikadan xodim bosilganda) */
export function CallsJournal() {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const [params] = useSearchParams();
  const [f, setF] = useState({
    from: params.get('from') || startOfMonthIso(),
    to: params.get('to') || todayIso(),
    userId: isLeader ? (params.get('userId') ?? '') : '',
    direction: '',
    missed: false,
    search: '',
    company: '',
    page: 1,
    pageSize: 50,
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, page: 1, ...p });
  // short: tor ekranda vaqt ostida — '+998'siz ('90 847 84 54'), ustun yonga surilmasin
  const callNumber = (c: CallRecord, short = false) =>
    c.direction === 'INTERNAL' ? `${c.src ?? ''} → ${c.dst ?? ''}` : short ? fmtCallNumber(c.externalNumber).replace(/^\+998 /, '') : fmtCallNumber(c.externalNumber);
  const staffName = (c: CallRecord) => c.userName ?? <span className="text-gray-500">{c.ext ? `${t('calls.unassigned')} (${c.ext})` : '—'}</span>;
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users'), enabled: isLeader });
  const q = useQuery({
    queryKey: ['calls', 'list', f],
    queryFn: () =>
      api.get<CallList>(
        `/calls${qs({ ...f, missed: f.missed ? 'true' : undefined, userId: f.userId || undefined, direction: f.direction || undefined, search: f.search || undefined, company: f.company.trim() || undefined })}`,
      ),
    placeholderData: (p) => p,
  });

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader title={t('calls.journal')} className="shrink-0" />
      <div className={cn('grid shrink-0 gap-3 border-b px-4 pb-3 sm:grid-cols-2', isLeader ? 'lg:grid-cols-6' : 'lg:grid-cols-5')}>
        <Field label={t('calls.period')} group><DateRangePicker value={{ from: f.from, to: f.to }} onChange={(r) => set(r)} aria-label={t('calls.period')} /></Field>
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
        <Field label={t('calls.company')}>
          <Input value={f.company} onChange={(e) => set({ company: e.target.value })} placeholder={t('calls.companyPlaceholder')} />
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
          <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
            <table className="w-full text-xs sm:text-sm">
              <thead className="table-head sticky top-0 z-10">
                {/* Tor ekranda: raqam vaqt ostida, xodim "Kim" ostida — jadval yonga surilmaydi, ma'lumot yo'qolmaydi */}
                <tr className="sm:whitespace-nowrap">
                  <th className="w-8 px-2 py-2.5 sm:px-4" aria-label={t('calls.direction')} />
                  <th className="px-2 py-2.5 sm:px-4">{t('calls.time')}</th>
                  <th className="hidden px-4 py-2.5 lg:table-cell">{t('calls.number')}</th>
                  <th className="px-2 py-2.5 sm:px-4">{t('calls.who')}</th>
                  <th className="hidden px-4 py-2.5 sm:table-cell">{t('calls.employee')}</th>
                  <th className="px-2 py-2.5 text-right sm:px-4">{t('calls.talk')}</th>
                  {isLeader && <th className="hidden px-4 py-2.5 sm:table-cell">{t('calls.recording')}</th>}
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((c) => (
                  <tr key={c.id} className="border-t border-gray-200 transition-colors hover:bg-gray-100">
                    <td className="px-2 py-2.5 sm:px-4"><CallIcon call={c} /></td>
                    <td className="px-2 py-2.5 text-xs sm:whitespace-nowrap sm:px-4">
                      {fmtDateTime(c.startedAt)}
                      <div className="mt-0.5 whitespace-nowrap font-mono text-gray-500 lg:hidden">{callNumber(c, true)}</div>
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2.5 font-mono text-xs lg:table-cell">{callNumber(c)}</td>
                    <td className="px-2 py-2.5 sm:px-4">
                      {c.client ? (
                        <Link className="text-brand hover:text-ink" to={`/clients/${c.client.id}`}>{c.client.name}</Link>
                      ) : c.lead ? (
                        <span>{c.lead.name} <span className="text-xs text-gray-500">({t('nav.leads')})</span></span>
                      ) : c.direction === 'INTERNAL' ? (
                        c.peerUserName ?? '—'
                      ) : '—'}
                      <div className="mt-0.5 text-xs text-gray-500 sm:hidden">{staffName(c)}</div>
                    </td>
                    <td className="hidden px-4 py-2.5 sm:table-cell">{staffName(c)}</td>
                    <td className={cn('px-2 py-2.5 text-right tabular-nums sm:whitespace-nowrap sm:px-4', isMissed(c) && 'text-overdue')}>
                      {isMissed(c) ? dispositionText(c.disposition, t) : fmtCallDuration(c.billsec)}
                      {/* Telefonda yozuv alohida ustunda emas, davomiylik ostida */}
                      {c.recordingId && <div className="mt-1 flex justify-end sm:hidden"><RecordingPlayer id={c.recordingId} /></div>}
                    </td>
                    {isLeader && <td className="hidden px-4 py-1.5 sm:table-cell">{c.recordingId ? <RecordingPlayer id={c.recordingId} /> : null}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          className="shrink-0 border-t px-4 py-2.5"
          page={f.page}
          pageSize={f.pageSize}
          total={q.data?.total ?? 0}
          onPage={(page) => setF({ ...f, page })}
          onPageSize={(pageSize) => set({ pageSize })}
        />
      </QueryState>
    </Card>
  );
}
