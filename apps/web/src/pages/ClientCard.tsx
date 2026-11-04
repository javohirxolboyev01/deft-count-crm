import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ClientReportCards } from '@/components/ClientReportCards';
import { ClientReviewBanner, clientNeeds } from '@/components/SheetImport';
import { TaskStatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input, NumberInput, PhoneInput, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { FormSkeleton, ListSkeleton } from '@/components/ui/skeleton';
import { invalidateTasks, taskTitle, taskTone, useAccountants } from '@/hooks/tasks';
import { useOpenTask } from '@/hooks/outlet';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { currentMonth, fmtDate, fmtShortDue } from '@/lib/time';
import { CLIENT_STATUSES, type ClientCard as ClientCardData, type ClientStatus, TAX_TYPE_OPTIONS, type Task, type TaxType, taxTypeLabel } from '@/lib/types';

interface Form {
  stir: string;
  name: string;
  contactPerson: string;
  phone: string;
  /** '': importda tanilmagan, hali tanlanmagan */
  taxType: TaxType | '';
  taxTypeEffectiveFrom: string;
  accountantId: string;
  status: ClientStatus;
  note: string;
  monthlyFee: string;
  bankKey: '' | 'yes' | 'no';
  employeeCount: string;
  mehnatCheckedAt: string;
  mehnatLogin: string;
  /** Yangi parol; bo'sh = o'zgarmaydi */
  mehnatPassword: string;
  clearPassword: boolean;
}

const empty: Form = {
  stir: '', name: '', contactPerson: '', phone: '', taxType: 'AOS', taxTypeEffectiveFrom: '', accountantId: '', status: 'ACTIVE', note: '',
  monthlyFee: '', bankKey: '', employeeCount: '', mehnatCheckedAt: '', mehnatLogin: '', mehnatPassword: '', clearPassword: false,
};
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v.replace(/\D/g, '')));

function toForm(c: ClientCardData): Form {
  return {
    stir: c.stir ?? '',
    name: c.name,
    contactPerson: c.contactPerson ?? '',
    phone: c.phone ?? '',
    taxType: c.taxType ?? '',
    taxTypeEffectiveFrom: c.taxTypeEffectiveFrom ?? '',
    accountantId: c.accountantId ? String(c.accountantId) : '',
    status: c.status,
    note: c.note ?? '',
    monthlyFee: c.monthlyFee == null ? '' : String(c.monthlyFee),
    bankKey: c.bankKey == null ? '' : c.bankKey ? 'yes' : 'no',
    employeeCount: c.employeeCount == null ? '' : String(c.employeeCount),
    mehnatCheckedAt: c.mehnatCheckedAt ?? '',
    mehnatLogin: c.mehnatLogin ?? '',
    mehnatPassword: '',
    clearPassword: false,
  };
}

export default function ClientCard() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { isLeader } = useAuth();
  const qc = useQueryClient();
  const openTask = useOpenTask();
  const accountants = useAccountants();
  const [form, setForm] = useState<Form>(empty);
  const [confirmTax, setConfirmTax] = useState(false);

  const q = useQuery({ queryKey: ['client', id], queryFn: () => api.get<ClientCardData>(`/clients/${id}`) });
  const tasks = useQuery({ queryKey: ['tasks', 'client', id], queryFn: () => api.get<Task[]>(`/tasks${qs({ clientId: id, month: currentMonth() })}`) });
  useEffect(() => {
    if (q.data) setForm(toForm(q.data));
  }, [q.data]);

  const onErr = (e: unknown) => toast.error(errorText(e, t));
  const refresh = () => {
    invalidateTasks(qc);
    void qc.invalidateQueries({ queryKey: ['client', id] });
  };

  const payload = () => {
    const body: Record<string, unknown> = {
      contactPerson: form.contactPerson || null,
      phone: form.phone || null,
      note: form.note || null,
      bankKey: form.bankKey === '' ? null : form.bankKey === 'yes',
      employeeCount: numOrNull(form.employeeCount),
      mehnatCheckedAt: form.mehnatCheckedAt || null,
      mehnatLogin: form.mehnatLogin || null,
    };
    // Parol faqat yozilganda yuboriladi (bo'sh satr = o'chirish)
    if (form.mehnatPassword) body.mehnatPassword = form.mehnatPassword;
    else if (form.clearPassword) body.mehnatPassword = '';
    if (isLeader) {
      Object.assign(body, {
        // Karta to'liq saqlandi: "tekshiring" kamchiliklari ham yopiladi (V28)
        reviewed: true,
        // STIR'siz mijoz (V26): bo'sh qoldirilsa yuborilmaydi
        ...(form.stir && { stir: form.stir }),
        name: form.name,
        ...(form.taxType && { taxType: form.taxType }),
        accountantId: form.accountantId ? Number(form.accountantId) : null,
        status: form.status,
        monthlyFee: numOrNull(form.monthlyFee),
      });
      if (form.taxTypeEffectiveFrom && form.taxTypeEffectiveFrom !== q.data?.taxTypeEffectiveFrom) body.taxTypeEffectiveFrom = form.taxTypeEffectiveFrom;
    }
    return body;
  };

  const save = useMutation({
    mutationFn: () => api.patch<ClientCardData>(`/clients/${id}`, payload()),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setConfirmTax(false);
      refresh();
      void qc.invalidateQueries({ queryKey: ['sheets', 'review'] });
    },
    onError: onErr,
  });
  // Birinchi marta tanlash (aniqlanmagan tur) tasdiqsiz: o'zgaradigan eski tur yo'q
  const taxChanged = q.data?.taxType && (form.taxType !== q.data.taxType || (form.taxTypeEffectiveFrom || '') !== (q.data.taxTypeEffectiveFrom ?? ''));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (taxChanged) setConfirmTax(true);
    else save.mutate();
  };
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const ro = !isLeader; // buxgalter: aloqa, izoh, bank-kalit va my.mehnat.uz

  const content = (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title={t('clients.card')} />
        <form onSubmit={submit} className="grid gap-4 p-4 sm:grid-cols-2">
          <Field
            label={t('clients.stir')}
            htmlFor="stir"
            hint={!q.data?.stir ? `${q.data?.stirRaw ? t('clients.taxFromFile', { raw: q.data.stirRaw }) + '. ' : ''}${t('clients.stirMissing')}` : undefined}
          >
            <Input id="stir" required={!!q.data?.stir} inputMode="numeric" value={form.stir} disabled={ro} onChange={(e) => set({ stir: e.target.value })} />
          </Field>
          <Field label={t('clients.name')} htmlFor="name"><Input id="name" required value={form.name} disabled={ro} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label={t('clients.contact')} htmlFor="contact"><Input id="contact" value={form.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} /></Field>
          <Field label={t('clients.phone')} htmlFor="phone" hint={t('clients.phoneHint')}><PhoneInput id="phone" value={form.phone} onChange={(v) => set({ phone: v })} /></Field>
          <Field
            label={t('clients.taxType')}
            htmlFor="tax"
            hint={!q.data?.taxType ? `${q.data?.taxTypeRaw ? t('clients.taxFromFile', { raw: q.data.taxTypeRaw }) + '. ' : ''}${t('clients.taxNoneHint')}` : ro ? t('clients.taxLeaderOnly') : undefined}
          >
            <Select id="tax" value={form.taxType} disabled={ro} placeholder={t('clients.chooseTax')} onChange={(v) => set({ taxType: v as TaxType })} options={TAX_TYPE_OPTIONS} />
          </Field>
          <Field label={t('clients.effectiveFrom')} htmlFor="eff" hint={t('clients.effectiveFromHint')}>
            <DatePicker id="eff" value={form.taxTypeEffectiveFrom} disabled={ro} onChange={(v) => set({ taxTypeEffectiveFrom: v })} />
          </Field>
          <Field label={t('clients.accountant')} htmlFor="acc">
            <Select
              id="acc"
              value={form.accountantId}
              disabled={ro}
              onChange={(v) => set({ accountantId: v })}
              placeholder={t('clients.noAccountant')}
              clearable
              options={accountants.data?.map((a) => ({ value: String(a.id), label: `${a.fullName} (${t('urgent.load', { count: a.openCount })})` })) ?? []}
            />
          </Field>
          <Field label={t('clients.status')} htmlFor="status">
            <Select id="status" value={form.status} disabled={ro} onChange={(v) => set({ status: v as ClientStatus })} options={CLIENT_STATUSES.map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('clients.note')} htmlFor="note"><Textarea id="note" value={form.note} onChange={(e) => set({ note: e.target.value })} /></Field>
          </div>
          {/* "Бухгалтер ишлари" fayli ustunlari */}
          <h3 className="border-t pt-4 text-sm font-semibold text-ink sm:col-span-2">{t('clients.sheetSection')}</h3>
          {isLeader ? (
            <Field label={t('clients.monthlyFee')} htmlFor="fee">
              <NumberInput id="fee" value={form.monthlyFee} onChange={(v) => set({ monthlyFee: v })} />
            </Field>
          ) : (
            <Field label={t('clients.accountantShare')} htmlFor="share">
              <Input id="share" disabled value={q.data?.accountantShare?.toLocaleString('en-US') ?? ''} />
            </Field>
          )}
          <Field label={t('clients.bankKey')} htmlFor="bankKey">
            <Select
              id="bankKey"
              value={form.bankKey}
              onChange={(v) => set({ bankKey: v as Form['bankKey'] })}
              placeholder={t('clients.unknown')}
              clearable
              options={[{ value: 'yes', label: t('works.bankYes') }, { value: 'no', label: t('works.bankNo') }]}
            />
          </Field>
          <Field label={t('clients.employeeCount')} htmlFor="emp">
            <NumberInput id="emp" value={form.employeeCount} onChange={(v) => set({ employeeCount: v })} />
          </Field>
          <Field label={t('clients.mehnatCheckedAt')} htmlFor="mehnatAt">
            <DatePicker id="mehnatAt" value={form.mehnatCheckedAt} clearable onChange={(v) => set({ mehnatCheckedAt: v })} />
          </Field>
          <Field label={t('clients.mehnatLogin')} htmlFor="mehnatLogin">
            <Input id="mehnatLogin" autoComplete="off" value={form.mehnatLogin} onChange={(e) => set({ mehnatLogin: e.target.value })} />
          </Field>
          <Field label={t('clients.mehnatPassword')} htmlFor="mehnatPw" hint={q.data?.hasMehnatPassword && !form.clearPassword ? t('clients.mehnatPasswordSet') : t('clients.mehnatPasswordHint')}>
            <div className="flex gap-2">
              <Input
                id="mehnatPw"
                type="password"
                autoComplete="new-password"
                value={form.mehnatPassword}
                placeholder={q.data?.hasMehnatPassword && !form.clearPassword ? '••••••••' : ''}
                onChange={(e) => set({ mehnatPassword: e.target.value, clearPassword: false })}
              />
              {q.data?.hasMehnatPassword && !form.clearPassword && (
                <Button variant="outline" size="icon" title={t('clients.clearPassword')} aria-label={t('clients.clearPassword')} onClick={() => set({ mehnatPassword: '', clearPassword: true })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </Field>
          {q.data && form.accountantId !== String(q.data.accountantId ?? '') && (
            <p className="text-xs text-amber-700 sm:col-span-2">{t('clients.reassignHint')}</p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={save.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      </Card>

      {/* O'ng ustun: soliq turi tarixi va joriy oy vazifalari (holat bo'yicha hisobotlar va o'zgarishlar tarixi kartada yo'q) */}
      <div className="space-y-4">
        {q.data && <ClientReportCards client={q.data} isLeader={isLeader} />}
        <Card>
          <CardHeader title={t('clients.currentTasks')} />
          <QueryState q={tasks}>
            {!tasks.data?.length && <Empty />}
            <ul className="divide-y text-sm">
              {tasks.data?.map((task) => {
                const tone = taskTone(task);
                return (
                  <li key={task.id}>
                    {/* Tor ustun: 1-qator nom + holat, 2-qator muddat + mas'ul */}
                    <button className="w-full px-4 py-2 text-left hover:bg-gray-50" onClick={() => openTask(task.id)}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{taskTitle(task, i18n.language)}</span>
                        <TaskStatusBadge status={task.status} />
                      </div>
                      <div className="mt-0.5 flex gap-2 text-xs text-gray-500">
                        <span className={cn(tone === 'overdue' && 'text-overdue', tone === 'soon' && 'text-soon')}>{fmtShortDue(task.dueAt)}</span>
                        <span className="truncate">· {task.assigneeName ?? t('task.unassigned')}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </QueryState>
        </Card>
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader crumbs={[{ to: '/clients', label: t('nav.clients') }]} title={q.data?.name ?? '…'} />
      {isLeader && <ClientReviewBanner kind="WORKS" clientId={Number(id)} needs={q.data ? clientNeeds(q.data, t) : []} />}
      <QueryState
        q={q}
        skeleton={
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="rounded-md bg-white xl:col-span-2"><FormSkeleton fields={9} /></div>
            <div className="space-y-4">
              <div className="rounded-md bg-white"><ListSkeleton rows={2} /></div>
              <div className="rounded-md bg-white"><ListSkeleton rows={2} /></div>
            </div>
          </div>
        }
      >
        {content}
      </QueryState>
      <Dialog
        open={confirmTax}
        onClose={() => setConfirmTax(false)}
        title={t('clients.confirmTaxTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmTax(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>{t('common.confirm')}</Button>
          </>
        }
      >
        <p className="text-sm">{t('clients.confirmTaxBody', { from: taxTypeLabel(q.data?.taxType ?? ''), to: taxTypeLabel(form.taxType ?? ''), date: form.taxTypeEffectiveFrom ? fmtDate(form.taxTypeEffectiveFrom) : t('clients.thisMonth') })}</p>
      </Dialog>
    </div>
  );
}
