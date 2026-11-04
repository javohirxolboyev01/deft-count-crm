import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Empty } from '@/components/ui/states';
import { invalidateTasks } from '@/hooks/tasks';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { fmtDate, monthLabel } from '@/lib/time';
import { type ClientCard, taxTypeLabel } from '@/lib/types';

/**
 * Mijoz kartasidagi hisobotga oid kartalar: soliq turi tarixi va doimiy "X" istisnolari (bo'lsa).
 * Holat bo'yicha hisobotlar (dividend, norezident) kartada yo'q (rahbar qarori): Hisobot topshirish jadvalida
 * o'sha oy katagiga 1 / 0 / X qo'yiladi (V30).
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
  const include = useMutation({
    mutationFn: (reportTypeId: number) => api.del(`/clients/${id}/report-exclusions/${reportTypeId}`),
    onSuccess: refresh,
    onError: onErr,
  });

  const months = t('months', { returnObjects: true }) as string[];

  return (
    <>
      <Card>
        <CardHeader title={t('clients.taxHistory')} />
        {!client.taxHistory?.length && <Empty />}
        <ul className="divide-y text-sm">
          {client.taxHistory?.map((h) => (
            <li key={h.id} className="flex justify-between px-4 py-2">
              <span><b>{taxTypeLabel(h.taxType)}</b> · {h.effectiveFrom === '2000-01-01' ? t('clients.fromStart') : `${fmtDate(h.effectiveFrom)} ${t('clients.since')}`}</span>
              <span className="text-xs text-gray-500">{h.createdByName ?? t('notif.system')}</span>
            </li>
          ))}
        </ul>
      </Card>
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
