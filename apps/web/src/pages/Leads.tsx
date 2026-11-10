import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Handshake, Phone, PhoneCall, PhoneForwarded, Search, Upload } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FileDrop } from '@/components/FileDrop';
import { ContactCalls } from '@/components/CallLog';
import { NewClientDialog } from '@/components/NewClientDialog';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, PageHeader, Stat } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, PhoneInput, Textarea } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Empty, QueryState } from '@/components/ui/states';
import { FormSkeleton, KpiSkeleton, TableSkeleton } from '@/components/ui/skeleton';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { fmtDateTime, fmtIsoDate, todayIso } from '@/lib/time';
import type { Lead, LeadCard, LeadImportReport, LeadResult, LeadStats, LeadStatus, LeadView, Paged } from '@/lib/types';

// Sotuv operatori: fayldagi yangi firmalarga qo'ng'iroq, natija + izoh, keyingi qo'ng'iroq kuni.
// "Mijoz bo'ldi" — rahbarga o'tadi (operatordan yopiladi), rahbar mijozga aylantirib buxgalter biriktiradi.

const STATUS_CLS: Record<LeadStatus, string> = {
  NEW: 'border-gray-300 bg-gray-50 text-gray-700',
  NO_ANSWER: 'border-blue-300 bg-blue-50 text-blue-700',
  CALL_LATER: 'border-soon-border bg-soon-bg text-soon',
  MEETING: 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-950/40 dark:text-brand-300',
  HAS_ACCOUNTANT: 'border-gray-300 bg-gray-100 text-gray-500',
  REJECTED: 'border-red-200 bg-red-50 text-red-700',
  WON: 'border-done-border bg-done-bg text-done',
  CONVERTED: 'border-done-border bg-done-bg text-done',
};
const RESULTS: LeadResult[] = ['NO_ANSWER', 'CALL_LATER', 'MEETING', 'HAS_ACCOUNTANT', 'REJECTED', 'WON'];
/** Ochiq natijalar: keyingi qo'ng'iroq kuni bor; CALL_LATER/MEETING'da majburiy */
const OPEN_RESULTS: LeadResult[] = ['NO_ANSWER', 'CALL_LATER', 'MEETING'];
const NEEDS_DATE: LeadResult[] = ['CALL_LATER', 'MEETING'];
const tomorrowIso = () => DateTime.fromISO(todayIso()).plus({ days: 1 }).toISODate()!;

function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const { t } = useTranslation();
  return <Badge className={STATUS_CLS[status]}>{t(`leads.status.${status}`)}</Badge>;
}

/** Vergul bilan saqlangan raqamlar: har biri bosiladigan tel: havola */
function Phones({ phone }: { phone: string | null }) {
  const { t } = useTranslation();
  if (!phone) return <span className="text-xs text-gray-400">{t('leads.noPhone')}</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {phone.split(',').map((p) => p.trim()).filter(Boolean).map((p) => (
        <a key={p} href={`tel:${p.replace(/[^\d+]/g, '')}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs text-brand-600 hover:underline dark:text-brand-400">
          <Phone className="h-3 w-3" aria-hidden /> {p}
        </a>
      ))}
    </span>
  );
}

function NextCall({ date }: { date: string | null }) {
  const { t } = useTranslation();
  if (!date) return <span className="text-gray-400">—</span>;
  const late = date < todayIso();
  return (
    <span className={cn('whitespace-nowrap text-xs', late ? 'font-medium text-overdue' : date === todayIso() ? 'font-medium text-soon' : 'text-gray-700')}>
      {fmtIsoDate(date)}
      {late && <span className="block text-[11px]">{t('leads.overdue')}</span>}
    </span>
  );
}

// ---------- Firma oynasi: aloqa ma'lumotlari, qo'ng'iroq natijasi, tarix ----------
function LeadDialog({ id, onClose, onConvert }: { id: number | null; onClose: () => void; onConvert: (l: Lead) => void }) {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['leads', 'card', id], queryFn: () => api.get<LeadCard>(`/leads/${id}`), enabled: id !== null });
  const lead = q.data;
  const [contacts, setContacts] = useState({ phone: '', director: '' });
  const [call, setCall] = useState<{ result: LeadResult | null; comment: string; nextCallDate: string }>({ result: null, comment: '', nextCallDate: '' });

  useEffect(() => {
    if (lead) setContacts({ phone: lead.phone ?? '', director: lead.director ?? '' });
  }, [lead]);
  useEffect(() => {
    setCall({ result: null, comment: '', nextCallDate: '' });
  }, [id]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['leads'] });
  const onErr = (e: unknown) => toast.error(errorText(e, t));
  const saveContacts = useMutation({
    mutationFn: () => api.patch(`/leads/${id}`, { phone: contacts.phone || null, director: contacts.director || null }),
    onSuccess: () => {
      toast.success(t('leads.saved'));
      void refresh();
    },
    onError: onErr,
  });
  const saveCall = useMutation({
    mutationFn: () =>
      api.post(`/leads/${id}/calls`, {
        result: call.result,
        comment: call.comment || null,
        nextCallDate: call.result && OPEN_RESULTS.includes(call.result) ? call.nextCallDate || null : null,
      }),
    onSuccess: () => {
      const won = call.result === 'WON';
      toast.success(t(won ? 'leads.transferred' : 'leads.saved'));
      void refresh();
      // Operatordan "Mijoz bo'ldi" firma yopiladi; qolgan holatlarda keyingi firmaga o'tish uchun oyna yopiladi
      onClose();
    },
    onError: onErr,
  });

  const pick = (result: LeadResult) =>
    setCall((c) => ({
      ...c,
      result,
      // Javob bermadi / keyinroq: odatda ertaga qayta qo'ng'iroq
      nextCallDate: OPEN_RESULTS.includes(result) ? c.nextCallDate || (result === 'MEETING' ? '' : tomorrowIso()) : '',
    }));
  const contactsChanged = !!lead && (contacts.phone !== (lead.phone ?? '') || contacts.director !== (lead.director ?? ''));
  const dateMissing = !!call.result && NEEDS_DATE.includes(call.result) && !call.nextCallDate;
  const converted = lead?.status === 'CONVERTED';

  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      title={lead?.name ?? '…'}
      className="max-w-2xl"
      footer={
        lead && (
          <>
            {isLeader && !converted && (
              <Button variant={lead.status === 'WON' ? 'success' : 'outline'} onClick={() => onConvert(lead)}>
                <Handshake className="h-4 w-4" /> {t('leads.convert')}
              </Button>
            )}
            {converted && lead.convertedClientId && (
              <Link to={`/clients/${lead.convertedClientId}`} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">{t('leads.openClient')} →</Link>
            )}
            <div className="flex-1" />
            {!converted && (
              <Button
                variant={call.result === 'WON' ? 'success' : 'default'}
                disabled={!call.result || dateMissing}
                loading={saveCall.isPending}
                onClick={() => saveCall.mutate()}
              >
                {call.result === 'WON' ? t('leads.transfer') : t('leads.saveCall')}
              </Button>
            )}
          </>
        )
      }
    >
      <QueryState q={q} skeleton={<FormSkeleton fields={6} />}>
        {lead && (
          <div className="space-y-5">
            {lead.status === 'WON' && isLeader && (
              <div className="rounded-lg border border-done-border bg-done-bg px-3 py-2 text-sm text-done">{t('leads.wonBanner')}</div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="text-sm">
                <div className="text-xs text-gray-500">{t('leads.stir')}</div>
                <div className="font-mono">{lead.stir}</div>
              </div>
              <div className="text-sm">
                <div className="text-xs text-gray-500">{t('leads.registered')}</div>
                <div>{fmtIsoDate(lead.registeredAt) || '—'}</div>
              </div>
              <Field label={t('leads.director')} htmlFor="lead-director">
                <Input id="lead-director" value={contacts.director} disabled={converted} onChange={(e) => setContacts({ ...contacts, director: e.target.value })} />
              </Field>
              <Field label={t('leads.phone')} htmlFor="lead-phone" hint={t('leads.phoneHint')}>
                <PhoneInput id="lead-phone" multiple value={contacts.phone} disabled={converted} onChange={(v) => setContacts({ ...contacts, phone: v })} />
              </Field>
              <div className="text-sm sm:col-span-2">
                <div className="text-xs text-gray-500">{t('leads.address')}</div>
                <div>{lead.address || '—'}</div>
              </div>
              {lead.phone && <div className="sm:col-span-2"><Phones phone={lead.phone} /></div>}
              {contactsChanged && (
                <div className="sm:col-span-2">
                  <Button size="sm" variant="secondary" loading={saveContacts.isPending} onClick={() => saveContacts.mutate()}>{t('leads.saveContacts')}</Button>
                </div>
              )}
            </div>

            {!converted && (
              <section className="space-y-3 rounded-lg border border-gray-200 p-3">
                <h3 className="text-sm font-semibold text-foreground">{t('leads.callTitle')}</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('leads.result')}>
                  {RESULTS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={call.result === r}
                      onClick={() => pick(r)}
                      className={cn(
                        'cursor-pointer rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                        call.result === r ? cn(STATUS_CLS[r], 'ring-2 ring-brand-500/30') : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                      )}
                    >
                      {t(`leads.status.${r}`)}
                    </button>
                  ))}
                </div>
                <Field label={t('leads.comment')} htmlFor="lead-comment">
                  <Textarea id="lead-comment" value={call.comment} placeholder={t('leads.commentPlaceholder')} onChange={(e) => setCall({ ...call, comment: e.target.value })} />
                </Field>
                {call.result && OPEN_RESULTS.includes(call.result) && (
                  <Field label={t(call.result === 'MEETING' ? 'leads.meetingDate' : 'leads.nextCall')} htmlFor="lead-next">
                    <DatePicker id="lead-next" value={call.nextCallDate} clearable={!NEEDS_DATE.includes(call.result)} onChange={(v) => setCall({ ...call, nextCallDate: v })} />
                  </Field>
                )}
                {call.result === 'WON' && <p className="text-xs text-done">{t('leads.wonHint')}</p>}
                {(call.result === 'HAS_ACCOUNTANT' || call.result === 'REJECTED') && <p className="text-xs text-gray-500">{t('leads.closedHint')}</p>}
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-semibold text-foreground">{t('leads.history')}</h3>
              {!lead.calls.length ? (
                <p className="text-sm text-gray-500">{t('leads.noCalls')}</p>
              ) : (
                <ol className="space-y-2">
                  {lead.calls.map((c) => (
                    <li key={c.id} className="rounded-lg border border-gray-200 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <LeadStatusBadge status={c.result} />
                        <span>{fmtDateTime(c.createdAt)}</span>
                        <span>· {c.userName}</span>
                        {c.nextCallDate && <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" /> {fmtIsoDate(c.nextCallDate)}</span>}
                      </div>
                      {c.comment && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{c.comment}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* IP telefoniya (V46): lead telefoni bo'yicha haqiqiy qo'ng'iroqlar */}
            <section>
              <h3 className="mb-2 text-sm font-semibold text-foreground">{t('calls.title')}</h3>
              <ContactCalls kind="lead" id={lead.id} card={false} />
            </section>
          </div>
        )}
      </QueryState>
    </Dialog>
  );
}

// ---------- Excel import (rahbar): avval tekshirish, keyin yuklash ----------
function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<LeadImportReport | null>(null);
  useEffect(() => {
    if (open) {
      setFile(null);
      setReport(null);
    }
  }, [open]);

  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      const fd = new FormData();
      fd.append('file', file!);
      return api.post<LeadImportReport>(`/leads/import${qs({ dryRun })}`, fd);
    },
    onSuccess: (r) => {
      if (r.dryRun) return setReport(r);
      toast.success(t('leads.import.done', { n: r.summary.created }));
      void qc.invalidateQueries({ queryKey: ['leads'] });
      onClose();
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  const skipped = [
    ...(report?.rows.filter((r) => r.action !== 'NEW').map((r) => ({ row: r.row, stir: r.stir, name: r.name, reason: r.action })) ?? []),
    ...(report?.invalid ?? []),
  ].sort((a, b) => a.row - b.row);
  const s = report?.summary;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('leads.import.title')}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          {!report ? (
            <Button disabled={!file} loading={run.isPending} onClick={() => run.mutate(true)}>{t('leads.import.check')}</Button>
          ) : (
            <Button disabled={!s?.created} loading={run.isPending} onClick={() => run.mutate(false)}>{t('leads.import.apply')}</Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-500">{t('leads.import.hint')}</p>
        <FileDrop file={file} onChange={(f) => { setFile(f); setReport(null); }} />
        {s && (
          <>
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">{t('leads.import.dryRunNote')}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {(['total', 'created', 'withoutPhone', 'existingLead', 'existingClient', 'duplicateRow', 'invalid'] as const).map((k) => (
                <div key={k} className="flex justify-between gap-2 border-b border-gray-100 py-1">
                  <dt className="text-gray-500">{t(`leads.import.summary.${k}`)}</dt>
                  <dd className={cn('font-semibold tabular-nums', k === 'created' && 'text-done')}>{s[k]}</dd>
                </div>
              ))}
            </dl>
            {!!skipped.length && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">{t('leads.import.skipped')}</h3>
                <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200">
                  <table className="w-full text-xs">
                    <tbody>
                      {skipped.map((r) => (
                        <tr key={`${r.row}-${r.stir}`} className="border-b border-gray-100 last:border-0">
                          <td className="px-2 py-1 text-gray-500">{t('leads.import.row')} {r.row}</td>
                          <td className="px-2 py-1 font-mono">{r.stir}</td>
                          <td className="px-2 py-1">{r.name}</td>
                          <td className="px-2 py-1 text-gray-500">{t(`leads.import.reason.${r.reason}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------- Sahifa ----------
export default function Leads() {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState<{ view: LeadView; search: string; page: number; pageSize: number }>({ view: 'today', search: '', page: 1, pageSize: 50 });
  const set = (patch: Partial<typeof f>) => setF({ ...f, page: 1, ...patch });
  const [importOpen, setImportOpen] = useState(false);
  const [converting, setConverting] = useState<Lead | null>(null);
  // Bildirishnomadan (?lead=ID) to'g'ridan-to'g'ri firma oynasi ochiladi
  const openId = params.get('lead') ? Number(params.get('lead')) : null;
  const openLead = (id: number | null) => setParams(id ? { lead: String(id) } : {}, { replace: true });

  const stats = useQuery({ queryKey: ['leads', 'stats'], queryFn: () => api.get<LeadStats>('/leads/stats') });
  const q = useQuery({
    queryKey: ['leads', 'list', f],
    queryFn: () => api.get<Paged<Lead>>(`/leads${qs({ view: f.view, search: f.search || undefined, page: f.page, pageSize: f.pageSize })}`),
    placeholderData: (prev) => prev,
  });

  const st = stats.data;
  const views: LeadView[] = isLeader ? ['today', 'open', 'won', 'closed', 'converted', 'all'] : ['today', 'open', 'closed', 'all'];
  const viewCount = (v: LeadView) => {
    const b = st?.byStatus ?? {};
    const sum = (...xs: LeadStatus[]) => xs.reduce((n, x) => n + (b[x] ?? 0), 0);
    if (v === 'today') return st?.dueToday;
    if (v === 'open') return sum('NEW', 'NO_ANSWER', 'CALL_LATER', 'MEETING');
    if (v === 'closed') return sum('HAS_ACCOUNTANT', 'REJECTED');
    if (v === 'won') return b.WON ?? 0;
    if (v === 'converted') return b.CONVERTED ?? 0;
    return undefined;
  };

  return (
    <div className="space-y-2">
      <PageHeader
        title={t('leads.title')}
        breadcrumb={isLeader}
        actions={isLeader && <Button onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" /> {t('leads.importBtn')}</Button>}
      />

      {stats.isLoading ? <KpiSkeleton count={5} /> : st && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          <Stat label={t('leads.kpi.due')} value={st.dueToday} icon={PhoneForwarded} tone={st.dueToday ? 'soon' : undefined} iconTone="soon" />
          <Stat label={t('leads.kpi.today')} value={st.calls.day} icon={PhoneCall} hint={t('leads.kpi.todayFirms', { n: st.calls.dayFirms })} />
          <Stat label={t('leads.kpi.week')} value={st.calls.week} icon={PhoneCall} />
          <Stat label={t('leads.kpi.month')} value={st.calls.month} icon={PhoneCall} />
          <Stat label={t('leads.kpi.won')} value={st.byResult.WON ?? 0} icon={Handshake} tone="done" />
        </div>
      )}

      {isLeader && !!st?.calls.month && (
        <Card>
          <CardHeader title={t('leads.monthResults')} className="pb-0" />
          <div className="flex flex-wrap gap-2 px-4 pb-3 pt-2">
            {RESULTS.map((r) => (
              <span key={r} className={cn('inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium', STATUS_CLS[r])}>
                {t(`leads.status.${r}`)} <span className="tabular-nums">{st.byResult[r] ?? 0}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <div className="section-container flex flex-wrap items-center gap-2 py-1.5">
        <div className="flex flex-wrap gap-1" role="tablist">
          {views.map((v) => {
            const n = viewCount(v);
            return (
              <button key={v} role="tab" aria-selected={f.view === v} onClick={() => set({ view: v })} className={cn('relative cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors', f.view === v ? 'border-button text-brand' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
                {t(`leads.view.${v}`)}
                {n !== undefined && <span className={cn('ml-1.5 rounded-full px-1.5 text-[11px] tabular-nums', v === 'won' && n ? 'bg-done-bg text-done' : 'bg-gray-100 text-gray-500')}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
          <Input className="pl-9" value={f.search} placeholder={t('leads.search')} aria-label={t('common.search')} onChange={(e) => set({ search: e.target.value })} />
        </div>
      </div>

      <Card>
        <QueryState q={q} skeleton={<TableSkeleton rows={10} cols={8} />}>
          {!q.data?.items.length ? <Empty /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="px-3 py-2.5">{t('leads.col.no')}</th>
                    <th className="px-3 py-2.5">{t('leads.col.company')}</th>
                    <th className="px-3 py-2.5">{t('leads.col.director')}</th>
                    <th className="px-3 py-2.5">{t('leads.col.phone')}</th>
                    <th className="px-3 py-2.5">{t('leads.col.status')}</th>
                    <th className="px-3 py-2.5">{t('leads.col.next')}</th>
                    <th className="px-3 py-2.5">{t('leads.col.comment')}</th>
                    <th className="px-3 py-2.5 text-right">{t('leads.col.calls')}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((l, i) => (
                    <tr key={l.id} onClick={() => openLead(l.id)} className="cursor-pointer border-t border-gray-200 align-top transition-colors hover:bg-gray-100">
                      <td className="px-3 py-2.5 text-xs text-gray-500">{(f.page - 1) * f.pageSize + i + 1}</td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-foreground">{l.name}</div>
                        <div className="font-mono text-xs text-gray-500">{l.stir}</div>
                      </td>
                      <td className="px-3 py-2.5 text-xs">{l.director || '—'}</td>
                      <td className="px-3 py-2.5"><Phones phone={l.phone} /></td>
                      <td className="px-3 py-2.5"><LeadStatusBadge status={l.status} /></td>
                      <td className="px-3 py-2.5"><NextCall date={l.nextCallDate} /></td>
                      <td className="max-w-[260px] px-3 py-2.5 text-xs text-gray-600"><span className="line-clamp-2">{l.lastComment || '—'}</span></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{l.callCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {q.data && q.data.total > 0 && (
            <Pagination className="border-t border-gray-200 px-4 py-3" page={f.page} pageSize={f.pageSize} total={q.data.total} onPage={(page) => setF({ ...f, page })} onPageSize={(pageSize) => set({ pageSize })} />
          )}
        </QueryState>
      </Card>

      <LeadDialog
        id={openId}
        onClose={() => openLead(null)}
        onConvert={(l) => {
          openLead(null);
          setConverting(l);
        }}
      />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <NewClientDialog open={!!converting} lead={converting} onClose={() => setConverting(null)} />
    </div>
  );
}
