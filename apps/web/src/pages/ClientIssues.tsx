import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { DateCell, EditableTextCell, PasswordCell, SelectCell, formatIntCell, parseIntCell, parseTextCell, useClientPatch } from '@/components/ClientFieldCells';
import { NoteCell } from '@/components/NoteCell';
import { Card, PageHeader } from '@/components/ui/card';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { type ClientIssue, useClientIssues, useDashboardClients } from '@/hooks/clientIssues';
import { useAccountants } from '@/hooks/tasks';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/time';
import { CLIENT_STATUSES, type Client, type Paged, TAX_TYPE_OPTIONS, type TaxType, taxTypeLabel } from '@/lib/types';

/**
 * "Kamchiligi bor mijozlar" sahifasi (faqat rahbar): Dashboard'dagi "Ko'rish" dialogi o'rniga alohida route.
 * Ro'yxat qoidasi Dashboard bilan bitta (useClientIssues); mijozning barcha maydonlari /clients javobidan olinadi
 * va har katak shu yerda tuzatiladi (PATCH /clients/:id, ruxsat serverda, audit_log'da). Tuzatilgan mijoz ro'yxatdan o'zi chiqadi.
 */
const TH = 'whitespace-nowrap border-r border-brand-400 px-2 py-2.5 text-left text-xs';
const P = 'border-b border-r p-0.5 text-xs align-top';
const MISSING = 'bg-amber-50 dark:bg-amber-500/10';
const fmtMoney = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('en-US'));
const parseStir = (raw: string) => {
  const s = raw.replace(/\s/g, '');
  return /^(\d{9}|\d{14})$/.test(s) ? s : undefined;
};

export default function ClientIssues() {
  const { t } = useTranslation();
  const dash = useDashboardClients();
  const issues = useClientIssues(dash.data);
  // To'liq maydonlar (aloqa, to'lov, my.mehnat.uz, izoh): ~100 mijoz, bitta sahifada
  const full = useQuery({
    queryKey: ['clients', 'issues-full'],
    queryFn: () => api.get<Paged<Client>>(`/clients${qs({ pageSize: 500 })}`),
  });
  const byId = new Map(full.data?.items.map((c) => [c.id, c]) ?? []);

  const columns = [
    '№', t('clients.stir'), t('clients.name'), t('clients.contact'), t('clients.phone'), t('clients.taxType'), t('clients.effectiveFrom'),
    t('clients.status'), t('issues.section'), t('clients.accountant'), t('works.fee'), t('works.bankKey'), t('works.employees'),
    t('clients.mehnatCheckedAt'), t('clients.mehnatLogin'), t('clients.mehnatPassword'), t('clients.note'), t('sheets.warnings'),
  ];

  return (
    <div className="page-fill">
      <PageHeader title={t('dashboard.issuesTitle', { n: issues.length })} />
      <Card className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b px-4 py-3 text-sm text-gray-500 sm:px-5">{t('dashboard.issuesHint')}</p>
        <QueryState q={dash} skeleton={<TableSkeleton />}>
          {issues.length === 0 ? (
            <Empty />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[2000px] border-collapse text-sm">
                <thead className="table-head sticky top-0 z-20">
                  <tr>
                    {columns.map((c, i) => (
                      <th key={i} className={cn(TH, i === 0 && 'w-10 text-center', i === columns.length - 1 && 'border-r-0')}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {issues.map((i, n) => <IssueRow key={i.client.clientId} n={n + 1} issue={i} full={byId.get(i.client.clientId)} />)}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

function IssueRow({ n, issue, full: f }: { n: number; issue: ClientIssue; full: Client | undefined }) {
  const { t } = useTranslation();
  const accountants = useAccountants();
  const { client: c } = issue;
  const save = useClientPatch(c.clientId);
  const lbl = (k: string) => `${c.name} — ${t(k)}`;
  return (
    <tr className="hover:bg-gray-50">
      <td className="border-b border-r px-2 py-2 text-center align-top text-xs text-gray-400">{n}</td>
      <td className={cn(P, 'min-w-[120px] tabular-nums', issue.noStir && MISSING)}>
        <EditableTextCell
          value={c.stir || null}
          display={c.stir || `${c.stirRaw || '—'} ?`}
          parse={parseStir}
          onSave={(v) => v && save.mutate({ stir: v })}
          inputMode="numeric"
          label={lbl('clients.stir')}
          className={issue.noStir ? 'text-amber-800 dark:text-amber-400' : undefined}
        />
      </td>
      <td className={cn(P, 'min-w-[220px]')}>
        <div className="flex items-center gap-1">
          <EditableTextCell value={c.name} parse={parseTextCell} onSave={(v) => v && save.mutate({ name: v })} label={lbl('clients.name')} className="font-medium" />
          <Link to={`/clients/${c.clientId}`} className="shrink-0 px-1 text-xs text-brand-500 hover:text-ink dark:text-brand-400" title={t('clients.card')}>↗</Link>
        </div>
      </td>
      <td className={cn(P, 'min-w-[160px]')}>
        <EditableTextCell value={f?.contactPerson ?? null} parse={parseTextCell} onSave={(v) => save.mutate({ contactPerson: v })} label={lbl('clients.contact')} />
      </td>
      <td className={cn(P, 'min-w-[130px]')}>
        <EditableTextCell value={f?.phone ?? null} parse={parseTextCell} onSave={(v) => save.mutate({ phone: v })} label={lbl('clients.phone')} className="tabular-nums" />
      </td>
      <td className={cn(P, 'min-w-[100px]', issue.noTax && MISSING)}>
        <SelectCell
          value={c.taxType ?? ''}
          options={TAX_TYPE_OPTIONS}
          clearable={false}
          placeholder={c.taxTypeRaw ? `${c.taxTypeRaw} ?` : t('clients.chooseTax')}
          display={c.taxType ? taxTypeLabel(c.taxType) : undefined}
          label={lbl('clients.taxType')}
          // Bor turni almashtirish tasdiq bilan (Hisobot topshirish jadvali / mijoz kartasi); bu yerda faqat aniqlanmaganini tanlash
          readOnly={!!c.taxType}
          onChange={(v) => v && save.mutate({ taxType: v as TaxType })}
        />
      </td>
      <td className="whitespace-nowrap border-b border-r px-2 py-2 align-top text-xs tabular-nums text-gray-600">
        {f?.taxTypeEffectiveFrom && f.taxTypeEffectiveFrom > '2000-01-01' ? fmtDate(f.taxTypeEffectiveFrom) : '—'}
      </td>
      <td className={cn(P, 'min-w-[140px]')}>
        <SelectCell
          value={c.status}
          options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))}
          clearable={false}
          label={lbl('clients.status')}
          onChange={(v) => v && v !== c.status && save.mutate({ status: v })}
        />
      </td>
      <td className="whitespace-nowrap border-b border-r px-2 py-2 align-top text-xs text-gray-600">
        {[c.inReports && t('nav.monthly'), c.inWorks && t('nav.clientsLeader')].filter(Boolean).join(', ')}
      </td>
      <td className={cn(P, 'min-w-[170px]', issue.noAccountant && MISSING)}>
        <SelectCell
          value={c.accountantId ? String(c.accountantId) : ''}
          options={accountants.data?.map((a) => ({ value: String(a.id), label: a.fullName })) ?? []}
          placeholder={t('clients.noAccountant')}
          label={lbl('clients.accountant')}
          onChange={(v) => save.mutate({ accountantId: v ? Number(v) : null })}
        />
      </td>
      <td className={cn(P, 'min-w-[110px]')}>
        <EditableTextCell
          value={f?.monthlyFee ?? null}
          display={fmtMoney(f?.monthlyFee)}
          parse={parseIntCell(1_000_000_000_000)}
          format={formatIntCell}
          onSave={(v) => save.mutate({ monthlyFee: v })}
          inputMode="numeric"
          className="justify-end text-right tabular-nums"
          label={lbl('works.fee')}
        />
      </td>
      <td className={cn(P, 'min-w-[90px]')}>
        <SelectCell
          value={f?.bankKey == null ? '' : f.bankKey ? 'yes' : 'no'}
          options={[{ value: 'yes', label: t('works.bankYes') }, { value: 'no', label: t('works.bankNo') }]}
          onChange={(v) => save.mutate({ bankKey: v === '' ? null : v === 'yes' })}
          label={lbl('works.bankKey')}
        />
      </td>
      <td className={cn(P, 'min-w-[70px]')}>
        <EditableTextCell
          value={f?.employeeCount ?? null}
          parse={parseIntCell(100_000)}
          format={formatIntCell}
          onSave={(v) => save.mutate({ employeeCount: v })}
          inputMode="numeric"
          className="justify-center text-center tabular-nums"
          label={lbl('works.employees')}
        />
      </td>
      <td className={cn(P, 'min-w-[120px]')}>
        <DateCell value={f?.mehnatCheckedAt ?? ''} onChange={(v) => save.mutate({ mehnatCheckedAt: v || null })} label={lbl('clients.mehnatCheckedAt')} />
      </td>
      <td className={cn(P, 'min-w-[130px]')}>
        <EditableTextCell value={f?.mehnatLogin ?? null} parse={parseTextCell} onSave={(v) => save.mutate({ mehnatLogin: v })} mono label={lbl('clients.mehnatLogin')} />
      </td>
      <td className={cn(P, 'min-w-[160px]')}>
        <PasswordCell clientId={c.clientId} label={c.name} hasPassword={!!f?.hasMehnatPassword} onSave={(pw) => save.mutate({ mehnatPassword: pw })} />
      </td>
      <NoteCell clientId={c.clientId} clientName={c.name} note={f?.note ?? null} className="border-r align-top" />
      <td className="min-w-[280px] border-b px-2 py-2 align-top text-xs text-amber-800 dark:text-amber-400">
        <ul className="list-disc space-y-0.5 pl-4">
          {issue.problems.map((p, k) => <li key={k}>{p}</li>)}
        </ul>
      </td>
    </tr>
  );
}
