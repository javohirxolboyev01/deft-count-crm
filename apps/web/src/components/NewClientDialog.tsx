import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAccountants } from '@/hooks/tasks';
import { ApiError, api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { type ClientStatus, type Lead, TAX_TYPE_OPTIONS, type TaxType } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { DatePicker } from './ui/date-picker';
import { Field, Input, NameListInput, PhoneListInput, Textarea } from './ui/input';
import { Select } from './ui/select';
import { Switch } from './ui/switch';

const empty = { stir: '', name: '', contactPerson: '', phone: '', taxType: 'AOS' as TaxType, taxTypeEffectiveFrom: '', accountantId: '', status: 'ACTIVE' as ClientStatus, note: '', inWorks: false };

/**
 * Yangi mijoz (faqat rahbar, «Mijozlar» bo'limi): modal. V51: Hisobot topshirishda har doim, Buxgalter ishlarida —
 * "inWorks" almashtirgichi yoqilsa.
 * onCreated berilsa — ro'yxatda qoladi (toast'da kartani ochish tugmasi), aks holda mijoz kartasiga o'tadi.
 * lead berilsa — operator topgan firmani mijozga aylantirish: forma uning ma'lumotlari bilan to'ldiriladi.
 */
export function NewClientDialog({
  open,
  onClose,
  lead,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  lead?: Lead | null;
  onCreated?: (c: { id: number; stir: string }) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accountants = useAccountants();
  const [form, setForm] = useState(empty);
  const set = (patch: Partial<typeof empty>) => setForm({ ...form, ...patch });
  // STIR server qoidasi bilan bir xil (9 raqam, YaTT JShShIR — 14): yuborishdan oldin tekshiriladi, xato maydon ostida.
  // Xato yozish paytida emas — maydondan chiqqanda yoki "Yaratish" bosilganda ko'rsatiladi
  const stirRef = useRef<HTMLInputElement>(null);
  const [stirTouched, setStirTouched] = useState(false);
  const stirOk = /^(\d{9}|\d{14})$/.test(form.stir);
  const stirError = stirTouched && !stirOk ? t('clients.stirInvalid', { n: form.stir.length }) : undefined;

  useEffect(() => {
    if (!open) return;
    setForm(lead ? { ...empty, stir: lead.stir.replace(/\D/g, ''), name: lead.name, contactPerson: lead.director ?? '', phone: lead.phone ?? '' } : empty);
    setStirTouched(false);
  }, [open, lead]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id?: number; clientId?: number }>(lead ? `/leads/${lead.id}/convert` : '/clients', {
        stir: form.stir,
        name: form.name,
        contactPerson: form.contactPerson || null,
        phone: form.phone || null,
        taxType: form.taxType,
        accountantId: form.accountantId ? Number(form.accountantId) : null,
        status: form.status,
        note: form.note || null,
        inWorks: form.inWorks,
        ...(form.taxTypeEffectiveFrom && { taxTypeEffectiveFrom: form.taxTypeEffectiveFrom }),
      }),
    onSuccess: (c) => {
      for (const key of ['clients', 'leads', 'grid', 'works', 'dashboard']) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
      const id = (c.clientId ?? c.id)!;
      if (onCreated) {
        toast.success(t('clients.created'), { action: { label: t('clients.openCard'), onClick: () => navigate(`/clients/${id}`) } });
        onCreated({ id, stir: form.stir });
      } else {
        toast.success(t('common.saved'));
        navigate(`/clients/${id}`);
      }
    },
    onError: (e) => {
      // Shu STIR bilan mijoz bor: yangisi yaratilmaydi — o'shani ochish taklif qilinadi (shartnoma tugagan bo'lsa — qaytarish yo'li)
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        const d = e.details as { clientId: number; ended: boolean } | undefined;
        toast.error(t(d?.ended ? 'clients.duplicateEnded' : 'clients.duplicate'), {
          duration: 8000,
          ...(d?.clientId && { action: { label: t('clients.openCard'), onClick: () => navigate(`/clients/${d.clientId}`) } }),
        });
      } else toast.error(errorText(e, t));
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={lead ? t('leads.convertTitle', { name: lead.name }) : t('clients.new')}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="new-client" loading={create.isPending}>{t('common.create')}</Button>
        </>
      }
    >
      <form
        id="new-client"
        onSubmit={(e) => {
          e.preventDefault();
          if (!stirOk) {
            setStirTouched(true);
            stirRef.current?.focus();
            return;
          }
          create.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label={t('clients.stir')} htmlFor="nc-stir" hint={t('clients.stirHint')} error={stirError}>
          {/* Faqat raqam (bo'shliq, tire, nusxadagi boshqa belgilar tushib qoladi), 14 tagacha */}
          <Input
            ref={stirRef}
            id="nc-stir"
            required
            inputMode="numeric"
            autoComplete="off"
            maxLength={14}
            aria-invalid={!!stirError}
            value={form.stir}
            onChange={(e) => set({ stir: e.target.value.replace(/\D/g, '').slice(0, 14) })}
            onBlur={() => form.stir && setStirTouched(true)}
          />
        </Field>
        <Field label={t('clients.name')} htmlFor="nc-name"><Input id="nc-name" required value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={t('clients.contact')} htmlFor="nc-contact"><NameListInput id="nc-contact" value={form.contactPerson} onChange={(v) => set({ contactPerson: v })} addLabel={t('clients.addContact')} removeLabel={t('clients.removeContact')} /></Field>
        <Field label={t('clients.phone')} htmlFor="nc-phone" hint={t('clients.phoneHint')}><PhoneListInput id="nc-phone" value={form.phone} onChange={(v) => set({ phone: v })} addLabel={t('clients.addPhone')} removeLabel={t('clients.removePhone')} /></Field>
        <Field label={t('clients.taxType')} htmlFor="nc-tax">
          <Select id="nc-tax" value={form.taxType} onChange={(v) => set({ taxType: v as TaxType })} options={TAX_TYPE_OPTIONS} />
        </Field>
        <Field label={t('clients.effectiveFrom')} htmlFor="nc-eff" hint={t('clients.effectiveFromHint')}>
          <DatePicker id="nc-eff" value={form.taxTypeEffectiveFrom} onChange={(v) => set({ taxTypeEffectiveFrom: v })} />
        </Field>
        <Field label={t('clients.accountant')} htmlFor="nc-acc">
          <Select
            id="nc-acc"
            value={form.accountantId}
            onChange={(v) => set({ accountantId: v })}
            placeholder={t('clients.noAccountant')}
            clearable
            options={accountants.data?.map((a) => ({ value: String(a.id), label: `${a.fullName} (${t('urgent.load', { count: a.openCount })})` })) ?? []}
          />
        </Field>
        <Field label={t('clients.status')} htmlFor="nc-status">
          <Select id="nc-status" value={form.status} onChange={(v) => set({ status: v as ClientStatus })} options={(['ACTIVE', 'ZERO_REPORT', 'LIQUIDATING'] as const).map((s) => ({ value: s, label: t(`clientStatus.${s}`) }))} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('clients.note')} htmlFor="nc-note"><Textarea id="nc-note" value={form.note} onChange={(e) => set({ note: e.target.value })} /></Field>
        </div>
        {/* Bo'limlar (V51): Hisobot topshirishda har doim, Buxgalter ishlarida — rahbar tanlovi */}
        <div className="flex items-start gap-3 rounded-lg border border-brand-500/40 p-3 sm:col-span-2 dark:border-brand-800">
          <Switch checked={form.inWorks} onChange={(v) => set({ inWorks: v })} label={t('clients.inWorks')} />
          <button type="button" className="min-w-0 cursor-pointer text-left" onClick={() => set({ inWorks: !form.inWorks })}>
            <span className="block text-sm font-medium">{t('clients.inWorks')}</span>
            <span className="block text-xs text-gray-500">{t('clients.inWorksHint')}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
