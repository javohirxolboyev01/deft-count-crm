import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Empty } from '@/components/ui/states';
import { invalidateTasks } from '@/hooks/tasks';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { currentMonth, fmtDate, monthLabel, shiftMonth } from '@/lib/time';
import type { ClientCard } from '@/lib/types';

/**
 * Mijozning hisobotga oid kartalari: soliq turi tarixi, holat bo'yicha hisobotlar (dividend, norezident) va
 * doimiy "X" istisnolari. Mijoz kartasi (Buxgalter ishlari) va Hisobot topshirish detail sahifasida bir xil.
 */
export function ClientReportCards({ client, isLeader }: { client: ClientCard; isLeader: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const id = client.id;
  const onErr = (e: unknown) => toast.error(errorText(e, t));
  const refresh = () => {
    invalidateTasks(qc);
    void qc.invalidateQueries({ queryKey: ['client', String(id)] });
  };
  const eventMark = useMutation({
    mutationFn: (p: { reportTypeId: number; month: string; on: boolean }) => {
      const url = `/clients/${id}/events/${p.reportTypeId}/${p.month}`;
      return p.on ? api.put(url) : api.del(url);
    },
    onSuccess: refresh,
    onError: onErr,
  });
  const include = useMutation({
    mutationFn: (reportTypeId: number) => api.del(`/clients/${id}/report-exclusions/${reportTypeId}`),
    onSuccess: refresh,
    onError: onErr,
  });

  const thisMonth = currentMonth();
  const months = t('months', { returnObjects: true }) as string[];
  // Holat belgisi faqat o'tgan va joriy oy uchun (server ham tekshiradi)
  const eventMonths = [shiftMonth(thisMonth, -1), thisMonth];
  // Bazada holat oyi saqlanadi, kartada esa topshirish oyi (holat oyi + 1) ko'rsatiladi: "Hisobot topshirish"
  // sahifasi va Excel fayl ham topshirish oyi bo'yicha — buxgalter bitta oy bilan ishlaydi.
  const filingLabel = (eventMonth: string, dueDay: number | null) => {
    const m = shiftMonth(eventMonth, 1);
    if (!dueDay) return monthLabel(m, months);
    const [y, mo] = m.split('-').map(Number);
    const day = Math.min(dueDay, new Date(y, mo, 0).getDate());
    return t('clients.filingDue', { month: monthLabel(m, months), date: `${String(day).padStart(2, '0')}.${String(mo).padStart(2, '0')}` });
  };
  const events = client.events?.filter((e) => e.applicable) ?? [];

  return (
    <>
      <Card>
        <CardHeader title={t('clients.taxHistory')} />
        {!client.taxHistory?.length && <Empty />}
        <ul className="divide-y text-sm">
          {client.taxHistory?.map((h) => (
            <li key={h.id} className="flex justify-between px-4 py-2">
              <span><b>{h.taxType}</b> · {h.effectiveFrom === '2000-01-01' ? t('clients.fromStart') : `${fmtDate(h.effectiveFrom)} ${t('clients.since')}`}</span>
              <span className="text-xs text-gray-500">{h.createdByName ?? t('notif.system')}</span>
            </li>
          ))}
        </ul>
      </Card>
      {events.length > 0 && (
        <Card>
          <CardHeader title={t('clients.events')} />
          <div className="space-y-4 p-4 text-sm">
            <p className="text-xs text-gray-500">{t('clients.eventsHint')}</p>
            {events.map((e) => {
              const older = e.months.filter((m) => !eventMonths.includes(m));
              return (
                <div key={e.reportTypeId} className="space-y-1.5">
                  <div className="font-medium">{t(`clients.eventLabel.${e.code}`, { defaultValue: i18n.language === 'ru' ? e.nameRu : e.name })}</div>
                  <div className="flex flex-wrap gap-2">
                    {eventMonths.map((m) => {
                      const on = e.months.includes(m);
                      return (
                        <Button
                          key={m}
                          size="sm"
                          variant={on ? 'default' : 'outline'}
                          aria-pressed={on}
                          disabled={eventMark.isPending}
                          onClick={() => eventMark.mutate({ reportTypeId: e.reportTypeId, month: m, on: !on })}
                        >
                          {on && <Check className="h-3.5 w-3.5" />} {filingLabel(m, e.dueDay)}
                        </Button>
                      );
                    })}
                  </div>
                  {older.length > 0 && (
                    <div className="text-xs text-gray-500">{t('clients.eventsEarlier')}: {older.map((m) => monthLabel(shiftMonth(m, 1), months)).join(', ')}</div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
      {client.reportExclusions?.length > 0 && (
        <Card>
          <CardHeader title={t('clients.reportExclusions')} />
          <div className="space-y-3 p-4 text-sm">
            <p className="text-xs text-gray-500">{t('clients.reportExclusionsHint')}</p>
            <ul className="space-y-1.5">
              {client.reportExclusions.map((e) => (
                <li key={e.reportTypeId} className="flex items-center justify-between gap-2">
                  <span>
                    {i18n.language === 'ru' ? e.nameRu : e.name}
                    <span className="ml-2 text-xs text-gray-500">{t('clients.excludedSince', { month: monthLabel(e.effectiveFrom, months) })}</span>
                  </span>
                  {isLeader && (
                    <Button size="sm" variant="outline" disabled={include.isPending} onClick={() => include.mutate(e.reportTypeId)}>
                      {t('clients.includeReport')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
    </>
  );
}
