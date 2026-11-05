import { useTranslation } from 'react-i18next';
import { Badge } from './ui/card';
import { type CellState, type ClientStatus, type TaskStatus, type TaxType, taxTypeLabel } from '@/lib/types';

const taskCls: Record<TaskStatus, string> = {
  TODO: 'border-gray-300 bg-gray-50 text-gray-700',
  IN_PROGRESS: 'border-blue-300 bg-blue-50 text-blue-700',
  WAITING_CLIENT: 'border-waiting-border bg-waiting-bg text-waiting',
  DONE: 'border-done-border bg-done-bg text-done',
  CANCELLED: 'border-gray-200 bg-gray-100 text-gray-400 line-through',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useTranslation();
  return <Badge className={taskCls[status]}>{t(`taskStatus.${status}`)}</Badge>;
}

const clientCls: Record<ClientStatus, string> = {
  ACTIVE: 'border-green-200 bg-green-50 text-green-700',
  ZERO_REPORT: 'border-gray-300 bg-gray-50 text-gray-600',
  LIQUIDATING: 'border-red-200 bg-red-50 text-red-700',
  ARCHIVED: 'border-gray-200 bg-gray-100 text-gray-500',
};

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  const { t } = useTranslation();
  return <Badge className={clientCls[status]}>{t(`clientStatus.${status}`)}</Badge>;
}

/** taxType null: importda tanilmagan — fayldagi matn ("ЯТТ") sariq belgi bilan, kartada tanlanadi */
export function TaxBadge({ taxType, raw }: { taxType: TaxType | null; raw?: string | null }) {
  const { t } = useTranslation();
  if (!taxType) {
    return (
      <span title={t('clients.taxNoneHint')}>
        <Badge className="border-amber-300 bg-amber-50 text-amber-800">{raw || t('clients.taxNone')} ?</Badge>
      </span>
    );
  }
  return (
    <Badge className={taxType === 'QQS' ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : taxType === 'YATT' ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-teal-200 bg-teal-50 text-teal-700'}>
      {taxTypeLabel(taxType)}
    </Badge>
  );
}

/** Hisobot topshirish katagi: ✓ topshirildi, ○ topshirilmagan, ! muddati o'tdi, X topshirmaydi (Exceldagidek) */
export const REPORT_CELL: Record<CellState, { sym: string; cls: string }> = {
  '1': { sym: '✓', cls: 'bg-done-bg text-done font-semibold' },
  '0': { sym: '○', cls: 'font-semibold text-gray-600 hover:bg-blue-50 dark:text-on-brand' },
  '!': { sym: '!', cls: 'bg-overdue-bg text-overdue font-bold hover:bg-red-200' },
  X: { sym: 'X', cls: 'bg-gray-100 font-semibold text-gray-600 dark:text-on-brand' },
};
