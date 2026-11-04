import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAccountants } from '@/hooks/tasks';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { type ClientStatus, type Lead, TAX_TYPE_OPTIONS, type TaxType } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { DatePicker } from './ui/date-picker';
import { Field, Input, PhoneInput, Textarea } from './ui/input';
import { Select } from './ui/select';

const empty = { stir: '', name: '', contactPerson: '', phone: '', taxType: 'AOS' as TaxType, taxTypeEffectiveFrom: '', accountantId: '', status: 'ACTIVE' as ClientStatus, note: '' };

/**
 * Yangi mijoz (faqat rahbar): alohida sahifa emas, jadval ustidagi modal.
 * section — qaysi sahifadan: mijoz faqat o'sha bo'limga tushadi (shu STIR boshqa bo'limda bo'lsa — o'sha mijoz qo'shiladi).
 * onCreated berilsa (Hisobot topshirish: detail sahifa yo'q) — jadvalda qoladi, aks holda mijoz kartasiga o'tadi.
 * lead berilsa — operator topgan firmani mijozga aylantirish: forma uning ma'lumotlari bilan to'ldiriladi.
 */
export function NewClientDialog({
  open,
  onClose,
  lead,
  section,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  lead?: Lead | null;
  section?: 'REPORTS' | 'WORKS';
  onCreated?: (c: { id: number; stir: string }) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accountants = useAccountants();
  const [form, setForm] = useState(empty);
  const set = (patch: Partial<typeof empty>) => setForm({ ...form, ...patch });

  useEffect(() => {
    if (open) setForm(lead ? { ...empty, stir: lead.stir, name: lead.name, contactPerson: lead.director ?? '', phone: lead.phone ?? '' } : empty);
  }, [open, lead]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id?: number; clientId?: number; joined?: boolean }>(lead ? `/leads/${lead.id}/convert` : '/clients', {
        ...(!lead && section && { section }),
        stir: form.stir,
        name: form.name,
        contactPerson: form.contactPerson || null,
        phone: form.phone || null,
        taxType: form.taxType,
        accountantId: form.accountantId ? Number(form.accountantId) : null,
        status: form.status,
        note: form.note || null,
        ...(form.taxTypeEffectiveFrom && { taxTypeEffectiveFrom: form.taxTypeEffectiveFrom }),
      }),
    onSuccess: (c) => {
      // Shu STIR boshqa bo'limda bor edi: yangi mijoz emas, o'sha mijoz shu bo'limga qo'shildi
      toast.success(c.joined ? t('clients.joinedSection') : t('common.saved'));
      for (const key of ['clients', 'leads', 'grid', 'works']) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
      const id = (c.clientId ?? c.id)!;
      if (onCreated) onCreated({ id, stir: form.stir });
      else navigate(`/clients/${id}`);
    },
    onError: (e) => toast.error(errorText(e, t)),
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
          <Button type="submit" form="new-client" disabled={create.isPending}>{t('common.create')}</Button>
        </>
      }
    >
      <form
        id="new-client"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label={t('clients.stir')} htmlFor="nc-stir"><Input id="nc-stir" required inputMode="numeric" value={form.stir} onChange={(e) => set({ stir: e.target.value })} /></Field>
        <Field label={t('clients.name')} htmlFor="nc-name"><Input id="nc-name" required value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={t('clients.contact')} htmlFor="nc-contact"><Input id="nc-contact" value={form.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} /></Field>
        <Field label={t('clients.phone')} htmlFor="nc-phone" hint={t('clients.phoneHint')}><PhoneInput id="nc-phone" value={form.phone} onChange={(v) => set({ phone: v })} /></Field>
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
      </form>
    </Dialog>
  );
}
