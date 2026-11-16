import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, ExternalLink, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { EditableTextCell, SelectCell, TaxConfirm, parseStir, parseTextCell, useClientPatch } from '@/components/ClientFieldCells';
import { NewClientDialog } from '@/components/NewClientDialog';
import { ReviewMark, SheetImportActions, clientNeeds, useReviewByClient } from '@/components/SheetImport';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useDebounced } from '@/hooks/useDebounced';
import { invalidateTasks, useAccountants } from '@/hooks/tasks';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import {
  CLIENT_SECTIONS,
  CLIENT_STATUSES,
  type Client,
  type ClientDirectory,
  type ClientSection,
  TAX_TYPE_OPTIONS,
  type TaxType,
  taxTypeLabel,
} from '@/lib/types';

/**
 * «Mijozlar» bo'limi (rahbar, V51): barcha mijozlar bitta ro'yxatda — buxgalter biriktirilgan va biriktirilmagan.
 * Shu yerda: yangi mijoz, Excel yuklash (fayl turi serverda aniqlanadi), buxgalter biriktirish, Buxgalter ishlarida
 * ko'rinishini tanlash va "shartnoma tugadi" / qaytarish. Hisobot topshirishda har doim (hamma mijozga hisobot).
 * Asosiy maydonlar katakning o'zida (Hisobot topshirish jadvalidagidek), qolgani — mijoz kartasida.
 */
const TH = 'border-r border-brand-400 px-2 py-2.5 text-left text-xs font-semibold';
const TD = 'border-b border-r px-0.5 text-xs';
const STICKY_TD = 'sticky z-10 bg-white group-hover:bg-gray-100';

const CONFIRM_TEXT = {
  end: { title: 'clients.endTitle', body: 'clients.endBody' },
  worksOff: { title: 'clients.worksOffTitle', body: 'clients.worksOffBody' },
  delete: { title: 'clients.deleteTitle', body: 'clients.deleteBody' },
} as const;

type Filters = { search: string; accountantId: string; taxType: string; status: string; page: number; pageSize: number };
type Confirm = { kind: 'worksOff' | 'end' | 'delete'; client: Client } | null;

export default function Clients() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const accountants = useAccountants();
  // Import kamchiliklari (barcha bo'lim fayllari): korxona nomi yonida ⚠
  const reviews = useReviewByClient();
  // Yorliq URL'da: orqaga qaytilganda va havola ulashilganda saqlanadi
  const [params, setParams] = useSearchParams();
  const section: ClientSection = CLIENT_SECTIONS.find((s) => s === params.get('section')) ?? 'ALL';
  const [f, setF] = useState<Filters>({ search: '', accountantId: '', taxType: '', status: '', page: 1, pageSize: 100 });
  const set = (patch: Partial<Filters>) => setF({ ...f, page: 1, ...patch });
  const search = useDebounced(f.search.trim());
  const [newOpen, setNewOpen] = useState(false);
  const [taxConfirm, setTaxConfirm] = useState<{ clientId: number; from: string; to: TaxType } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const query = { ...f, search, section };
  const q = useQuery({
    queryKey: ['clients', 'directory', query],
    queryFn: () => api.get<ClientDirectory>(`/clients${qs(query)}`),
    placeholderData: (prev) => prev,
  });
  const accountantOptions = accountants.data?.map((a) => ({ value: String(a.id), label: a.fullName })) ?? [];

  // Bo'lim o'zgarishlari vazifalarni ham o'zgartiradi (yaratadi / bekor qiladi): hamma bog'liq ro'yxatlar yangilanadi
  const afterSectionChange = () => {
    invalidateTasks(qc);
    void qc.invalidateQueries({ queryKey: ['sheets'] });
  };
  const setWorks = useMutation({
    mutationFn: (v: { client: Client; inWorks: boolean }) => api.patch(`/clients/${v.client.id}`, { inWorks: v.inWorks }),
    onSuccess: (_r, v) => {
      toast.success(t(v.inWorks ? 'clients.worksOn' : 'clients.worksOff', { name: v.client.name }));
      afterSectionChange();
      setConfirm(null);
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const endContract = useMutation({
    mutationFn: (c: Client) => api.post(`/clients/${c.id}/end-contract`),
    onSuccess: (_r, c) => {
      toast.success(t('clients.ended', { name: c.name }));
      afterSectionChange();
      setConfirm(null);
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const restore = useMutation({
    mutationFn: (c: Client) => api.post(`/clients/${c.id}/restore`),
    onSuccess: (_r, c) => {
      toast.success(t('clients.restored', { name: c.name }));
      afterSectionChange();
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const remove = useMutation({
    mutationFn: (c: Client) => api.del(`/clients/${c.id}`),
    onSuccess: (_r, c) => {
      toast.success(t('clients.deleted', { name: c.name }));
      afterSectionChange();
      setConfirm(null);
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const busyId = (setWorks.isPending && setWorks.variables?.client.id) || (restore.isPending && restore.variables?.id) || null;

  const items = q.data?.items ?? [];
  const counts = q.data?.sections;
  return (
    <div className="page-fill">
      <PageHeader
        title={t('clients.title')}
        actions={<SheetImportActions beforeImport={<Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> {t('clients.new')}</Button>} />}
      />
      <Card className="flex min-h-0 flex-1 flex-col">
        {/* Yorliqlar: telefonda yonga suriladi (sahifa o'zi kengaymaydi) */}
        <div className="custom-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b px-3 pt-3" role="tablist" aria-label={t('clients.title')}>
          {CLIENT_SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={section === s}
              onClick={() => {
                setParams(s === 'ALL' ? {} : { section: s }, { replace: true });
                setF({ ...f, page: 1 });
              }}
              className={cn(
                '-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                section === s ? 'border-brand-500 text-brand-600 dark:text-brand-300' : 'border-transparent text-gray-500 hover:text-gray-800',
              )}
            >
              {t(`clients.section.${s}`)}
              <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] tabular-nums', section === s ? 'bg-brand-500 text-on-brand' : 'bg-gray-100 text-gray-600')}>
                {counts?.[s] ?? '…'}
              </span>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input className="pl-8" placeholder={t('clients.searchPlaceholder')} value={f.search} onChange={(e) => set({ search: e.target.value })} aria-label={t('common.search')} />
          </div>
          <Select
            className="w-auto min-w-48"
            value={f.accountantId}
            onChange={(v) => set({ accountantId: v })}
            aria-label={t('clients.accountant')}
            placeholder={t('clients.allAccountants')}
            clearable
            options={[{ value: 'none', label: t('clients.noAccountant') }, ...accountantOptions]}
          />
          <Select className="w-auto min-w-44" value={f.taxType} onChange={(v) => set({ taxType: v })} aria-label={t('clients.taxType')} placeholder={t('clients.allTaxTypes')} clearable options={[...TAX_TYPE_OPTIONS, { value: 'NONE', label: t('clients.taxNone') }]} />
          <Select className="w-auto min-w-44" value={f.status} onChange={(v) => set({ status: v })} aria-label={t('clients.status')} placeholder={t('clients.allStatuses')} clearable options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))} />
        </div>
        <QueryState q={q} skeleton={<TableSkeleton rows={12} cols={9} />}>
          {!items.length ? (
            <Empty />
          ) : (
            <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
              <table className="w-full border-separate border-spacing-0 text-sm dark:[&_td]:border-gray-50">
                <thead className="table-head sticky top-0 z-20">
                  <tr>
                    <th className={cn(TH, 'sticky left-0 z-10 w-10 min-w-10 text-center')}>№</th>
                    {/* Telefonda STIR yashiriladi: yopishqoq ustunlar ekranni egallamasin */}
                    <th className={cn(TH, 'hidden w-[104px] min-w-[104px] sm:table-cell')}>{t('clients.stir')}</th>
                    <th className={cn(TH, 'sticky left-10 z-10 w-[180px] min-w-[180px] sm:w-[240px] sm:min-w-[240px]')}>{t('clients.name')}</th>
                    <th className={cn(TH, 'w-[88px] min-w-[88px] text-center')}>{t('clients.taxType')}</th>
                    <th className={cn(TH, 'min-w-[160px]')}>{t('clients.accountant')}</th>
                    <th className={cn(TH, 'min-w-[128px]')}>{t('clients.status')}</th>
                    <th className={cn(TH, 'hidden min-w-[150px] 2xl:table-cell')}>{t('clients.phone')}</th>
                    <th className={cn(TH, 'w-[96px] min-w-[96px] whitespace-normal text-center leading-tight')}>{t('clients.col.works')}</th>
                    <th className={cn(TH, 'hidden w-[96px] min-w-[96px] whitespace-normal text-center leading-tight md:table-cell')}>{t('clients.col.reports')}</th>
                    <th className={cn(TH, 'border-r-0 text-center', section === 'ENDED' ? 'w-[148px] min-w-[148px]' : 'w-[96px] min-w-[96px]')}>{t('clients.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c, i) => (
                    <ClientRow
                      key={c.id}
                      no={(f.page - 1) * f.pageSize + i + 1}
                      client={c}
                      accountants={accountantOptions}
                      review={<ReviewMark items={reviews.get(c.id)} needs={clientNeeds(c, t)} />}
                      busy={busyId === c.id}
                      onTaxChange={setTaxConfirm}
                      onWorks={(inWorks) => (inWorks ? setWorks.mutate({ client: c, inWorks }) : setConfirm({ kind: 'worksOff', client: c }))}
                      onEnd={() => setConfirm({ kind: 'end', client: c })}
                      onRestore={() => restore.mutate(c)}
                      onDelete={() => setConfirm({ kind: 'delete', client: c })}
                    />
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
            pageSizes={[50, 100, 500]}
          />
        </QueryState>
      </Card>
      <p className="mt-2 shrink-0 text-xs text-gray-500">{t('clients.dirHint')}</p>

      <NewClientDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        // Ro'yxatda qoladi: yangi mijoz qidiruvda ko'rinadi (toast'da kartani ochish tugmasi)
        onCreated={({ stir }) => {
          setParams({}, { replace: true });
          setF({ search: stir, accountantId: '', taxType: '', status: '', page: 1, pageSize: f.pageSize });
        }}
      />
      {taxConfirm && <TaxConfirm {...taxConfirm} onClose={() => setTaxConfirm(null)} />}
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={t(CONFIRM_TEXT[confirm.kind].title)}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              {confirm.kind === 'end' ? (
                <Button variant="danger" loading={endContract.isPending} onClick={() => endContract.mutate(confirm.client)}>{t('clients.endContract')}</Button>
              ) : confirm.kind === 'delete' ? (
                <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(confirm.client)}><Trash2 className="h-4 w-4" /> {t('common.delete')}</Button>
              ) : (
                <Button variant="danger" loading={setWorks.isPending} onClick={() => setWorks.mutate({ client: confirm.client, inWorks: false })}>{t('common.confirm')}</Button>
              )}
            </>
          }
        >
          <p className="text-sm">{t(CONFIRM_TEXT[confirm.kind].body, { name: confirm.client.name })}</p>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Bitta mijoz qatori: STIR, nom, soliq turi, buxgalter, holat — katak ichida (PATCH /clients/:id, audit serverda).
 * Shartnomasi tugagan mijoz: Buxgalter ishlari almashtirgichi yopiq, o'rnida "Qaytarish".
 */
function ClientRow({
  no,
  client: c,
  accountants,
  review,
  busy,
  onTaxChange,
  onWorks,
  onEnd,
  onRestore,
  onDelete,
}: {
  no: number;
  client: Client;
  accountants: { value: string; label: string }[];
  review: React.ReactNode;
  busy: boolean;
  onTaxChange: (v: { clientId: number; from: string; to: TaxType }) => void;
  onWorks: (inWorks: boolean) => void;
  onEnd: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const save = useClientPatch(c.id);
  const ended = !c.inReports;
  const phones = c.phone?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
  return (
    <tr className={cn('group', ended && 'text-gray-500')}>
      <td className={cn('sticky left-0 z-10 border-b border-r bg-gray-50 px-2 text-center text-xs tabular-nums text-gray-500 group-hover:bg-gray-100')}>{no}</td>
      <td className={cn(TD, 'hidden tabular-nums sm:table-cell')}>
        {c.stir ? (
          <EditableTextCell value={c.stir} parse={parseStir} onSave={(v) => v && save.mutate({ stir: v })} label={`${c.name} — ${t('clients.stir')}`} inputMode="numeric" />
        ) : (
          // STIR'siz (import, V26): fayldagi matn ko'rinadi, bosilsa to'g'ri STIR yoziladi
          <EditableTextCell value={null} display={`${c.stirRaw || '—'} ?`} parse={parseStir} onSave={(v) => v && save.mutate({ stir: v })} label={`${c.name} — ${t('clients.stir')}`} inputMode="numeric" className="text-amber-800" />
        )}
      </td>
      <td className={cn(TD, STICKY_TD, 'left-10 max-w-[240px]')}>
        <div className="flex items-center gap-1">
          <EditableTextCell value={c.name} parse={parseTextCell} onSave={(v) => v && save.mutate({ name: v })} label={`${c.name} — ${t('clients.name')}`} className={cn('font-medium', !ended && 'text-brand-500 dark:text-brand-400')} />
          {review}
          <Link
            to={`/clients/${c.id}`}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-brand-50 hover:text-brand-600 dark:hover:bg-brand-950/40"
            title={t('clients.openCard')}
            aria-label={`${c.name} — ${t('clients.openCard')}`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </td>
      <td className={cn(TD, 'text-center')}>
        <SelectCell
          value={c.taxType ?? ''}
          options={TAX_TYPE_OPTIONS}
          clearable={false}
          placeholder={c.taxTypeRaw ? `${c.taxTypeRaw} ?` : t('clients.taxNone')}
          display={c.taxType ? taxTypeLabel(c.taxType) : undefined}
          label={`${c.name} — ${t('clients.taxType')}`}
          onChange={(v) => {
            const to = v as TaxType;
            if (!v || to === c.taxType) return;
            // Tur almashsa joriy oy vazifalari o'zgaradi — tasdiq; birinchi marta tanlash — darhol
            if (c.taxType) onTaxChange({ clientId: c.id, from: c.taxType, to });
            else save.mutate({ taxType: to });
          }}
        />
      </td>
      <td className={TD}>
        <SelectCell
          value={c.accountantId ? String(c.accountantId) : ''}
          options={accountants}
          placeholder={t('clients.noAccountant')}
          onChange={(v) => save.mutate({ accountantId: v ? Number(v) : null })}
          label={`${c.name} — ${t('clients.accountant')}`}
        />
      </td>
      <td className={TD}>
        <SelectCell
          value={c.status}
          options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))}
          clearable={false}
          label={`${c.name} — ${t('clients.status')}`}
          onChange={(v) => v && v !== c.status && save.mutate({ status: v })}
        />
      </td>
      <td className={cn(TD, 'hidden px-2 tabular-nums 2xl:table-cell')} title={phones.join('\n')}>
        {phones[0] ?? ''}
        {phones.length > 1 && <span className="ml-1 text-gray-400">+{phones.length - 1}</span>}
      </td>
      <td className={cn(TD, 'text-center')}>
        <span className="inline-flex" title={ended ? t('clients.endedLock') : undefined}>
          <Switch checked={c.inWorks} onChange={onWorks} disabled={ended || busy} label={`${c.name} — ${t('clients.col.works')}`} />
        </span>
      </td>
      <td className={cn(TD, 'hidden text-center md:table-cell')}>
        {c.inReports ? (
          <CheckCircle2 className="mx-auto h-5 w-5 text-green-600" aria-label={t('clients.reportsAlways')}>
            <title>{t('clients.reportsAlways')}</title>
          </CheckCircle2>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="border-b px-1 text-center">
        {ended ? (
          <div className="flex items-center justify-center gap-1">
            <Button size="sm" variant="outline" loading={busy} onClick={onRestore} aria-label={`${c.name} — ${t('clients.restore')}`}>
              <RotateCcw className="h-3.5 w-3.5" /> {t('clients.restore')}
            </Button>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
              title={t('clients.delete')}
              aria-label={`${c.name} — ${t('clients.delete')}`}
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            title={t('clients.endContract')}
            aria-label={`${c.name} — ${t('clients.endContract')}`}
            onClick={onEnd}
          >
            <Archive className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  );
}
