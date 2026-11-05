import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Plus, Trash2, X as XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/input';
import { TimePicker } from '@/components/ui/date-picker';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { fmtDate } from '@/lib/time';
import type { ReportType, RoutineWork, UrgentTemplate } from '@/lib/types';

type Tab = 'reports' | 'routines' | 'templates' | 'general';
const MAX_ROUTINES = 10;

/** Tahrir -> "Saqlash" -> o'zgarishlar xulosasi -> tasdiqlash */
function useDraft<T extends { id: number }>(server: T[] | undefined) {
  const [draft, setDraft] = useState<T[]>([]);
  useEffect(() => setDraft(server ? structuredClone(server) : []), [server]);
  const changes = draft
    .map((d) => {
      const s = server?.find((x) => x.id === d.id);
      if (!s) return null;
      const fields = (Object.keys(d) as (keyof T)[]).filter((k) => JSON.stringify(d[k]) !== JSON.stringify(s[k]));
      return fields.length ? { row: d, before: s, fields } : null;
    })
    .filter((x): x is { row: T; before: T; fields: (keyof T)[] } => x !== null);
  const update = (id: number, patch: Partial<T>) => setDraft((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  return { draft, setDraft, changes, update, reset: () => setDraft(server ? structuredClone(server) : []) };
}

function Summary({ open, onClose, onConfirm, lines, busy }: { open: boolean; onClose: () => void; onConfirm: () => void; lines: string[]; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('settings.summaryTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={onConfirm} disabled={busy}>{t('common.confirm')}</Button>
        </>
      }
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <p className="mt-3 text-xs text-gray-500">{t('settings.summaryNote')}</p>
    </Dialog>
  );
}

const fmtVal = (v: unknown, t: (k: string) => string) =>
  v === true ? t('common.yes') : v === false ? t('common.no') : v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : String(v);

type Group = 'monthly' | 'event' | 'periodic';
const groupOf = (r: ReportType): Group => (r.requiresEventFlag ? 'event' : r.frequency === 'MONTHLY' ? 'monthly' : 'periodic');
const GROUPS: Group[] = ['monthly', 'event', 'periodic'];

/**
 * Hisobot turlari — rahbar uchun oddiy tilda: har hisobot qachon topshiriladi, kimlar topshiradi, buxgalterga
 * vazifa bo'lib chiqadimi, jadvalda ko'rinadimi. Texnik kodlar ko'rsatilmaydi. Hisobotlar uch guruhda (oylik,
 * holat bo'yicha, choraklik/yillik). Saqlashdan oldin o'zgarishlar oddiy gaplar bilan ko'rsatiladi.
 */
function ReportTypesTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'report-types'], queryFn: () => api.get<ReportType[]>('/settings/report-types') });
  const { draft, changes, update, reset } = useDraft(q.data);
  const [summary, setSummary] = useState(false);
  const save = useMutation({
    mutationFn: async () => {
      for (const c of changes) {
        const body: Record<string, unknown> = {};
        for (const f of c.fields) body[f as string] = c.row[f];
        await api.patch(`/settings/report-types/${c.row.id}`, body);
      }
    },
    onSuccess: () => {
      setSummary(false);
      toast.success(t('common.saved'));
      // Muddat kuni karta, vazifalar va jadvallarda ham ko'rinadi: hammasi yangilansin
      for (const key of ['settings', 'grid', 'client', 'tasks', 'works', 'dashboard']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const name = (r: ReportType) => (i18n.language === 'ru' ? r.nameRu : r.name);
  const months = t('months', { returnObjects: true }) as string[];
  // Xulosa oddiy gap bilan: "JShDS: muddat 15-sana → 20-sana"
  const say = (f: keyof ReportType, v: unknown) =>
    f === 'dueDay' ? (v ? t('settings.rt.dayN', { n: v }) : t('settings.rt.noDay'))
      : f === 'generationMonths' ? (Array.isArray(v) ? v.map((m) => months[m - 1]).join(', ') : '—')
        : fmtVal(v, t);
  const lines = changes.flatMap((c) =>
    c.fields.map((f) => `${name(c.row)}: ${t(`settings.rt.change.${String(f)}`)} — ${say(f, c.before[f])} → ${say(f, c.row[f])}`),
  );

  return (
    <Card>
      <CardHeader
        title={t('settings.reportTypes')}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!changes.length} onClick={reset}>{t('common.reset')}</Button>
            <Button size="sm" disabled={!changes.length} onClick={() => setSummary(true)}>{t('common.save')} {changes.length ? `(${changes.length})` : ''}</Button>
          </>
        }
      />
      {/* Sahifa nima uchun — 3 gapda */}
      <div className="mx-4 mb-3 rounded-lg border border-brand-200 bg-brand-light p-3 text-sm text-ink dark:border-brand-800">
        <div className="mb-1 font-semibold">{t('settings.rt.introTitle')}</div>
        <ul className="list-disc space-y-0.5 pl-5 text-gray-700">
          <li>{t('settings.rt.intro1')}</li>
          <li>{t('settings.rt.intro2')}</li>
          <li>{t('settings.rt.intro3')}</li>
        </ul>
      </div>
      <QueryState q={q} skeleton={<TableSkeleton rows={10} cols={5} />}>
        {!draft.length ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="min-w-[220px] px-3 py-2.5 text-left">{t('settings.rt.colReport')}</th>
                  <th className="min-w-[200px] px-3 py-2.5 text-left">{t('settings.rt.colDue')}</th>
                  <th className="min-w-[170px] px-3 py-2.5 text-left">{t('settings.rt.colWho')}</th>
                  <th className="min-w-[220px] px-3 py-2.5 text-left">{t('settings.rt.colTask')}</th>
                  <th className="min-w-[150px] px-3 py-2.5 text-left">{t('settings.rt.colShown')}</th>
                </tr>
              </thead>
              {GROUPS.map((g) => {
                const rows = draft.filter((r) => groupOf(r) === g);
                if (!rows.length) return null;
                return (
                  <tbody key={g}>
                    <tr>
                      <td colSpan={5} className="border-t bg-gray-50 px-3 py-2">
                        <div className="font-semibold text-ink">{t(`settings.rt.group.${g}`)}</div>
                        <div className="text-xs text-gray-500">{t(`settings.rt.groupHint.${g}`)}</div>
                      </td>
                    </tr>
                    {rows.map((r) => (
                      <ReportTypeRow key={r.id} r={r} name={name(r)} changed={changes.some((c) => c.row.id === r.id)} onChange={(patch) => update(r.id, patch)} />
                    ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </QueryState>
      <Summary open={summary} onClose={() => setSummary(false)} onConfirm={() => save.mutate()} lines={lines} busy={save.isPending} />
    </Card>
  );
}

function ReportTypeRow({ r, name, changed, onChange }: { r: ReportType; name: string; changed: boolean; onChange: (p: Partial<ReportType>) => void }) {
  const { t } = useTranslation();
  const months = t('months', { returnObjects: true }) as string[];
  const nobody = !r.appliesToAos && !r.appliesToQqs && !r.appliesToYatt;
  const pill = (on: boolean) =>
    cn(
      'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
      on ? 'border-brand-500 bg-brand-500 text-on-brand' : 'border-gray-300 bg-white text-gray-500 hover:border-brand-300',
    );
  return (
    <tr className={cn('border-t align-top', changed && 'bg-amber-50/60', !r.active && 'opacity-60')}>
      <td className="px-3 py-3">
        <div className="font-medium text-ink">{name}</div>
        <div className="mt-0.5 text-xs text-gray-500">
          {t(`settings.rt.freq.${r.frequency}`)}
          {r.requiresEventFlag && ` · ${t('settings.rt.eventNote')}`}
        </div>
      </td>
      <td className="px-3 py-3">
        {r.frequency === 'YEARLY' ? (
          // Yillik hisobotlarda muddat kuni yo'q (V16): katak har oy chiqadi, muddati o'tmaydi
          <span className="text-xs text-gray-500">{t('settings.rt.noDueYearly')}</span>
        ) : (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-gray-600">
              {t('settings.rt.dueBefore')}
              <Input
                type="number"
                min={1}
                max={31}
                className="h-8 w-16 text-center"
                value={r.dueDay ?? ''}
                placeholder="?"
                onChange={(e) => onChange({ dueDay: e.target.value ? Math.min(31, Math.max(1, Number(e.target.value))) : null })}
                aria-label={`${name} — ${t('settings.rt.colDue')}`}
              />
              {t('settings.rt.dueAfter')}
            </label>
            {r.dueDay == null && <div className="text-xs text-amber-700">{t('settings.rt.noDay')}</div>}
            {r.frequency === 'QUARTERLY' && (
              // Choraklik: qaysi oylarda topshiriladi — oy tugmalari (1,4,7,10 matni o'rniga)
              <div className="flex max-w-[260px] flex-wrap gap-1" aria-label={`${name} — ${t('settings.rt.months')}`}>
                {months.map((m, i) => {
                  const on = (r.generationMonths ?? []).includes(i + 1);
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={on}
                      className={cn('rounded px-1.5 py-0.5 text-[11px] capitalize', on ? 'bg-brand-500 text-on-brand' : 'bg-gray-100 text-gray-500')}
                      onClick={() => {
                        const next = on ? (r.generationMonths ?? []).filter((x) => x !== i + 1) : [...(r.generationMonths ?? []), i + 1].sort((a, b) => a - b);
                        if (next.length) onChange({ generationMonths: next });
                      }}
                    >
                      {m.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex gap-2">
          {(['appliesToAos', 'appliesToQqs', 'appliesToYatt'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={r[k]}
              className={pill(r[k])}
              title={t(`settings.rt.payer.${k}`)}
              aria-label={`${name} — ${t(`settings.rt.payer.${k}`)}`}
              onClick={() => onChange({ [k]: !r[k] })}
            >
              {r[k] ? <Check className="h-3.5 w-3.5" /> : <XIcon className="h-3.5 w-3.5" />}
              {k === 'appliesToAos' ? 'AOS' : k === 'appliesToQqs' ? 'QQS' : 'YaTT'}
            </button>
          ))}
        </div>
        {nobody && <div className="mt-1 text-xs text-amber-700">{t('settings.rt.nobody')}</div>}
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <Switch checked={r.createsAccountantTask} onChange={(v) => onChange({ createsAccountantTask: v })} label={`${name} — ${t('settings.rt.colTask')}`} />
          <span className="text-xs text-gray-600">{t(r.createsAccountantTask ? 'settings.rt.taskYes' : 'settings.rt.taskNo')}</span>
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <Switch checked={r.active} onChange={(v) => onChange({ active: v })} label={`${name} — ${t('settings.rt.colShown')}`} />
          <span className="text-xs text-gray-600">{t(r.active ? 'settings.rt.shownYes' : 'settings.rt.shownNo')}</span>
        </div>
      </td>
    </tr>
  );
}

function RoutinesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'routine-works'], queryFn: () => api.get<RoutineWork[]>('/settings/routine-works') });
  const { draft, setDraft, changes, update, reset } = useDraft(q.data);
  const [summary, setSummary] = useState(false);
  const [adding, setAdding] = useState({ open: false, name: '', nameRu: '' });
  const activeCount = draft.filter((d) => d.active).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings', 'routine-works'] });
  const onErr = (e: unknown) =>
    toast.error(e instanceof ApiError && e.code === 'ROUTINE_LIMIT' ? t('settings.routineLimit', { max: MAX_ROUTINES }) : errorText(e, t));

  const add = useMutation({
    mutationFn: () => api.post('/settings/routine-works', { name: adding.name, nameRu: adding.nameRu || undefined }),
    onSuccess: () => {
      setAdding({ open: false, name: '', nameRu: '' });
      toast.success(t('settings.routineAdded'));
      void refresh();
    },
    onError: onErr,
  });
  const orderChanged = JSON.stringify(draft.map((d) => d.id)) !== JSON.stringify(q.data?.map((d) => d.id));
  const save = useMutation({
    mutationFn: async () => {
      // Avval faolsizlantirish (limitdan joy bo'shasin), keyin qolganlari
      const sorted = [...changes].sort((a) => (a.row.active ? 1 : -1));
      for (const c of sorted) {
        const body: Record<string, unknown> = {};
        for (const f of c.fields) if (f !== 'sortOrder') body[f as string] = c.row[f];
        if (Object.keys(body).length) await api.patch(`/settings/routine-works/${c.row.id}`, body);
      }
      if (orderChanged) await api.put('/settings/routine-works/order', { ids: draft.map((d) => d.id) });
    },
    onSuccess: () => {
      setSummary(false);
      toast.success(t('common.saved'));
      void refresh();
    },
    onError: (e) => {
      onErr(e);
      void refresh();
    },
  });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next.map((d, idx) => ({ ...d, sortOrder: idx + 1 })));
  };
  const lines = [
    ...changes.flatMap((c) =>
      c.fields.filter((f) => f !== 'sortOrder').map((f) => `${c.before.name}: ${t(`settings.field.${String(f)}`)} — ${fmtVal(c.before[f], t)} → ${fmtVal(c.row[f], t)}`),
    ),
    ...(orderChanged ? [t('settings.orderChanged')] : []),
  ];

  return (
    <Card>
      <CardHeader
        title={`${t('settings.routineWorks')} (${activeCount}/${MAX_ROUTINES})`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => (activeCount >= MAX_ROUTINES ? onErr(new ApiError(409, 'ROUTINE_LIMIT', '')) : setAdding({ ...adding, open: true }))}>
              <Plus className="h-4 w-4" /> {t('settings.addRoutine')}
            </Button>
            <Button variant="outline" size="sm" disabled={!lines.length} onClick={reset}>{t('common.reset')}</Button>
            <Button size="sm" disabled={!lines.length} onClick={() => setSummary(true)}>{t('common.save')}</Button>
          </>
        }
      />
      <QueryState q={q}>
        {!draft.length && <Empty />}
        <ul className="divide-y">
          {draft.map((w, i) => (
            <li key={w.id} className={cn('flex flex-wrap items-center gap-2 px-4 py-2 text-sm', !w.active && 'opacity-50', changes.some((c) => c.row.id === w.id) && 'bg-amber-50')}>
              <span className="w-6 text-xs text-gray-400">{i + 1}</span>
              <Input className="h-8 min-w-[200px] flex-1" value={w.name} onChange={(e) => update(w.id, { name: e.target.value })} aria-label={t('common.name')} />
              <Input className="h-8 min-w-[160px] flex-1" value={w.nameRu} onChange={(e) => update(w.id, { nameRu: e.target.value })} aria-label={t('common.nameRu')} />
              {/* Muddat: ish oyidan keyingi oyda (buxgalteriya 1 oy orqada, V34). INPS — hisobot muddati (Hisobotlar bo'limi) */}
              {w.reportTypeId ? (
                <span className="text-xs text-gray-500">{t('settings.linkedReport')}</span>
              ) : (
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                  {t('settings.rt.dueBefore')}
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    className="h-8 w-16 text-center"
                    value={w.dueDay ?? ''}
                    placeholder="—"
                    onChange={(e) => update(w.id, { dueDay: e.target.value ? Math.min(31, Math.max(1, Number(e.target.value))) : null })}
                    aria-label={`${w.name} — ${t('settings.field.dueDay')}`}
                    title={t('settings.routineDueHint')}
                  />
                  {t('settings.rt.dueAfter')}
                </label>
              )}
              {w.isFreeText && <span className="text-xs text-gray-500">{t('settings.freeText')}</span>}
              {w.effectiveFrom > new Date().toISOString().slice(0, 10) && <span className="text-xs text-blue-700">{t('settings.fromDate', { date: fmtDate(w.effectiveFrom) })}</span>}
              <Button variant="ghost" size="icon" onClick={() => move(i, -1)} aria-label={t('settings.moveUp')}><ArrowUp className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" onClick={() => move(i, 1)} aria-label={t('settings.moveDown')}><ArrowDown className="h-4 w-4" /></Button>
              <Checkbox
                label={t('settings.field.active')}
                checked={w.active}
                onChange={(v) => {
                  if (v && activeCount >= MAX_ROUTINES) return onErr(new ApiError(409, 'ROUTINE_LIMIT', ''));
                  update(w.id, { active: v });
                }}
              />
            </li>
          ))}
        </ul>
        <p className="px-4 py-3 text-xs text-gray-500">{t('settings.routinesHint')}</p>
      </QueryState>
      <Summary open={summary} onClose={() => setSummary(false)} onConfirm={() => save.mutate()} lines={lines} busy={save.isPending} />
      <Dialog
        open={adding.open}
        onClose={() => setAdding({ ...adding, open: false })}
        title={t('settings.addRoutine')}
        footer={<Button disabled={!adding.name.trim() || add.isPending} onClick={() => add.mutate()}>{t('common.add')}</Button>}
      >
        <div className="space-y-3">
          <Field label={t('common.name')}><Input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></Field>
          <Field label={t('common.nameRu')}><Input value={adding.nameRu} onChange={(e) => setAdding({ ...adding, nameRu: e.target.value })} /></Field>
          <p className="text-xs text-gray-500">{t('settings.nextMonthHint')}</p>
        </div>
      </Dialog>
    </Card>
  );
}

function TemplatesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'templates'], queryFn: () => api.get<UrgentTemplate[]>('/settings/urgent-templates') });
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings', 'templates'] });
  const onErr = (e: unknown) => toast.error(errorText(e, t));
  const add = useMutation({ mutationFn: () => api.post('/settings/urgent-templates', { text }), onSuccess: () => { setText(''); void refresh(); }, onError: onErr });
  const upd = useMutation({ mutationFn: (p: { id: string; text: string }) => api.patch(`/settings/urgent-templates/${p.id}`, { text: p.text }), onSuccess: () => { toast.success(t('common.saved')); void refresh(); }, onError: onErr });
  const [removing, setRemoving] = useState<UrgentTemplate | null>(null);
  const del = useMutation({ mutationFn: (id: string) => api.del(`/settings/urgent-templates/${id}`), onSuccess: () => { setRemoving(null); void refresh(); }, onError: onErr });
  return (
    <Card>
      <CardHeader title={t('settings.templates')} />
      <QueryState q={q}>
        {!q.data?.length && <Empty />}
        <ul className="divide-y">
          {q.data?.map((tpl) => (
            <li key={tpl.id} className="flex items-center gap-2 px-4 py-2">
              <Input value={edit[tpl.id] ?? tpl.text} onChange={(e) => setEdit({ ...edit, [tpl.id]: e.target.value })} aria-label={t('settings.templateText')} />
              <Button size="sm" variant="outline" disabled={(edit[tpl.id] ?? tpl.text) === tpl.text} onClick={() => upd.mutate({ id: tpl.id, text: edit[tpl.id] })}>{t('common.save')}</Button>
              <Button size="icon" variant="ghost" onClick={() => setRemoving(tpl)} aria-label={t('common.delete')}><Trash2 className="h-4 w-4 text-red-600" /></Button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2 border-t p-4" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('settings.newTemplate')} />
          <Button type="submit" disabled={!text.trim()}><Plus className="h-4 w-4" /> {t('common.add')}</Button>
        </form>
      </QueryState>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && del.mutate(removing.id)}
        loading={del.isPending}
        text={removing?.text}
      />
    </Card>
  );
}

type ReminderStep = { fromDay: number; everyDays: number };
type OverdueReminder = { enabled: boolean; sendAt: string; steps: ReminderStep[]; previewDays?: number[] };

/** Backend overdueReminder.isReminderDay bilan bir xil: tahrir paytida kunlarni darhol ko'rsatish uchun */
function previewDays(steps: ReminderStep[], maxDay = 60) {
  const valid = steps.filter((s) => s.fromDay >= 1 && s.everyDays >= 1);
  const out: number[] = [];
  for (let d = 1; d <= maxDay; d++) {
    const step = valid.filter((s) => s.fromDay <= d).sort((a, b) => b.fromDay - a.fromDay)[0];
    if (step && (d - step.fromDay) % step.everyDays === 0) out.push(d);
  }
  return out;
}

function OverdueReminderCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'overdue-reminder'], queryFn: () => api.get<OverdueReminder>('/settings/overdue-reminder') });
  const [draft, setDraft] = useState<OverdueReminder | null>(null);
  useEffect(() => setDraft(q.data ? structuredClone({ enabled: q.data.enabled, sendAt: q.data.sendAt, steps: q.data.steps }) : null), [q.data]);
  const save = useMutation({
    mutationFn: (body: OverdueReminder) => api.put('/settings/overdue-reminder', body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['settings', 'overdue-reminder'] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  if (!draft) return null;

  const setStep = (i: number, patch: Partial<ReminderStep>) => setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const num = (v: string) => Number(v.replace(/\D/g, '').slice(0, 3)) || 0;
  const fromDays = draft.steps.map((s) => s.fromDay);
  const valid =
    /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.sendAt) &&
    draft.steps.length > 0 &&
    draft.steps.every((s) => s.fromDay >= 1 && s.everyDays >= 1) &&
    new Set(fromDays).size === fromDays.length;
  const server = q.data && { enabled: q.data.enabled, sendAt: q.data.sendAt, steps: q.data.steps };
  const changed = JSON.stringify(draft) !== JSON.stringify(server);
  const days = previewDays(draft.steps);

  return (
    <Card>
      <CardHeader title={t('settings.overdueReminder')} />
      <div className="space-y-4 p-4 text-sm">
        <p className="text-gray-600">{t('settings.overdueReminderHint')}</p>
        <div className="flex flex-wrap items-end gap-6">
          <Checkbox label={t('settings.overdueEnabled')} checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
          <Field label={t('settings.overdueSendAt')}>
            <TimePicker value={draft.sendAt} onChange={(v) => setDraft({ ...draft, sendAt: v })} />
          </Field>
        </div>
        <div className="space-y-2">
          {draft.steps.map((s, i) => (
            <div key={i} className="flex items-end gap-3">
              <Field label={t('settings.overdueFromDay')}>
                <Input inputMode="numeric" className="w-28" value={s.fromDay || ''} onChange={(e) => setStep(i, { fromDay: num(e.target.value) })} />
              </Field>
              <Field label={t('settings.overdueEveryDays')}>
                <Input inputMode="numeric" className="w-28" value={s.everyDays || ''} onChange={(e) => setStep(i, { everyDays: num(e.target.value) })} />
              </Field>
              <Button
                size="icon"
                variant="ghost"
                disabled={draft.steps.length === 1}
                onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
                aria-label={t('common.delete')}
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>
            </div>
          ))}
          {draft.steps.length < 10 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft({ ...draft, steps: [...draft.steps, { fromDay: Math.max(0, ...fromDays) + 7, everyDays: 7 }] })}
            >
              <Plus className="h-4 w-4" /> {t('settings.overdueAddStep')}
            </Button>
          )}
        </div>
        <div>
          <p className="mb-1 text-gray-600">{t('settings.overduePreview')}:</p>
          <p className="font-medium text-foreground">
            {days.length ? `${days.join(', ')} … ${t('settings.overdueDaysUnit')}` : '—'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button disabled={!valid || !changed} loading={save.isPending} onClick={() => save.mutate(draft)}>{t('common.save')}</Button>
          {changed && <Button variant="outline" onClick={() => server && setDraft(structuredClone(server))}>{t('common.reset')}</Button>}
        </div>
      </div>
    </Card>
  );
}

function GeneralTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'general'], queryFn: () => api.get<{ taskDueTime: string; accountantSharePercent: number }>('/settings/general') });
  const [time, setTime] = useState('');
  const [pct, setPct] = useState('');
  useEffect(() => {
    setTime(q.data?.taskDueTime ?? '');
    setPct(q.data ? String(q.data.accountantSharePercent) : '');
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: { taskDueTime?: string; accountantSharePercent?: number }) => api.put('/settings/general', body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['settings', 'general'] });
      void qc.invalidateQueries({ queryKey: ['works'] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
  const genDry = useMutation({ mutationFn: () => api.post<any>('/generator/run?dryRun=true'), onError: (e) => toast.error(errorText(e, t)) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('settings.general')} />
        <div className="flex items-end gap-3 p-4">
          <Field label={t('settings.dueTime')} hint={t('settings.dueTimeHint')}><TimePicker value={time} onChange={setTime} /></Field>
          <Button disabled={!time || time === q.data?.taskDueTime} onClick={() => save.mutate({ taskDueTime: time })}>{t('common.save')}</Button>
        </div>
        <div className="flex items-end gap-3 border-t p-4">
          <Field label={t('settings.sharePercent')} hint={t('settings.sharePercentHint')}>
            <Input inputMode="decimal" className="w-28" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <Button
            disabled={pct === '' || Number(pct) > 100 || Number(pct) === q.data?.accountantSharePercent}
            onClick={() => save.mutate({ accountantSharePercent: Number(pct) })}
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
      <OverdueReminderCard />
      <Card>
        <CardHeader title={t('settings.generator')} actions={<Button size="sm" variant="outline" onClick={() => genDry.mutate()}>{t('settings.generatorDryRun')}</Button>} />
        <div className="p-4 text-sm">
          <p className="text-gray-600">{t('settings.generatorHint')}</p>
          {genDry.data && (
            <p className="mt-2">{t('settings.generatorResult', { created: genDry.data.created, reports: genDry.data.reports, routines: genDry.data.routines, reopened: genDry.data.reopened })}</p>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function Settings() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('reports');
  const tabs: Tab[] = ['reports', 'routines', 'templates', 'general'];
  return (
    <div>
      <PageHeader title={t('settings.title')} />
      <div className="section-container mb-2 flex flex-wrap gap-1 py-1.5" role="tablist">
        {tabs.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)} className={cn('relative cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors', tab === x ? 'border-button text-brand' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
            {t(`settings.tab.${x}`)}
          </button>
        ))}
      </div>
      {tab === 'reports' && <ReportTypesTab />}
      {tab === 'routines' && <RoutinesTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'general' && <GeneralTab />}
    </div>
  );
}
