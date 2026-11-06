import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pencil, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CellMenu, type CellValue } from '@/components/CellMenu';
import { DateCell, EditableTextCell, PasswordCell, SelectCell, formatIntCell, parseIntCell, parseTextCell, useClientPatch } from '@/components/ClientFieldCells';
import { NewClientDialog } from '@/components/NewClientDialog';
import { NoteCell } from '@/components/NoteCell';
import { ReviewMark, SheetImportActions, clientNeeds, useReviewByClient } from '@/components/SheetImport';
import { TaxBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { MonthPicker } from '@/components/ui/date-picker';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { invalidateTasks, taskTitle, useAccountants } from '@/hooks/tasks';
import { useOpenTask } from '@/hooks/outlet';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { monthLabel, shiftMonth, workDueDate, workMonth } from '@/lib/time';
import { type AdvanceResult, CLIENT_STATUSES, TAX_TYPE_OPTIONS, type Task, type WorkCell, type WorkColumn, type WorkState, type Works, type WorksRow } from '@/lib/types';

// "Oylik ishlar" ("Бухгалтер ишлари" fayli): qatorda mijoz, ustunda doimiy ish, katakda tanlangan oy ishining
// holati ("Hisobot topshirish"dagidek oyma-oy). Holat serverda vazifalardan hisoblanadi (works.ts, ?month=).
const TONE: Record<WorkState, string> = {
  done: 'bg-done-bg text-done',
  open: 'text-gray-700 hover:bg-blue-50 dark:text-on-brand',
  soon: 'bg-soon-bg text-soon',
  waiting: 'bg-waiting-bg text-waiting',
  overdue: 'bg-overdue-bg text-overdue hover:bg-red-200',
  na: 'bg-gray-100 text-gray-600 dark:text-on-brand',
};
const LEGEND: WorkState[] = ['done', 'open', 'soon', 'waiting', 'overdue', 'na'];
/** Katak belgilari "Hisobot topshirish" bilan bir xil: ✓ bajarildi, ○ ochiq, ! muddati o'tgan, — chiqmaydi */
const SYM: Record<WorkState, string> = { done: '✓', open: '○', soon: '○', waiting: '○', overdue: '!', na: 'X' };
/** Faylda 1,000,000 ko'rinishida */
const fmtMoney = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('en-US'));
const TH = 'border-r border-brand-400 px-2 py-2 text-left text-xs';
// Har katakda o'ng chiziq: ustunlar fayldagidek ajralib tursin
const TD = 'whitespace-nowrap border-b border-r px-2 text-xs';
// Oylik ishlar + Izoh sarlavhasi "Yangi vazifa" tugmasi gradientida. Ustun kengliklari qat'iy (108px, izoh 300px),
// shuning uchun har katakka butun tasmaning o'z bo'lagi beriladi: kataklar bitta uzluksiz gradient bo'lib ko'rinadi.
const WORK_W = 108;
const NOTE_W = 240;
const NOTE_CLS = 'w-[240px] min-w-[240px] max-w-[240px]';
const sectionBg = (offset: number, total: number): React.CSSProperties => ({
  backgroundImage: 'linear-gradient(to left, #048494, #10B981)',
  backgroundSize: `${total}px 100%`,
  backgroundPosition: `${-offset}px 0`,
});

// Javobgardan keyingi mijoz maydonlari (Oylik to'lov … Parol) yig'iladi: buxgalter ko'pincha o'ngdagi ish ustunlarida ishlaydi.
// Tanlov shu brauzerda eslab qolinadi (shaxsiy qulaylik, serverga yozilmaydi); standart — ochiq.
const INFO_KEY = 'works-info-open';
const readInfoOpen = () => {
  try {
    return localStorage.getItem(INFO_KEY) !== 'false';
  } catch {
    return true;
  }
};

// Teal sarlavha ustida oq kvadrat tugma: oddiy sarlavha matnidan aniq ajralib tursin
const INFO_BTN =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-brand-700 shadow-sm hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70';

// Yig'iladigan ustunlar kengligi (px). Ustunni olib tashlash o'rniga katak ichidagi o'ram max-width 0 ga
// silliq tushadi (jadval ustunini to'g'ridan-to'g'ri animatsiya qilib bo'lmaydi).
const INFO_W = { fee: 96, share: 110, bankKey: 84, employees: 72, checkedAt: 120, login: 130, password: 160 } as const;
const MEHNAT_W = INFO_W.employees + INFO_W.checkedAt + INFO_W.login + INFO_W.password;

/** Yonga surilib ochiladi / yig'iladi. Yopiq holatda `invisible` — Tab bilan yashirin katakka o'tilmaydi. */
function Slide({ open, w, className, children }: { open: boolean; w: number; className?: string; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'overflow-hidden transition-[max-width,opacity,visibility] duration-300 ease-in-out motion-reduce:transition-none',
        open ? 'visible opacity-100' : 'invisible opacity-0',
      )}
      style={{ maxWidth: open ? w : 0 }}
    >
      <div className={className} style={{ width: w }}>{children}</div>
    </div>
  );
}
/** Surilayotgan katak: padding o'ram ichida, yopiqda o'ng chiziq ham yo'q (aks holda 1px chiziqlar qoladi) */
const slideCls = (open: boolean) => cn('p-0', !open && 'border-r-0');

type Pair = { clientId: number; routineTypeId: number; month: string; next: NonNullable<WorkCell['next']> };

export default function Clients() {
  const { t, i18n } = useTranslation();
  const { isLeader } = useAuth();
  const qc = useQueryClient();
  const openTask = useOpenTask();
  const [newOpen, setNewOpen] = useState(false);
  const [month, setMonth] = useState(workMonth());
  const [edit, setEdit] = useState<{ row: WorksRow; col: WorkColumn } | null>(null);
  const [infoOpen, setInfoOpen] = useState(readInfoOpen);
  const toggleInfo = () =>
    setInfoOpen((v) => {
      try {
        localStorage.setItem(INFO_KEY, String(!v));
      } catch {
        /* ignore */
      }
      return !v;
    });
  const accountants = useAccountants();
  const reviews = useReviewByClient('WORKS');
  const accountantOptions = accountants.data?.map((a) => ({ value: String(a.id), label: a.fullName })) ?? [];
  const months = t('months', { returnObjects: true }) as string[];
  // ?taxType=NONE: Dashboard'dagi "soliq turi aniqlanmagan" havolasidan
  const [params] = useSearchParams();
  // Jadval Excel faylidagidek: standart hammasi bitta varaqda (500 = server chegarasi), qidiruvsiz ham hamma korxona ko'rinadi
  const [f, setF] = useState({ search: '', status: '', taxType: params.get('taxType') ?? '', accountantId: '', page: 1, pageSize: 500 });
  const set = (patch: Partial<typeof f>) => setF({ ...f, page: 1, ...patch });
  const q = useQuery({
    queryKey: ['works', f, month],
    queryFn: () => api.get<Works>(`/works${qs({ ...f, month })}`),
    placeholderData: (prev) => prev,
  });
  const ru = i18n.language === 'ru';
  const colName = (c: WorkColumn) => (ru ? c.nameRu : c.name);
  // Sarlavha fayldagidek qisqa ("Ish haqi"), to'liq nom title'da
  const colLabel = (c: WorkColumn) => (ru ? c.shortNameRu : c.shortName) || colName(c);

  // Katakni bosish: shu oy ishi "Bajarildi" + 5 soniyalik "Bekor qilish" (useMarkDone bilan bir xil oqim).
  // Tizimgacha bo'lgan oy (vazifasi yo'q) — boshlang'ich nuqta bir oy suriladi (advance)
  const advance = useMutation({
    mutationFn: (p: Pair): Promise<AdvanceResult> =>
      p.next.kind === 'TASK'
        ? api.post<Task>(`/tasks/${p.next.taskId}/done`).then((task) => ({ kind: 'TASK' as const, task }))
        : api.post<AdvanceResult>(`/works/${p.clientId}/${p.routineTypeId}/advance`),
    onSuccess: (r, p) => {
      invalidateTasks(qc);
      const undo = () =>
        r.kind === 'TASK' ? api.post(`/tasks/${r.task.id}/undo-done`) : api.post(`/works/${p.clientId}/${p.routineTypeId}/undo-advance`);
      const work = r.kind === 'TASK' ? taskTitle(r.task, i18n.language) : i18n.language === 'ru' ? r.workNameRu : r.workName;
      const client = r.kind === 'TASK' ? r.task.clientName : r.clientName;
      toast.success(t('works.doneToast', { work, month: monthLabel(p.month, months), client }), {
        duration: 5000,
        action: {
          label: t('task.undo'),
          onClick: () => {
            undo()
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
  // Rahbar: Excel kabi 1 / 0 / X (V31), holat to'smaydi. "1" — Bajarildi, 5 soniya ichida bekor qilish mumkin
  const setCell = useMutation({
    mutationFn: (p: { clientId: number; routineTypeId: number; value: CellValue }) =>
      api.put<{ task: Task | null }>('/works/cell', { ...p, month }),
    onSuccess: (r) => {
      invalidateTasks(qc);
      const task = r.task;
      if (!task) return;
      toast.success(t('works.doneToast', { work: taskTitle(task, i18n.language), month: monthLabel(month, months), client: task.clientName }), {
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
  const pending = (clientId: number, routineTypeId: number) =>
    (advance.isPending && advance.variables?.clientId === clientId && advance.variables.routineTypeId === routineTypeId) ||
    (setCell.isPending && setCell.variables?.clientId === clientId && setCell.variables.routineTypeId === routineTypeId);

  const items = q.data?.items ?? [];
  const columns = q.data?.columns ?? [];
  // Ketma-ket bir xil guruhdagi ustunlar birlashtiriladi (Schyot-faktura: kirim, chiqim)
  const headGroups: { key: string; label: string | null; cols: WorkColumn[] }[] = [];
  for (const c of columns) {
    const label = (ru ? c.groupRu : c.group) || null;
    const last = headGroups[headGroups.length - 1];
    if (label && last?.label === label) last.cols.push(c);
    else headGroups.push({ key: `g${c.routineTypeId}`, label, cols: [c] });
  }
  const sectionW = columns.length * WORK_W + NOTE_W;
  const bgAt = (c: WorkColumn) => sectionBg(columns.indexOf(c) * WORK_W, sectionW);

  return (
    <div className="page-fill">
      <PageHeader
        title={t('works.title')}
        actions={
          <>
            {isLeader && <SheetImportActions kind="WORKS" beforeImport={<Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> {t('clients.new')}</Button>} />}
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, -1))} aria-label={t('common.prev')}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-[140px] text-center text-sm font-medium capitalize">{monthLabel(month, months)}</span>
              <Button variant="outline" size="icon" onClick={() => setMonth(shiftMonth(month, 1))} aria-label={t('common.next')}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </>
        }
      />
      <Card className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input className="pl-8" placeholder={t('clients.searchPlaceholder')} value={f.search} onChange={(e) => set({ search: e.target.value })} aria-label={t('common.search')} />
          </div>
          {isLeader && (
            <Select
              className="w-auto min-w-48"
              value={f.accountantId}
              onChange={(v) => set({ accountantId: v })}
              aria-label={t('clients.accountant')}
              placeholder={t('clients.allAccountants')}
              clearable
              options={[{ value: 'none', label: t('clients.noAccountant') }, ...(accountants.data?.map((a) => ({ value: String(a.id), label: a.fullName })) ?? [])]}
            />
          )}
          <Select className="w-auto min-w-44" value={f.taxType} onChange={(v) => set({ taxType: v })} aria-label={t('clients.taxType')} placeholder={t('clients.allTaxTypes')} clearable options={[...TAX_TYPE_OPTIONS, { value: 'NONE', label: t('clients.taxNone') }]} />
          <Select className="w-auto min-w-44" value={f.status} onChange={(v) => set({ status: v })} aria-label={t('clients.status')} placeholder={t('clients.allStatuses')} clearable options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))} />
          <div className="ml-auto flex flex-wrap gap-3 text-xs text-gray-600">
            {LEGEND.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                {/* Katakdagi belgi bilan bir xil */}
                <span className={cn('inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] font-semibold leading-none', TONE[s])}>
                  {SYM[s]}
                </span>
                {t(`works.legend.${s}`)}
              </span>
            ))}
          </div>
        </div>
        <QueryState q={q} skeleton={<TableSkeleton rows={12} cols={16} />}>
          {!items.length ? (
            <Empty />
          ) : (
            // ~100 qator x ~20 ustun: oddiy jadval yetarli (virtualizatsiya shart emas)
            <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
              {/* Qorong'i rejimda katak chizig'i sahifa fonidek to'q (Hisobot topshirish jadvali bilan bir xil) */}
              <table className="w-full border-separate border-spacing-0 text-sm dark:[&_td]:border-gray-50">
                {/* Ikki qatorli sarlavha "Бухгалтер ишлари" faylidagidek: my.mehnat.uz va Schyot-faktura guruhlari; thead yopishqoq */}
                <thead className="table-head sticky top-0 z-20">
                  <tr>
                    {/* № | STIR | Nomi | Soliq turi | Javobgar | Oylik to'lov | 30% | Bank-klyuch | my.mehnat.uz (xodim soni, sana, login, parol) |
                        INPS hisobot | Ish haqi | Bank vipiska | Schyot-faktura (kirim, chiqim) | Debitor-Kreditor | Oylar yopilishi | Boshqa ishlar | Izoh */}
                    <th rowSpan={2} className={cn(TH, 'sticky left-0 z-10 w-10 min-w-10 text-center')}>{t('works.no')}</th>
                    {/* Telefonda STIR yashiriladi: aks holda yopishqoq ustunlar butun ekranni egallaydi */}
                    <th rowSpan={2} className={cn(TH, 'sticky left-10 z-10 hidden w-[104px] min-w-[104px] sm:table-cell')}>{t('works.stir')}</th>
                    {/* Nomi kengligi qat'iy: yopishqoq Soliq turi shu kenglikdan keyin turadi (40+160 / 144+220) */}
                    <th rowSpan={2} className={cn(TH, 'sticky left-10 z-10 w-[160px] min-w-[160px] px-3 sm:left-[144px] sm:w-[220px] sm:min-w-[220px]')}>{t('works.company')}</th>
                    {/* Soliq turi ham yonga scroll bo'lmaydi */}
                    <th rowSpan={2} className={cn(TH, 'sticky left-[200px] z-10 w-[72px] min-w-[72px] text-center sm:left-[364px]')}>{t('clients.taxType')}</th>
                    <th rowSpan={2} className={cn(TH, 'min-w-[150px]')}>
                      <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                        {t('works.accountant')}
                        {/* Yig'ish/ochish tugmasi shu ustunning o'zida (alohida ustun yo'q): ochiq — «, yig'ilgan — » */}
                        <button
                          type="button"
                          onClick={toggleInfo}
                          className={INFO_BTN}
                          title={t(infoOpen ? 'works.infoCollapse' : 'works.infoExpand')}
                          aria-label={t(infoOpen ? 'works.infoCollapse' : 'works.infoExpand')}
                          aria-expanded={infoOpen}
                        >
                          {infoOpen ? <ChevronsLeft className="h-4 w-4" /> : <ChevronsRight className="h-4 w-4" />}
                        </button>
                      </div>
                    </th>
                    {isLeader && <th rowSpan={2} className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.fee} className="px-2 py-2 text-right">{t('works.fee')}</Slide></th>}
                    <th rowSpan={2} className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.share} className="whitespace-normal px-2 py-2 text-right leading-tight">{t('works.share', { pct: q.data?.sharePercent ?? 30 })}</Slide></th>
                    <th rowSpan={2} className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.bankKey} className="px-2 py-2 text-center">{t('works.bankKey')}</Slide></th>
                    <th colSpan={4} className={cn(TH, 'border-b border-b-brand-400', slideCls(infoOpen))}><Slide open={infoOpen} w={MEHNAT_W} className="px-2 py-2 text-center">my.mehnat.uz</Slide></th>
                    {headGroups.map((g) =>
                      g.label ? (
                        <th key={g.key} colSpan={g.cols.length} className={cn(TH, 'border-b border-b-brand-400 text-center')} style={bgAt(g.cols[0])}>{g.label}</th>
                      ) : (
                        <WorkTh key={g.key} label={colLabel(g.cols[0])} title={colName(g.cols[0])} due={workDueDate(month, g.cols[0].dueDay)} rowSpan={2} style={bgAt(g.cols[0])} />
                      ),
                    )}
                    <th rowSpan={2} className={cn(TH, NOTE_CLS, 'border-r-0 px-3')} style={sectionBg(columns.length * WORK_W, sectionW)}>{t('works.note')}</th>
                  </tr>
                  <tr>
                    <th className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.employees} className="whitespace-normal px-2 py-2 text-center leading-tight">{t('works.employees')}</Slide></th>
                    <th className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.checkedAt} className="px-2 py-2 text-center">{t('works.checkedAt')}</Slide></th>
                    <th className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.login} className="px-2 py-2">{t('works.login')}</Slide></th>
                    <th className={cn(TH, slideCls(infoOpen))}><Slide open={infoOpen} w={INFO_W.password} className="px-2 py-2">{t('works.password')}</Slide></th>
                    {headGroups.filter((g) => g.label).flatMap((g) => g.cols.map((c) => <WorkTh key={c.routineTypeId} label={colLabel(c)} title={colName(c)} due={workDueDate(month, c.dueDay)} style={bgAt(c)} />))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={r.clientId} className="group">
                      <td className="sticky left-0 z-10 border-b border-r bg-white px-2 text-center text-xs text-gray-500 group-hover:bg-gray-100">{(f.page - 1) * f.pageSize + i + 1}</td>
                      <td className="sticky left-10 z-10 hidden border-b border-r bg-white px-2 text-xs tabular-nums group-hover:bg-gray-100 sm:table-cell">{r.stir ?? <span className="rounded bg-amber-50 px-1 font-medium text-amber-800" title={t('clients.stirMissing')}>{r.stirRaw || '—'} ?</span>}</td>
                      <td className="sticky left-10 z-10 w-[160px] min-w-[160px] border-b border-r bg-white p-0 group-hover:bg-gray-100 sm:left-[144px] sm:w-[220px] sm:min-w-[220px]">
                        {/* Butun katak bosiladi */}
                        <Link to={`/clients/${r.clientId}`} className="block px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="w-fit font-medium text-brand-500 hover:text-ink dark:text-brand-400 dark:hover:text-ink">{r.name}</span>
                            <ReviewMark items={reviews.get(r.clientId)} needs={isLeader ? clientNeeds(r, t) : []} />
                          </div>
                          {r.status !== 'ACTIVE' && <div className="text-[11px] text-gray-500">{t(`clientStatus.${r.status}`)}</div>}
                        </Link>
                      </td>
                      <td className="sticky left-[200px] z-10 border-b border-r bg-white px-2 text-center group-hover:bg-gray-100 sm:left-[364px]"><TaxBadge taxType={r.taxType} raw={r.taxTypeRaw} /></td>
                      <ClientFieldTds row={r} isLeader={isLeader} accountants={accountantOptions} open={infoOpen} />
                      {columns.map((c) => (
                        <WorkCellView
                          key={c.routineTypeId}
                          cell={r.cells[c.routineTypeId]}
                          label={`${r.name} — ${colLabel(c)}`}
                          busy={pending(r.clientId, c.routineTypeId)}
                          onAdvance={(next) => advance.mutate({ clientId: r.clientId, routineTypeId: c.routineTypeId, month: next.month, next })}
                          onPick={isLeader ? (value) => setCell.mutate({ clientId: r.clientId, routineTypeId: c.routineTypeId, value }) : undefined}
                          onOpenTask={openTask}
                          onEdit={isLeader ? () => setEdit({ row: r, col: c }) : undefined}
                        />
                      ))}
                      <NoteCell clientId={r.clientId} clientName={r.name} note={r.note} className={NOTE_CLS} />
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
            pageSizes={[50, 100, 500]}
          />
        </QueryState>
      </Card>
      <p className="mt-2 shrink-0 text-xs text-gray-500">
        {t('works.hint')} {isLeader && t('works.leaderHint')}
      </p>
      {isLeader && <NewClientDialog open={newOpen} onClose={() => setNewOpen(false)} section="WORKS" />}
      {isLeader && edit && <BaselineDialog key={`${edit.row.clientId}:${edit.col.routineTypeId}`} {...edit} colName={colLabel(edit.col)} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Ish sarlavhasi; ostida tanlangan oy ishining muddati (Hisobot topshirish sarlavhasidagidek) */
function WorkTh({ label, title, due, rowSpan, style }: { label: string; title: string; due: string; rowSpan?: number; style?: React.CSSProperties }) {
  return (
    <th rowSpan={rowSpan} className={cn(TH, 'w-[108px] min-w-[108px] max-w-[108px] text-center')} title={title} style={style}>
      <div className="line-clamp-2 whitespace-normal leading-tight">{label}</div>
      <div className="font-normal text-on-brand/80">{due}</div>
    </th>
  );
}

function WorkCellView({
  cell,
  label,
  busy,
  onAdvance,
  onPick,
  onOpenTask,
  onEdit,
}: {
  cell: WorkCell | undefined;
  label: string;
  busy: boolean;
  onAdvance: (next: NonNullable<WorkCell['next']>) => void;
  /** Rahbar: 1 / 0 / X menyusi (tizimgacha bo'lgan oylardan tashqari — ular boshlang'ich nuqtadan) */
  onPick?: (v: CellValue) => void;
  onOpenTask: (taskId: number) => void;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const months = t('months', { returnObjects: true }) as string[];
  if (!cell) return <td className="border-b border-r" />;
  const next = cell.next;
  const title = cell.raw
    ? t('works.rawHint', { raw: cell.raw })
    : next
      ? t('works.clickHint', { month: monthLabel(next.month, months) })
      : cell.beforeSystem
        ? t(cell.state === 'done' ? 'works.beforeSystemDone' : 'works.gapOrder')
        : t(`works.legend.${cell.state}`);

  // Tizimdagi oy: Excel kabi 1 / 0 / X menyusi. Rahbar — hammasi; buxgalter — faqat "1" (shu oy vazifasi
  // ochiq bo'lsa, 6.6 oqimi + undo). 0 (qayta ochish) va X serverda rahbarniki (REOPEN_LEADER_ONLY, requireLeader)
  if (!cell.beforeSystem) {
    const taskNext = next?.kind === 'TASK' ? next : null;
    const pick = onPick ?? ((v: CellValue) => v === '1' && taskNext && onAdvance(taskNext));
    const locked: Partial<Record<CellValue, string>> | undefined = onPick
      ? undefined
      : { '0': t('works.leaderOnly'), X: t('works.leaderOnly'), ...(taskNext ? {} : { '1': t('works.noTask') }) };
    return (
      <td className="border-b border-r p-0.5 text-center">
        <CellMenu
          current={cell.state === 'done' ? '1' : cell.state === 'na' ? 'X' : '0'}
          className={cn('h-10', cell.raw ? 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-300' : TONE[cell.state])}
          symbol={cell.raw ? <span className="line-clamp-2 break-all px-1 text-[11px] font-medium">{cell.raw}</span> : <span className="text-sm font-semibold">{SYM[cell.state]}</span>}
          labels={{ '1': t('works.legend.done'), '0': t('works.legend.open'), X: t('works.legend.na') }}
          title={cell.raw ? t('works.rawHint', { raw: cell.raw }) : onPick ? t('works.cellHint') : title}
          label={`${label}: ${t(`works.legend.${cell.state}`)}. ${onPick ? t('works.cellHint') : title}`}
          busy={busy}
          onPick={pick}
          locked={locked}
          onOpenTask={cell.taskId ? () => onOpenTask(cell.taskId!) : undefined}
        />
      </td>
    );
  }

  return (
    <td className="group/cell relative border-b border-r p-0.5 text-center">
      <button
        className={cn(
          'flex h-10 w-full items-center justify-center rounded leading-tight transition-colors disabled:cursor-default',
          // Fayldagi tanilmagan qiymat: boricha, sariq (rahbar oyni kiritguncha)
          cell.raw ? 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-300' : TONE[cell.state],
          busy && 'opacity-60',
        )}
        disabled={!next || busy}
        title={title}
        aria-label={`${label}: ${t(`works.legend.${cell.state}`)}. ${title}`}
        onClick={() => next && onAdvance(next)}
        onContextMenu={(e) => {
          if (!cell.taskId) return;
          e.preventDefault();
          onOpenTask(cell.taskId);
        }}
      >
        {cell.raw ? (
          <span className="line-clamp-2 break-all px-1 text-[11px] font-medium">{cell.raw}</span>
        ) : (
          <span className="text-sm font-semibold">{SYM[cell.state]}</span>
        )}
      </button>
      {onEdit && (
        <button
          className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded bg-white/90 text-brand-500 shadow-sm hover:text-ink focus-visible:flex group-hover/cell:flex [@media(hover:none)]:flex dark:bg-gray-900/80 dark:text-brand-400"
          onClick={onEdit}
          title={t('works.editBaseline')}
          aria-label={`${label} — ${t('works.editBaseline')}`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </td>
  );
}

/** Rahbar: CRM'gacha qaysi oygacha bajarilgan ("Бухгалтер ишлари" faylidagi sana) */
function BaselineDialog({ row, col, colName, onClose }: { row: WorksRow; col: WorkColumn; colName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const months = t('months', { returnObjects: true }) as string[];
  const cell = row.cells[col.routineTypeId];
  const [month, setMonth] = useState(cell?.baseline ?? '');
  const save = useMutation({
    mutationFn: () => api.put(`/works/${row.clientId}/${col.routineTypeId}/baseline`, { month: month || null }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['works'] });
      void qc.invalidateQueries({ queryKey: ['client', row.clientId] });
      onClose();
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('works.baselineTitle', { work: colName, client: row.name })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={month === (cell?.baseline ?? '') && !cell?.raw}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {cell?.raw && <p className="rounded bg-amber-50 px-2 py-1.5 text-sm text-amber-800">{t('works.rawHint', { raw: cell.raw })}</p>}
        <p className="text-sm text-gray-600">
          {t('works.current')}: <span className="font-semibold text-ink">{cell?.baseline ? monthLabel(cell.baseline, months) : t('works.notYet')}</span>
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{t('works.baselineLabel')}</span>
          <MonthPicker value={month} onChange={setMonth} clearable aria-label={t('works.baselineLabel')} />
        </label>
        <p className="text-xs text-gray-500">{t('works.baselineHint')}</p>
      </div>
    </Dialog>
  );
}

/**
 * my.mehnat.uz paroli: odatda yashirin; ko'zcha bosilganda serverdan ochiladi (har ochish audit_log'da).
 * Ochiq qiymat faqat shu komponent holatida turadi, kesh/so'rovlar ro'yxatiga tushmaydi.
 */

/**
 * Mijoz maydonlari (Javobgar | Oylik to'lov | ulush | Bank-klyuch | my.mehnat.uz) jadvalda katak ichida tahrirlanadi.
 * Buxgalterga server ruxsat bergan maydonlar: bank-klyuch, xodim soni, sana, login, parol; ulush hisoblanadi.
 * `open` = false: Javobgardan keyingilari yonga surilib yig'iladi (`Slide`).
 */
function ClientFieldTds({ row: r, isLeader, accountants, open }: { row: WorksRow; isLeader: boolean; accountants: { value: string; label: string }[]; open: boolean }) {
  const { t } = useTranslation();
  const save = useClientPatch(r.clientId);
  const P = 'border-b border-r p-0.5 text-xs';
  return (
    <>
      <td className={cn(P, 'min-w-[150px]')}>
        <SelectCell
          value={r.accountantId ? String(r.accountantId) : ''}
          options={accountants}
          onChange={(v) => save.mutate({ accountantId: v ? Number(v) : null })}
          readOnly={!isLeader}
          display={r.accountantName ?? <span className="text-gray-400">{t('clients.noAccountant')}</span>}
          label={`${r.name} — ${t('works.accountant')}`}
        />
      </td>
      {isLeader && (
        <td className={cn(P, slideCls(open))}>
          <Slide open={open} w={INFO_W.fee} className="p-0.5">
            <EditableTextCell
              value={r.monthlyFee ?? null}
              display={fmtMoney(r.monthlyFee)}
              parse={parseIntCell(1_000_000_000_000)}
              format={formatIntCell}
              onSave={(v) => save.mutate({ monthlyFee: v })}
              inputMode="numeric"
              className="justify-end text-right tabular-nums"
              label={`${r.name} — ${t('works.fee')}`}
            />
          </Slide>
        </td>
      )}
      <td className={cn(TD, slideCls(open))}>
        <Slide open={open} w={INFO_W.share} className="px-2 text-right tabular-nums">{fmtMoney(r.accountantShare)}</Slide>
      </td>
      <td className={cn(P, slideCls(open))}>
        <Slide open={open} w={INFO_W.bankKey} className="p-0.5 text-center">
          <SelectCell
            value={r.bankKey == null ? '' : r.bankKey ? 'yes' : 'no'}
            options={[{ value: 'yes', label: t('works.bankYes') }, { value: 'no', label: t('works.bankNo') }]}
            onChange={(v) => save.mutate({ bankKey: v === '' ? null : v === 'yes' })}
            label={`${r.name} — ${t('works.bankKey')}`}
          />
        </Slide>
      </td>
      <td className={cn(P, slideCls(open))}>
        <Slide open={open} w={INFO_W.employees} className="p-0.5">
          <EditableTextCell
            value={r.employeeCount ?? null}
            parse={parseIntCell(100_000)}
            format={formatIntCell}
            onSave={(v) => save.mutate({ employeeCount: v })}
            inputMode="numeric"
            className="justify-center text-center tabular-nums"
            label={`${r.name} — ${t('works.employees')}`}
          />
        </Slide>
      </td>
      <td className={cn(P, slideCls(open))}>
        <Slide open={open} w={INFO_W.checkedAt} className="p-0.5">
          <DateCell value={r.mehnatCheckedAt ?? ''} onChange={(v) => save.mutate({ mehnatCheckedAt: v || null })} label={`${r.name} — ${t('works.checkedAt')}`} />
        </Slide>
      </td>
      <td className={cn(P, slideCls(open))}>
        <Slide open={open} w={INFO_W.login} className="p-0.5">
          <EditableTextCell
            value={r.mehnatLogin ?? null}
            parse={parseTextCell}
            onSave={(v) => save.mutate({ mehnatLogin: v })}
            mono
            label={`${r.name} — ${t('works.login')}`}
          />
        </Slide>
      </td>
      <td className={cn(P, slideCls(open))}>
        <Slide open={open} w={INFO_W.password} className="p-0.5">
          <PasswordCell clientId={r.clientId} label={r.name} hasPassword={r.hasMehnatPassword} onSave={(pw) => save.mutate({ mehnatPassword: pw })} />
        </Slide>
      </td>
    </>
  );
}
