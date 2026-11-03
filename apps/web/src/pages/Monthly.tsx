import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileSpreadsheet, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { NoteCell } from '@/components/NoteCell';
import { SheetImportActions } from '@/components/SheetImport';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Logo } from '@/components/Logo';
import { invalidateTasks, useAccountants, useMarkDone } from '@/hooks/tasks';
import { useOpenTask } from '@/hooks/outlet';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { currentMonth, fmtIsoDate, monthLabel, shiftMonth } from '@/lib/time';
import { type CellState, CLIENT_STATUSES, type Grid } from '@/lib/types';

const CELL: Record<CellState, { sym: string; cls: string }> = {
  '1': { sym: '✓', cls: 'bg-done-bg text-done font-semibold' },
  '0': { sym: '○', cls: 'font-semibold text-gray-600 hover:bg-blue-50 dark:text-on-brand' },
  '!': { sym: '!', cls: 'bg-overdue-bg text-overdue font-bold hover:bg-red-200' },
  X: { sym: '—', cls: 'bg-gray-100 font-semibold text-gray-600 dark:text-on-brand' },
};

// Sarlavha ostida muddat sanasi ko'rsatilmaydigan ustunlar (rahbar talabi)
const NO_DUE_DATE = new Set(['INPS', 'PORUCHENYA_JSHDS', 'DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS', 'MOLIYAVIY_NATIJA', 'BALANS', 'STATISTIKA']);

export default function Monthly() {
  const { t, i18n } = useTranslation();
  const { isLeader } = useAuth();
  const accountants = useAccountants();
  const done = useMarkDone();
  const openTask = useOpenTask();
  const qc = useQueryClient();
  // Dividend/Norezident: "—" bosilsa holat belgisi qo'yiladi va vazifa chiqadi; xato bosilsa 5 soniya ichida bekor qilinadi
  const markEvent = useMutation({
    mutationFn: (url: string) => api.put(url).then(() => url),
    onSuccess: (url) => {
      invalidateTasks(qc);
      toast.success(t('monthly.eventMarked'), {
        duration: 5000,
        action: {
          label: t('task.undo'),
          onClick: () => {
            api
              .del(url)
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
  const [month, setMonth] = useState(currentMonth());
  const [f, setF] = useState({ accountantId: '', taxType: '', status: '', search: '' });
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

  // Yuklab olish: faqat jadvalning o'zi, filtrsiz (buxgalterga server o'z mijozlarini beradi)
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
    <div>
      <PageHeader
        title={t('monthly.title')}
        actions={
          <>
          {isLeader && <SheetImportActions kind="REPORTS" />}
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
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
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
          <Select className="w-auto min-w-44" value={f.taxType} onChange={(v) => setF({ ...f, taxType: v })} aria-label={t('clients.taxType')} placeholder={t('clients.allTaxTypes')} clearable options={[{ value: 'AOS', label: 'AOS' }, { value: 'QQS', label: 'QQS' }, { value: 'NONE', label: t('clients.taxNone') }]} />
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
            <div className="max-h-[calc(100vh-240px)] overflow-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead className="table-head">
                  <tr>
                    {/* Ustunlar "Hisobot topshirish jadvali" bilan bir xil: № | STIR | Korxona nomi | Soliq turi | hisobotlar | izoh */}
                    <th className="sticky left-0 top-0 z-20 w-10 min-w-10 border-r border-brand-400 px-2 py-2.5 text-center text-xs">{t('monthly.no')}</th>
                    <th className="sticky left-10 top-0 z-20 w-[104px] min-w-[104px] border-r border-brand-400 px-2 py-2.5 text-left text-xs">{t('monthly.stir')}</th>
                    <th className="sticky left-[144px] top-0 z-20 min-w-[220px] border-r border-brand-400 px-3 py-2.5 text-left text-xs">{t('monthly.company')}</th>
                    <th className="sticky top-0 z-10 border-r border-brand-400 px-2 py-2.5 text-xs">{t('clients.taxType')}</th>
                    {g.columns.map((c) => (
                      <th key={c.reportTypeId} className="sticky top-0 z-10 min-w-[92px] border-r border-brand-400 px-2 py-2.5 text-center text-xs" title={colName(c)}>
                        <div className="mx-auto max-w-[150px] whitespace-normal leading-tight">{colShort(c)}</div>
                        {!NO_DUE_DATE.has(c.code) && <div className="font-normal text-on-brand/80">{c.dueDate ? fmtIsoDate(c.dueDate) : '—'}</div>}
                      </th>
                    ))}
                    <th className="sticky top-0 z-10 w-[300px] min-w-[300px] max-w-[300px] px-3 py-2.5 text-left text-xs">{t('monthly.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, i) => (
                    <tr key={r.clientId} className="group">
                      <td className="sticky left-0 z-10 border-b border-r bg-white px-2 text-center text-xs text-gray-500 group-hover:bg-gray-100">{i + 1}</td>
                      <td className="sticky left-10 z-10 border-b border-r bg-white px-2 text-xs tabular-nums group-hover:bg-gray-100">{r.stir}</td>
                      <td className="sticky left-[144px] z-10 border-b border-r bg-white p-0 group-hover:bg-gray-100">
                        {/* Butun katak bosiladi */}
                        <Link to={`/clients/${r.clientId}`} className="block px-3 py-1.5">
                          <div className="w-fit font-medium text-brand-500 hover:text-ink dark:text-brand-400 dark:hover:text-ink">{r.name}</div>
                          <div className="text-[11px] text-gray-500">{r.accountantName ?? '—'}{r.status !== 'ACTIVE' && ` · ${t(`clientStatus.${r.status}`)}`}</div>
                        </Link>
                      </td>
                      <td className="border-b px-2 text-center text-xs">
                        {r.taxType ?? <span className="rounded bg-amber-50 px-1 font-medium text-amber-800" title={t('clients.taxNoneHint')}>{r.taxTypeRaw || t('clients.taxNone')} ?</span>}
                      </td>
                      {g.columns.map((c) => {
                        const cell = r.cells[c.reportTypeId];
                        if (!cell) return <td key={c.reportTypeId} className="border-b" />;
                        // Soliq turi aniqlanmagan: fayldagi qiymat boricha (vazifa yo'q, bosilmaydi)
                        if (!r.taxType) {
                          return (
                            <td key={c.reportTypeId} className="border-b p-0.5 text-center" title={t('monthly.rawHint')}>
                              <span className="flex h-8 w-full items-center justify-center rounded bg-amber-50/60 text-xs font-medium text-amber-800">{cell.raw ?? ''}</span>
                            </td>
                          );
                        }
                        const meta = CELL[cell.state];
                        const clickable = cell.state !== 'X' && cell.state !== '1' && cell.taskId;
                        return (
                          <td key={c.reportTypeId} className="border-b p-0.5 text-center">
                            {cell.markable && g.eventMonth ? (
                              <button
                                className={cn('h-8 w-full rounded hover:bg-blue-50', meta.cls)}
                                title={t('monthly.eventHint')}
                                aria-label={`${r.name} — ${colName(c)}: ${t('monthly.eventHint')}`}
                                disabled={markEvent.isPending}
                                onClick={() => markEvent.mutate(`/clients/${r.clientId}/events/${c.reportTypeId}/${g.eventMonth}`)}
                              >
                                {meta.sym}
                              </button>
                            ) : clickable ? (
                              <button
                                className={cn('h-8 w-full rounded', meta.cls)}
                                title={t('monthly.clickHint')}
                                aria-label={`${r.name} — ${colName(c)}: ${t('monthly.clickHint')}`}
                                onClick={() => done.mutate({ taskId: cell.taskId!, viaGrid: true })}
                                onContextMenu={(e) => { e.preventDefault(); openTask(cell.taskId!); }}
                              >
                                {meta.sym}
                              </button>
                            ) : (
                              <button
                                className={cn('h-8 w-full cursor-default rounded', meta.cls, cell.taskId && 'cursor-pointer')}
                                disabled={!cell.taskId}
                                onClick={() => cell.taskId && openTask(cell.taskId)}
                                aria-label={`${r.name} — ${colName(c)}: ${t(`monthly.legend.${cell.state === 'X' ? 'na' : cell.state === '1' ? 'done' : 'open'}`)}`}
                              >
                                {meta.sym}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <NoteCell clientId={r.clientId} clientName={r.name} note={r.note} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Card>
      <p className="mt-2 text-xs text-gray-500">{t('monthly.hint')}</p>
      {printData && createPortal(<PrintTable {...printData} colShort={colShort} />, document.body)}
    </div>
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
              <td className="nowrap">{r.stir}</td>
              <td>{r.name}</td>
              <td className="c nowrap">{r.taxType ?? r.taxTypeRaw}</td>
              {g.columns.map((c) => {
                const cell = r.cells[c.reportTypeId];
                if (!r.taxType) return <td key={c.reportTypeId} className="c">{cell?.raw}</td>;
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
