import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, DatabaseZap, Download, Eye, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { invalidateTasks } from '@/hooks/tasks';
import { ApiError, api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { fmtDateTime } from '@/lib/time';
import type { ImportReport, PreviousImport, ReviewItem } from '@/lib/types';
import { FileDrop } from './FileDrop';
import { Button } from './ui/button';
import { Badge } from './ui/card';
import { MonthPicker } from './ui/date-picker';
import { Dialog } from './ui/dialog';
import { Field } from './ui/input';

// Excel import har sahifaning o'zida (Google Sheets sinxron olib tashlangan):
// "Hisobot topshirish" — hisobot jadvali (REPORTS), "Buxgalter ishlari" — «Бухгалтер ишлари» fayli (WORKS).
// Server fayl turini sarlavhadan aniqlaydi va sahifaga mos kelmasa rad etadi.
export type ImportKind = ImportReport['kind'];

const actionCls = {
  NEW: 'border-green-300 bg-green-50 text-green-700',
  UPDATED: 'border-blue-300 bg-blue-50 text-blue-700',
  UNCHANGED: 'border-gray-200 text-gray-500',
  SKIPPED: 'border-red-300 bg-red-50 text-red-700',
};

type RowFilter = 'ALL' | 'NEW' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'REVIEW';

/** 1 → 2 → 3 qadamlar: fayl tanlash, tekshirish (bazaga yozilmaydi), CRM'ga yuklash */
function ImportSteps({ step }: { step: 1 | 2 | 3 | 4 }) {
  const { t } = useTranslation();
  const steps = [t('sheets.step.choose'), t('sheets.step.preview'), t('sheets.step.apply')];
  return (
    <ol className="grid grid-cols-3 gap-3">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = step > n;
        const active = step === n;
        return (
          <li key={label} className="min-w-0 space-y-2" aria-current={active ? 'step' : undefined}>
            <div className={cn('h-1 rounded-full transition-colors', done ? 'bg-green-600' : active ? 'bg-brand-500' : 'bg-gray-200')} />
            <div className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  done ? 'bg-green-600 text-on-brand' : active ? 'bg-brand-500 text-on-brand' : 'bg-gray-100 text-gray-500',
                )}
              >
                {done ? <Check className="h-3 w-3" /> : n}
              </span>
              <span className={cn('truncate', active ? 'font-medium text-gray-900' : 'text-gray-500')} title={label}>{label}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ImportDialog({ kind, open, onClose }: { kind: ImportKind; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [month, setMonth] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [filter, setFilter] = useState<RowFilter>('ALL');
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setMonth('');
    setReport(null);
    setFilter('ALL');
  }, [open]);

  // Kiritilgan narsa o'zgarsa eski natija endi unga tegishli emas
  const resetReport = () => { setReport(null); setFilter('ALL'); };

  const warnDuplicate = (p: PreviousImport) =>
    toast.warning(t('sheets.alreadyImported'), {
      description: t('sheets.alreadyImportedDesc', { name: p.fileName, at: fmtDateTime(p.importedAt), by: p.importedBy ?? '—' }),
      duration: 8000,
    });

  // 'force': avval yuklangan faylni ataylab qayta yuklash (import qoidasi o'zgargan bo'lsa, tushib qolgan qatorlar yoziladi)
  const run = useMutation({
    mutationFn: (mode: boolean | 'force') => {
      const fd = new FormData();
      fd.append('file', file!);
      const dryRun = mode === true;
      return api.post<ImportReport>(`/sheets/import${qs({ dryRun, kind, month: month || undefined, force: mode === 'force' || undefined })}`, fd);
    },
    onSuccess: (r) => {
      setReport(r);
      setFilter('ALL');
      if (r.alreadyImported) warnDuplicate(r.alreadyImported);
      if (!r.dryRun) {
        toast.success(t('sheets.imported', { created: r.summary.created, updated: r.summary.updated }));
        setFile(null);
        invalidateTasks(qc);
        void qc.invalidateQueries({ queryKey: ['sheets'] });
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'FILE_ALREADY_IMPORTED') warnDuplicate(e.details as PreviousImport);
      else if (e instanceof ApiError && e.code === 'WRONG_FILE_KIND') toast.error(t(`sheets.wrongKind.${kind}`), { duration: 8000 });
      else toast.error(errorText(e, t));
    },
  });

  const downloadCsv = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `import-${report.period}${report.dryRun ? '-dry-run' : ''}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };
  const previewed = !!report?.dryRun;
  const duplicate = !!report?.alreadyImported;
  const step = report && !report.dryRun ? 4 : previewed ? 3 : file ? 2 : 1;
  // Tekshirmasdan yuklashda bir marta so'raladi: rahbar nima yozilishini ko'rmagan
  const apply = () => (previewed ? run.mutate(false) : setConfirmOpen(true));

  const s = report?.summary;
  const tiles: { key: RowFilter; label: string; value: number; cls: string }[] = s
    ? [
        { key: 'ALL', label: t('common.total'), value: s.total, cls: 'text-gray-900' },
        { key: 'NEW', label: t('sheets.new'), value: s.created, cls: 'text-green-700' },
        { key: 'UPDATED', label: t('sheets.updated'), value: s.updated, cls: 'text-blue-700' },
        { key: 'UNCHANGED', label: t('sheets.unchanged'), value: s.unchanged, cls: 'text-gray-600' },
        { key: 'SKIPPED', label: t('sheets.skipped'), value: s.skipped, cls: 'text-red-700' },
        { key: 'REVIEW', label: t('sheets.review'), value: s.review, cls: 'text-amber-700' },
      ]
    : [];
  const rows = (report?.rows ?? []).filter((r) =>
    filter === 'ALL' ? true : filter === 'REVIEW' ? r.review.length > 0 : r.action === filter,
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t(`sheets.importTitle.${kind}`)}
        className="max-w-4xl"
        footer={
          // Tugmalar doim pastda ko'rinadi (natija jadvali uzun bo'lsa ham). Tavsiya etilgan qadam asosiy rangda:
          // tekshirilmagan bo'lsa "Tekshirish", tekshirilgandan keyin "CRM'ga yuklash".
          <div className="flex w-full flex-col gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center">
            <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-gray-500">
              {previewed ? (
                <><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden /> {t('sheets.applyHint')}</>
              ) : (
                <><ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden /> {t('sheets.dryRunHint')}</>
              )}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button
                variant={previewed ? 'outline' : 'default'}
                className="flex-1 sm:flex-none"
                disabled={!file || run.isPending}
                loading={run.isPending && run.variables === true}
                onClick={() => run.mutate(true)}
              >
                <Eye className="h-4 w-4" /> {t('sheets.dryRun')}
              </Button>
              <Button
                variant={previewed ? 'default' : 'outline'}
                className="flex-1 sm:flex-none"
                disabled={!file || duplicate || run.isPending}
                loading={run.isPending && run.variables === false}
                onClick={apply}
              >
                <DatabaseZap className="h-4 w-4" /> {t('sheets.applyImport')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-6 text-sm">
          <p className="text-gray-500">{t(`sheets.fileHintFor.${kind}`)}</p>
          <ImportSteps step={step} />

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label={t('sheets.file')}><FileDrop file={file} onChange={(f) => { setFile(f); resetReport(); }} /></Field>
            </div>
            <Field label={t('sheets.period')} hint={t('sheets.periodHint')}><MonthPicker value={month} onChange={(v) => { setMonth(v); resetReport(); }} /></Field>
          </div>

          {report && s && (
            <div className="space-y-3">
              {report.dryRun ? (
                duplicate ? (
                  <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{t('sheets.alreadyImported')}</div>
                      <div className="text-xs">{t('sheets.alreadyImportedDesc', { name: report.alreadyImported!.fileName, at: fmtDateTime(report.alreadyImported!.importedAt), by: report.alreadyImported!.importedBy ?? '—' })}</div>
                      <div className="mt-1 text-xs">{t('sheets.reimportHint')}</div>
                    </div>
                    <Button size="sm" variant="outline" className="shrink-0" loading={run.isPending && run.variables === 'force'} disabled={run.isPending} onClick={() => run.mutate('force')}>
                      <RefreshCw className="h-4 w-4" /> {t('sheets.reimport')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 p-3 dark:border-brand-800 dark:bg-brand-950/40">
                    <Eye className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-300" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-gray-900">{t('sheets.dryRunResult')} · {report.period}</div>
                      <div className="text-xs text-gray-600">{t('sheets.dryRunNext')}</div>
                    </div>
                  </div>
                )
              ) : (
                <div className="flex items-start gap-3 rounded-lg border border-green-300 bg-green-50 p-3 text-green-800">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                  <div>
                    <div className="font-semibold">{t('sheets.importResult')} · {report.period}</div>
                    <div className="text-xs">{t('sheets.importDone', { cells: s.cellsDone, review: s.review })}</div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {tiles.map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    onClick={() => setFilter(x.key)}
                    className={cn(
                      'cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors',
                      filter === x.key ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40' : 'border-gray-200 hover:bg-gray-50',
                    )}
                  >
                    <div className={cn('text-lg font-semibold tabular-nums', x.cls)}>{x.value}</div>
                    <div className="truncate text-xs text-gray-500">{x.label}</div>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                <span>
                  {t('sheets.columns')}: {report.columns.map((c) => c.code).join(', ')} · {t('sheets.cellsDone')}: {s.cellsDone}
                  {!!report.ignoredColumns?.length && (
                    <span className="block text-amber-700">{t('sheets.ignoredColumns')}: {report.ignoredColumns.join(', ')}</span>
                  )}
                </span>
                <Button size="sm" variant="ghost" onClick={downloadCsv}><Download className="h-4 w-4" /> CSV</Button>
              </div>

              <div className="max-h-80 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 table-head">
                    <tr><th className="px-3 py-1.5">#</th><th className="px-3 py-1.5">{t('clients.stir')}</th><th className="px-3 py-1.5">{t('clients.name')}</th><th className="px-3 py-1.5">{t('sheets.action')}</th><th className="px-3 py-1.5">{t('sheets.reviewNotes')}</th></tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">{t('sheets.noRows')}</td></tr>}
                    {rows.map((r) => (
                      <tr key={r.row} className={cn('border-t', r.review.length && 'bg-amber-50/60')}>
                        <td className="px-3 py-1.5">{r.row}</td>
                        <td className="px-3 py-1.5 font-mono">{r.stir}</td>
                        <td className="px-3 py-1.5">{r.name}</td>
                        <td className="px-3 py-1.5"><Badge className={actionCls[r.action]}>{t(`sheets.actions.${r.action}`)}</Badge> {r.changes.join(', ')}</td>
                        <td className="px-3 py-1.5 text-amber-800">{r.review.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('sheets.confirmTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => { setConfirmOpen(false); run.mutate(true); }}><Eye className="h-4 w-4" /> {t('sheets.dryRun')}</Button>
            <Button onClick={() => { setConfirmOpen(false); run.mutate(false); }}><DatabaseZap className="h-4 w-4" /> {t('sheets.confirmApply')}</Button>
          </>
        }
      >
        <p className="text-sm text-gray-600">{t('sheets.confirmText')}</p>
      </Dialog>
    </>
  );
}

/**
 * Import aniqlagan kamchiliklar — jadvaldagi ⚠ belgisi uchun (faqat rahbar; buxgalterga so'rov yuborilmaydi — server ham yopiq).
 * kind — sahifa: faqat shu jadval faylining kamchiliklari (Hisobot topshirish / Buxgalter ishlari, V27).
 */
export function useReviewItems(kind: ImportKind) {
  const { isLeader } = useAuth();
  return useQuery({ queryKey: ['sheets', 'review', kind], queryFn: () => api.get<ReviewItem[]>(`/sheets/review${qs({ kind })}`), enabled: isLeader });
}

/** Mijoz bo'yicha ochiq kamchiliklar: jadvaldagi belgi va mijoz kartasi uchun */
export function useReviewByClient(kind: ImportKind) {
  const items = useReviewItems(kind).data;
  const map = new Map<number, ReviewItem[]>();
  for (const r of items ?? []) if (r.clientId) map.set(r.clientId, [...(map.get(r.clientId) ?? []), r]);
  return map;
}

/** Jadvalda korxona nomi yonida: kamchilik bor (ustiga olib borilsa matni) */
export function ReviewMark({ items, needs = [] }: { items: ReviewItem[] | undefined; needs?: string[] }) {
  const { t } = useTranslation();
  if (!items?.length && !needs.length) return null;
  const text = [...needs, ...(items ?? []).map((r) => r.message)].join('\n');
  return (
    <span className="inline-flex shrink-0 items-center text-amber-500" title={`${t('sheets.warnings')}:\n${text}`} aria-label={`${t('sheets.warnings')}: ${text}`}>
      <AlertTriangle className="h-3.5 w-3.5" />
    </span>
  );
}

/** Mijozda hozir yetishmayotgan narsa (import "boricha" yozgan): to'g'ri qiymat kiritilguncha turadi */
export function clientNeeds(c: { stir: string | null; stirRaw?: string | null; taxType: string | null; taxTypeRaw?: string | null }, t: TFunction) {
  const needs: string[] = [];
  if (!c.stir) needs.push(t('sheets.needStir', { raw: c.stirRaw || '—' }));
  if (!c.taxType) needs.push(t('sheets.needTax', { raw: c.taxTypeRaw || '—' }));
  return needs;
}

/**
 * Mijoz kartasi tepasida: nima kerakligi (STIR, soliq turi — qiymat kiritilguncha) va import paytida
 * aniqlangan kamchiliklar. Tugma yo'q: kartada tuzatib saqlansa o'zi yopiladi (V28).
 */
export function ClientReviewBanner({ kind, clientId, needs }: { kind: ImportKind; clientId: number; needs: string[] }) {
  const { t } = useTranslation();
  const items = useReviewByClient(kind).get(clientId) ?? [];
  if (!items.length && !needs.length) return null;
  return (
    // amber palitrasi qorong'i rejimda o'zi aylanadi (tailwind.config.js) — `dark:` yozilsa ikki marta aylanib och fon bo'lib qoladi
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/70 p-3 text-sm text-amber-900">
      <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {t('sheets.needsTitle')}</div>
      {needs.length > 0 && (
        <ul className="mb-2 list-disc space-y-0.5 pl-6 font-medium">
          {needs.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {items.length > 0 && <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">{t('sheets.warnings')} ({items.length})</div>}
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id}>{r.message} <span className="text-xs text-amber-700">· {r.ref} · {fmtDateTime(r.occurredAt)}</span></li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Sahifa sarlavhasidagi "Excel yuklash" (faqat rahbar). Kamchiliklar alohida ro'yxatda emas — jadvalda
 * korxona nomi yonidagi ⚠ belgisida (rahbar qarori).
 * Buxgalter ishlari va Hisobot topshirish sahifalari bir xil komponentni o'z fayl turi bilan ishlatadi.
 */
/** beforeImport — "Excel yuklash"dan oldin turadigan tugma ("Yangi mijoz") */
export function SheetImportActions({ kind, beforeImport }: { kind: ImportKind; beforeImport?: React.ReactNode }) {
  const { t } = useTranslation();
  const [importOpen, setImportOpen] = useState(false);
  return (
    <>
      {beforeImport}
      <Button variant="outline" onClick={() => setImportOpen(true)}>
        <Upload className="h-4 w-4" /> {t('sheets.importBtn')}
      </Button>
      {/* Tugmalar PageHeader ichida (sticky z-30 — o'z qatlami): oynalar body'ga chiqariladi, aks holda sidebar ostida qoladi */}
      {createPortal(
        <ImportDialog kind={kind} open={importOpen} onClose={() => setImportOpen(false)} />,
        document.body,
      )}
    </>
  );
}
