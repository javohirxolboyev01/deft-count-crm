import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileSpreadsheet, FileText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CellMenu } from '@/components/CellMenu';
import { EditableTextCell, SelectCell, parseTextCell, useClientPatch } from '@/components/ClientFieldCells';
import { NoteCell } from '@/components/NoteCell';
import { REPORT_CELL } from '@/components/StatusBadge';
import { ReviewMark, SheetImportActions, clientNeeds, useReviewByClient } from '@/components/SheetImport';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Logo } from '@/components/Logo';
import { invalidateTasks, taskTitle, useAccountants } from '@/hooks/tasks';
import { useOpenTask } from '@/hooks/outlet';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { fmtIsoDate, monthLabel, shiftMonth, workMonth } from '@/lib/time';
import { type CellState, CLIENT_STATUSES, type Grid, TAX_TYPE_OPTIONS, type Task, type TaxType, taxTypeLabel } from '@/lib/types';

const CELL = REPORT_CELL;

// Sarlavha ostida muddat sanasi ko'rsatilmaydigan ustunlar (rahbar talabi)
// Yillik hisobotlarda muddat ko'rinadi (V38: dekabr katagi, muddat 1-mart, bir yil orqada)
const NO_DUE_DATE = new Set(['INPS', 'PORUCHENYA_JSHDS', 'DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS']);

export default function Monthly() {
  const { t, i18n } = useTranslation();
  const { isLeader } = useAuth();
  const accountants = useAccountants();
  // Import kamchiliklari: korxona nomi yonida belgi, bosilsa kartada ko'rinadi (faqat rahbar)
  const reviews = useReviewByClient('REPORTS');
  const openTask = useOpenTask();
  const qc = useQueryClient();
  const [month, setMonth] = useState(workMonth());
  // Excel kabi katak (V30): istalgan katakka 1 / 0 / X. "1" — Bajarildi, 5 soniya ichida bekor qilish mumkin
  const setCell = useMutation({
    mutationFn: (c: { clientId: number; reportTypeId: number; value: '1' | '0' | 'X' }) =>
      api.put<{ task: Task | null }>('/monthly-grid/cell', { ...c, month }),
    onSuccess: (r) => {
      invalidateTasks(qc);
      const task = r.task;
      if (!task) return;
      toast.success(t('task.doneToast', { title: taskTitle(task, i18n.language), client: task.clientName }), {
        duration: 5000,
        action: {
          label: t('task.undo'),
          onClick: () => {
            api
              .post(`/tasks/${task.id}/undo-done`)
              .then(() => {
                invalidateTasks(qc);
                toast.info(t('task.undone'));
              })
              .catch((e) => toast.error(errorText(e, t)));
          },
        },
      });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  // Soliq turi almashsa ochiq vazifalar bekor qilinadi: tasdiqlanadi (birinchi marta tanlash — tasdiqsiz)
  const [newOpen, setNewOpen] = useState(false);
  const [taxConfirm, setTaxConfirm] = useState<{ clientId: number; from: string; to: TaxType } | null>(null);
  // Shartnoma tugadi: rahbar mijozni jadvaldan olib tashlaydi (tasdiq bilan)
  const [removing, setRemoving] = useState<{ clientId: number; name: string } | null>(null);
  // ?search=: "Qo'lda tekshirish" ro'yxatidan korxona bosilganda (detail sahifa yo'q — jadvalning o'zida tuzatiladi)
  const [params] = useSearchParams();
  const [f, setF] = useState({ accountantId: '', taxType: '', status: '', search: params.get('search') ?? '' });
  const q = useQuery({
    queryKey: ['grid', month, f],
    queryFn: () => api.get<Grid>(`/monthly-grid${qs({ month, ...f })}`),
    placeholderData: (prev) => prev,
  });
  const g = q.data;
  const colName = (c: Grid['columns'][number]) => (i18n.language === 'ru' ? c.nameRu : c.name);
  // Sarlavhalar Google Sheet'dagidek qisqa: JSHDS, To'lov manbai, AOS, QQS, FOYDA, INPS, Poruchenya JSHDS
  const SHORT: Record<string, string> = { TOLOV_MANBAI: 'monthly.tolovShort', PORUCHENYA_JSHDS: 'monthly.poruchShort', FOYDA: 'monthly.foydaShort' };
  const colShort = (c: Grid['columns'][number]) => (SHORT[c.code] ? t(SHORT[c.code]) : colName(c));

  // Yuklab olish: faqat jadvalning o'zi, filtrsiz (hamma korxona, buxgalterga ham)
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const [printData, setPrintData] = useState<{
    grid: Grid;
    downloadedByName: string;
    downloadedByRole: 'LEADER' | 'ACCOUNTANT';
  } | null>(null);
  const downloadXlsx = async () => {
    setBusy('xlsx');
    try {
      await api.download(`/monthly-grid/export.xlsx${qs({ month })}`, `hisobot-${month}.xlsx`);
    } catch (e) {
      toast.error(errorText(e, t));
    } finally {
      setBusy(null);
    }
  };
  // PDF: brauzerning chop etish oynasi ("PDF sifatida saqlash"), serverda PDF dvijoki shart emas
  const downloadPdf = async () => {
    setBusy('pdf');
    try {
      const [grid, pdfInfo] = await Promise.all([
        api.get<Grid>(`/monthly-grid${qs({ month })}`),
        api.get<{ downloadedByName: string; downloadedByRole: 'LEADER' | 'ACCOUNTANT' }>('/users/report-pdf-info'),
      ]);
      setPrintData({ grid, ...pdfInfo });
    } catch (e) {
      toast.error(errorText(e, t));
      setBusy(null);
    }
  };
  useEffect(() => {
    if (!printData) return;
    const title = document.title;
    document.title = `hisobot-${printData.grid.period}`; // PDF fayl nomi shundan olinadi
    const done = () => {
      document.title = title;
      setPrintData(null);
      setBusy(null);
    };
    // afterprint: print() bloklamaydigan brauzerlarda jadval oyna yopilguncha turadi
    window.addEventListener('afterprint', done, { once: true });
    const id = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('afterprint', done);
    };
  }, [printData]);

  return (
    // Buxgalter ishlari sahifasidagidek: sahifa ekranga sig'adi, faqat jadval ichi scroll bo'ladi
    <div className="page-fill">
      <PageHeader
        title={t('monthly.title')}
        actions={
          <>
          {isLeader && <SheetImportActions kind="REPORTS" beforeImport={<Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> {t('clients.new')}</Button>} />}
          <Button variant="outline" onClick={downloadXlsx} disabled={!!busy}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
          <Button variant="outline" onClick={downloadPdf} disabled={!!busy}><FileText className="h-4 w-4" /> PDF</Button>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, -1))} aria-label={t('common.prev')}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="min-w-[140px] text-center text-sm font-medium capitalize">{monthLabel(month, t('months', { returnObjects: true }) as string[])}</span>
            <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, 1))} aria-label={t('common.next')}><ChevronRight className="h-4 w-4" /></Button>
          </div>
          </>
        }
      />
      <Card className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <Input className="max-w-xs" placeholder={t('clients.searchPlaceholder')} value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} aria-label={t('common.search')} />
          {isLeader && (
            <Select
              className="w-auto min-w-48"
              value={f.accountantId}
              onChange={(v) => setF({ ...f, accountantId: v })}
              aria-label={t('clients.accountant')}
              placeholder={t('clients.allAccountants')}
              clearable
              options={accountants.data?.map((a) => ({ value: String(a.id), label: a.fullName })) ?? []}
            />
          )}
          <Select className="w-auto min-w-44" value={f.taxType} onChange={(v) => setF({ ...f, taxType: v })} aria-label={t('clients.taxType')} placeholder={t('clients.allTaxTypes')} clearable options={[...TAX_TYPE_OPTIONS, { value: 'NONE', label: t('clients.taxNone') }]} />
          <Select className="w-auto min-w-44" value={f.status} onChange={(v) => setF({ ...f, status: v })} aria-label={t('clients.status')} placeholder={t('clients.allStatuses')} clearable options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))} />
          <div className="ml-auto flex flex-wrap gap-3 text-xs text-gray-600">
            {(['1', '0', '!', 'X'] as CellState[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded border', CELL[s].cls)}>{CELL[s].sym}</span>
                {t(`monthly.legend.${s === '!' ? 'overdue' : s === 'X' ? 'na' : s === '1' ? 'done' : 'open'}`)}
              </span>
            ))}
          </div>
        </div>
        <QueryState q={q} skeleton={<TableSkeleton rows={12} cols={12} />}>
          {!g?.rows?.length && <Empty text={t('monthly.empty')} />}
          {g && g.rows?.length > 0 && (
            // ~100 qator x ~10 ustun: oddiy jadval yetarli (virtualizatsiya shart emas)
            <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
              {/* Exceldagidek katakli jadval: har katakda chiziq, rangli katak butun katakni to'ldiradi (oraliq/yumaloq yo'q) */}
              {/* Qorong'i rejimda katak chizig'i sahifa fonidek to'q: X / ✓ / aniqlanmagan kataklar foni chegara rangiga yaqin, qo'shilib ketmasin */}
              <table className="w-full border-separate border-spacing-0 text-sm [&_td]:border-gray-300 dark:[&_td]:border-gray-50">
                <thead className="table-head">
                  <tr>
                    {/* Ustunlar "Hisobot topshirish jadvali" bilan bir xil: № | STIR | Korxona nomi | Soliq turi | hisobotlar | izoh */}
                    <th className="sticky left-0 top-0 z-20 w-10 min-w-10 border-r border-brand-400 px-2 py-2.5 text-center text-xs">{t('monthly.no')}</th>
                    <th className="sticky left-10 top-0 z-20 w-[104px] min-w-[104px] border-r border-brand-400 px-2 py-2.5 text-left text-xs">{t('monthly.stir')}</th>
                    <th className="sticky left-[144px] top-0 z-20 min-w-[220px] border-r border-brand-400 px-3 py-2.5 text-left text-xs">{t('monthly.company')}</th>
                    <th className="sticky top-0 z-10 w-[88px] min-w-[88px] border-r border-brand-400 px-2 py-2.5 text-xs">{t('clients.taxType')}</th>
                    <th className="sticky top-0 z-10 min-w-[120px] border-r border-brand-400 px-2 py-2.5 text-left text-xs">{t('clients.status')}</th>
                    {g.columns.map((c) => (
                      <th key={c.reportTypeId} className="sticky top-0 z-10 min-w-[92px] border-r border-brand-400 px-2 py-2.5 text-center text-xs" title={colName(c)}>
                        <div className="mx-auto max-w-[150px] whitespace-normal leading-tight">{colShort(c)}</div>
                        {!NO_DUE_DATE.has(c.code) && <div className="font-normal text-on-brand/80">{c.dueDate ? fmtIsoDate(c.dueDate) : '—'}</div>}
                      </th>
                    ))}
                    <th className={cn('sticky top-0 z-10 w-[300px] min-w-[300px] max-w-[300px] px-3 py-2.5 text-left text-xs', isLeader && 'border-r border-brand-400')}>{t('monthly.note')}</th>
                    {/* Shartnoma tugadi: mijozni jadvaldan olib tashlash — faqat rahbar (server ham requireLeader) */}
                    {isLeader && <th className="sticky top-0 z-10 w-16 min-w-16 px-2 py-2.5 text-center text-xs">{t('monthly.removeCol')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, i) => (
                    <tr key={r.clientId} className="group">
                      {/* Qator raqami — Exceldagi qator sarlavhasi kabi */}
                      <td className="sticky left-0 z-10 border-b border-r bg-gray-50 px-2 text-center text-xs tabular-nums text-gray-500 group-hover:bg-gray-100">{i + 1}</td>
                      <ClientCells row={r} isLeader={isLeader} review={<ReviewMark items={reviews.get(r.clientId)} needs={isLeader ? clientNeeds(r, t) : []} />} onTaxChange={setTaxConfirm} />
                      {g.columns.map((c) => {
                        const cell = r.cells[c.reportTypeId];
                        if (!cell) return <td key={c.reportTypeId} className="border-b border-r" />;
                        // Soliq turi aniqlanmagan: fayldagi qiymat boricha (vazifa yo'q). Tur tanlanganda vazifaga aylanadi
                        if (!r.taxType) {
                          return (
                            <td key={c.reportTypeId} className="border-b border-r p-0 text-center" title={t('monthly.rawHint')}>
                              <span className="flex h-9 w-full items-center justify-center bg-amber-50/60 text-xs font-medium text-amber-800">{cell.raw ?? ''}</span>
                            </td>
                          );
                        }
                        // Fayldagi 1/0/X deb tanilmagan matn boricha (rahbar 1/0/X tanlaguncha)
                        const raw = cell.raw !== undefined;
                        const label = raw
                          ? `${r.name} — ${colName(c)}: ${t('monthly.rawUnknown', { raw: cell.raw })}`
                          : `${r.name} — ${colName(c)}: ${t(`monthly.legend.${legendKey(cell.state)}`)}`;
                        const rawCls = 'bg-amber-50/60 text-xs font-medium text-amber-800';
                        return (
                          <td key={c.reportTypeId} className="border-b border-r p-0 text-center">
                            {/* Buxgalter faqat ko'radi (server ham yopiq: PUT /monthly-grid/cell requireLeader) */}
                            {isLeader ? (
                              <CellMenu
                                current={cell.state === '!' ? '0' : cell.state}
                                className={cn('h-9 rounded-none', raw ? rawCls : CELL[cell.state].cls)}
                                symbol={raw ? cell.raw : CELL[cell.state].sym}
                                labels={{ '1': t('monthly.legend.done'), '0': t('monthly.legend.open'), X: t('monthly.legend.na') }}
                                title={raw ? t('monthly.rawUnknown', { raw: cell.raw }) : t('monthly.cellHint')}
                                label={label}
                                busy={setCell.isPending && setCell.variables?.clientId === r.clientId && setCell.variables.reportTypeId === c.reportTypeId}
                                onPick={(value) => setCell.mutate({ clientId: r.clientId, reportTypeId: c.reportTypeId, value })}
                                onOpenTask={cell.taskId ? () => openTask(cell.taskId!) : undefined}
                              />
                            ) : (
                              <span className={cn('flex h-9 w-full items-center justify-center', raw ? rawCls : CELL[cell.state].cls)} aria-label={label} title={raw ? label : undefined}>{raw ? cell.raw : CELL[cell.state].sym}</span>
                            )}
                          </td>
                        );
                      })}
                      <NoteCell clientId={r.clientId} clientName={r.name} note={r.note} readOnly={!isLeader} className={cn(isLeader && 'border-r')} />
                      {isLeader && (
                        <td className="border-b px-1 text-center">
                          <button
                            type="button"
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                            title={t('monthly.remove')}
                            aria-label={`${r.name} — ${t('monthly.remove')}`}
                            onClick={() => setRemoving({ clientId: r.clientId, name: r.name })}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Card>
      <p className="mt-2 shrink-0 text-xs text-gray-500">{t(isLeader ? 'monthly.hint' : 'monthly.hintReadOnly')}</p>
      {printData && createPortal(<PrintTable {...printData} colShort={colShort} />, document.body)}
      {taxConfirm && <TaxConfirm {...taxConfirm} onClose={() => setTaxConfirm(null)} />}
      {isLeader && removing && <RemoveClientConfirm {...removing} onClose={() => setRemoving(null)} />}
      {isLeader && newOpen && <NewReportClientDialog onClose={() => setNewOpen(false)} onCreated={(stir) => setF({ accountantId: '', taxType: '', status: '', search: stir })} />}
    </div>
  );
}

const legendKey = (s: CellState) => (s === '!' ? 'overdue' : s === 'X' ? 'na' : s === '1' ? 'done' : 'open');
/** STIR, korxona nomi, soliq turi, holat — Excel kabi katak ichida (faqat rahbar; detail sahifa yo'q) */
function ClientCells({
  row: r,
  isLeader,
  review,
  onTaxChange,
}: {
  row: Grid['rows'][number];
  isLeader: boolean;
  review: React.ReactNode;
  onTaxChange: (c: { clientId: number; from: string; to: TaxType }) => void;
}) {
  const { t } = useTranslation();
  const save = useClientPatch(r.clientId);
  const ro = !isLeader;
  return (
    <>
      <td className="sticky left-10 z-10 border-b border-r bg-white px-0.5 text-xs tabular-nums group-hover:bg-gray-100">
        {r.stir || ro ? (
          <EditableTextCell value={r.stir} parse={parseStir} onSave={(v) => v && save.mutate({ stir: v })} readOnly={ro} label={`${r.name} — ${t('monthly.stir')}`} inputMode="numeric" />
        ) : (
          // STIR'siz (V26): fayldagi matn ko'rinadi, bosilsa to'g'ri STIR yoziladi
          <EditableTextCell value={null} display={`${r.stirRaw || '—'} ?`} parse={parseStir} onSave={(v) => v && save.mutate({ stir: v })} label={`${r.name} — ${t('monthly.stir')}`} inputMode="numeric" className="text-amber-800" />
        )}
      </td>
      {/* Bir qatorli (Exceldagidek): buxgalter nomi ustiga olib borilganda ko'rinadi */}
      <td className="sticky left-[144px] z-10 max-w-[320px] border-b border-r bg-white px-0.5 group-hover:bg-gray-100" title={`${t('clients.accountant')}: ${r.accountantName ?? t('clients.noAccountant')}`}>
        <div className="flex items-center gap-1">
          <EditableTextCell value={r.name} parse={parseTextCell} onSave={(v) => v && save.mutate({ name: v })} readOnly={ro} label={`${r.name} — ${t('monthly.company')}`} className="font-medium text-brand-500 dark:text-brand-400" />
          {review}
        </div>
      </td>
      <td className="border-b border-r px-0.5 text-center text-xs">
        <SelectCell
          value={r.taxType ?? ''}
          options={TAX_TYPE_OPTIONS}
          clearable={false}
          placeholder={r.taxTypeRaw ? `${r.taxTypeRaw} ?` : t('clients.taxNone')}
          readOnly={ro}
          display={r.taxType ? taxTypeLabel(r.taxType) : <span className="rounded bg-amber-50 px-1 font-medium text-amber-800" title={t('clients.taxNoneHint')}>{r.taxTypeRaw || t('clients.taxNone')} ?</span>}
          label={`${r.name} — ${t('clients.taxType')}`}
          onChange={(v) => {
            const to = v as TaxType;
            if (!v || to === r.taxType) return;
            if (r.taxType) onTaxChange({ clientId: r.clientId, from: r.taxType, to });
            else save.mutate({ taxType: to });
          }}
        />
      </td>
      <td className="border-b border-r px-0.5 text-xs">
        <SelectCell
          value={r.status}
          options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))}
          clearable={false}
          readOnly={ro}
          label={`${r.name} — ${t('clients.status')}`}
          onChange={(v) => v && v !== r.status && save.mutate({ status: v })}
        />
      </td>
    </>
  );
}

/**
 * Yangi mijoz (Hisobot topshirish): modal, maydonlari jadval ustunlari bilan bir xil — STIR, korxona nomi, soliq turi,
 * holat, izoh. Mijoz faqat shu bo'limga qo'shiladi; shu STIR Buxgalter ishlarida bo'lsa — o'sha mijoz shu bo'limga ham
 * qo'shiladi (server, joined). Yaratilgach jadvalda qoladi (detail sahifa yo'q), hisobot kataklari soliq turidan o'zi chiqadi.
 */
function NewReportClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (stir: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ stir: '', name: '', taxType: '' as '' | TaxType, status: 'ACTIVE', note: '' });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: number; joined?: boolean }>('/clients', {
        section: 'REPORTS',
        stir: form.stir,
        name: form.name.trim(),
        taxType: form.taxType,
        status: form.status,
        note: form.note.trim() || null,
      }),
    onSuccess: (c) => {
      toast.success(c.joined ? t('clients.joinedSection') : t('common.saved'));
      for (const key of ['grid', 'works', 'clients', 'tasks']) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
      onCreated(form.stir);
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('clients.new')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="new-report-client" disabled={create.isPending}>{t('common.create')}</Button>
        </>
      }
    >
      <form
        id="new-report-client"
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          // Soliq turi majburiy: hisobot kataklari shundan chiqadi
          if (!form.taxType) return toast.error(t('monthly.newRowRequired'));
          create.mutate();
        }}
      >
        <Field label={t('monthly.stir')} htmlFor="nr-stir">
          <Input id="nr-stir" required inputMode="numeric" pattern="\d{9}" maxLength={9} title={t('monthly.newRowRequired')} value={form.stir} onChange={(e) => set({ stir: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label={t('monthly.company')} htmlFor="nr-name"><Input id="nr-name" required value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={t('clients.taxType')} htmlFor="nr-tax">
          <Select id="nr-tax" value={form.taxType} placeholder={t('clients.chooseTax')} onChange={(v) => set({ taxType: v as TaxType })} options={TAX_TYPE_OPTIONS} />
        </Field>
        <Field label={t('clients.status')} htmlFor="nr-status">
          <Select id="nr-status" value={form.status} onChange={(v) => set({ status: v })} options={(['ACTIVE', 'ZERO_REPORT', 'LIQUIDATING'] as const).map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('monthly.note')} htmlFor="nr-note"><Textarea id="nr-note" value={form.note} onChange={(e) => set({ note: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-gray-500 sm:col-span-2">{t('monthly.newRowHint')}</p>
      </form>
    </Dialog>
  );
}

/** STIR: 9 ta raqam (bo'sh yoki noto'g'ri — saqlanmaydi) */
const parseStir = (raw: string) => {
  const d = raw.replace(/\D/g, '');
  return d.length === 9 ? d : undefined;
};

function TaxConfirm({ clientId, from, to, onClose }: { clientId: number; from: string; to: TaxType; onClose: () => void }) {
  const { t } = useTranslation();
  const save = useClientPatch(clientId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('clients.confirmTaxTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate({ taxType: to }, { onSuccess: onClose })}>{t('common.confirm')}</Button>
        </>
      }
    >
      <p className="text-sm">{t('clients.confirmTaxBody', { from: taxTypeLabel(from), to: taxTypeLabel(to), date: t('clients.thisMonth') })}</p>
    </Dialog>
  );
}

/** Shartnoma tugadi: mijoz Hisobot topshirish va Buxgalter ishlaridan olib tashlanadi (server: ikkala bo'lim belgisi false, ochiq vazifalar bekor) */
function RemoveClientConfirm({ clientId, name, onClose }: { clientId: number; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.del(`/monthly-grid/clients/${clientId}`),
    onSuccess: () => {
      toast.success(t('monthly.removed'));
      invalidateTasks(qc);
      for (const key of ['grid', 'works', 'clients']) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('monthly.removeTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>{t('monthly.remove')}</Button>
        </>
      }
    >
      <p className="text-sm">{t('monthly.removeBody', { name })}</p>
    </Dialog>
  );
}

const PRINT_CELL: Record<CellState, { sym: string; cls?: string }> = {
  '1': { sym: '1', cls: 'done' },
  '0': { sym: '0' },
  '!': { sym: '0', cls: 'overdue' },
  X: { sym: 'X', cls: 'na' },
};

/** Faqat chop etishda ko'rinadigan oddiy jadval (index.css: .print-root) — ranglar mavzudan mustaqil */
function PrintTable({
  grid: g,
  downloadedByName,
  downloadedByRole,
  colShort,
}: {
  grid: Grid;
  downloadedByName: string;
  downloadedByRole: 'LEADER' | 'ACCOUNTANT';
  colShort: (c: Grid['columns'][number]) => string;
}) {
  const { t } = useTranslation();
  return (
    <div className="print-root">
      <header className="print-heading">
        <div className="print-brand">
          <Logo variant="row" className="print-logo" />
          <div>
            <h1>{t('monthly.title')}</h1>
            <p>{monthLabel(g.period, t('months', { returnObjects: true }) as string[])}</p>
          </div>
        </div>
        <div className="print-leader">
          <strong>{downloadedByName}</strong>
          <span className="print-role">{t(`monthly.roles.${downloadedByRole}`)}</span>
          <div className="print-signature">
            <span>{t('monthly.signature')}</span>
            <span className="print-signature-line" aria-hidden="true" />
          </div>
        </div>
      </header>
      <table className="print-grid">
        <thead>
          <tr>
            <th className="col-no">{t('monthly.no')}</th>
            <th className="col-stir">{t('monthly.stir')}</th>
            <th className="col-name">{t('monthly.company')}</th>
            <th className="col-tax">{t('clients.taxType')}</th>
            {g.columns.map((c) => (
              <th key={c.reportTypeId}>
                {colShort(c)}
                {!NO_DUE_DATE.has(c.code) && c.dueDate && <div className="due">{fmtIsoDate(c.dueDate)}</div>}
              </th>
            ))}
            <th className="col-note">{t('monthly.note')}</th>
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r, i) => (
            <tr key={r.clientId}>
              <td className="c">{i + 1}</td>
              <td className="nowrap">{r.stir ?? r.stirRaw}</td>
              <td>{r.name}</td>
              <td className="c nowrap">{r.taxType ? taxTypeLabel(r.taxType) : r.taxTypeRaw}</td>
              {g.columns.map((c) => {
                const cell = r.cells[c.reportTypeId];
                if (!r.taxType || cell?.raw !== undefined) return <td key={c.reportTypeId} className="c">{cell?.raw}</td>;
                const m = cell ? PRINT_CELL[cell.state] : null;
                return <td key={c.reportTypeId} className={cn('c', m?.cls)}>{m?.sym}</td>;
              })}
              <td className="note">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
