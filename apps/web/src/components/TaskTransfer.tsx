import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { invalidateTasks, taskTitle, useAccountants } from '@/hooks/tasks';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorText } from '@/lib/errors';
import { fmtDateTime } from '@/lib/time';
import { type Task, type TaskDetail, type TaskTransfer, TRANSFER_REASONS, type TransferReason } from '@/lib/types';
import { Button } from './ui/button';
import { Card, CardHeader } from './ui/card';
import { Dialog } from './ui/dialog';
import { Field, Textarea } from './ui/input';
import { Select } from './ui/select';

/** Faqat Shoshilinch va qo'lda yaratilgan vazifa o'tkaziladi (doimiy ish/hisobot mijoz buxgalteriga bog'langan) */
export const isTransferable = (t: Pick<Task, 'kind' | 'status'>) =>
  (t.kind === 'URGENT' || t.kind === 'MANUAL') && t.status !== 'DONE' && t.status !== 'CANCELLED';

export function reasonLabel(tr: Pick<TaskTransfer, 'reasonCode' | 'reasonText'>, t: (k: string) => string) {
  const base = t(`transfer.reasons.${tr.reasonCode}`);
  if (!tr.reasonText) return base;
  return tr.reasonCode === 'OTHER' ? tr.reasonText : `${base} — ${tr.reasonText}`;
}

/** Qabul qilish / rad etish — vazifa paneli va "Mening kunim" uchun umumiy */
export function useTransferDecision() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = (e: unknown) => {
    toast.error(errorText(e, t));
    invalidateTasks(qc);
  };
  const accept = useMutation({
    mutationFn: (id: number) => api.post<Task>(`/task-transfers/${id}/accept`),
    onSuccess: () => {
      invalidateTasks(qc);
      toast.success(t('transfer.accepted'));
    },
    onError: onErr,
  });
  const reject = useMutation({
    mutationFn: (p: { id: number; reason: string }) => api.post(`/task-transfers/${p.id}/reject`, { reason: p.reason || undefined }),
    onSuccess: () => {
      invalidateTasks(qc);
      toast.info(t('transfer.rejected'));
    },
    onError: onErr,
  });
  return { accept, reject };
}

export function TransferDialog({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const accountants = useAccountants();
  const [toUserId, setToUserId] = useState('');
  const [reasonCode, setReasonCode] = useState<TransferReason>('NOT_MINE');
  const [reasonText, setReasonText] = useState('');
  useEffect(() => {
    if (!open) return;
    setToUserId('');
    setReasonCode('NOT_MINE');
    setReasonText('');
  }, [open]);

  const send = useMutation({
    mutationFn: () => api.post('/task-transfers', { taskId: task.id, toUserId: Number(toUserId), reasonCode, reasonText: reasonText.trim() || undefined }),
    onSuccess: () => {
      invalidateTasks(qc);
      const to = accountants.data?.find((a) => String(a.id) === toUserId)?.fullName ?? '';
      toast.success(t('transfer.sent', { to }));
      onClose();
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  const textRequired = reasonCode === 'OTHER';
  const valid = !!toUserId && (!textRequired || !!reasonText.trim());
  const options = (accountants.data ?? [])
    .filter((a) => a.id !== task.assigneeId)
    .map((a) => ({ value: String(a.id), label: a.fullName }));

  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      title={t('transfer.title')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!valid} loading={send.isPending} onClick={() => send.mutate()}>
            <ArrowLeftRight className="h-4 w-4" /> {t('transfer.send')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send.mutate();
        }}
      >
        <p className="rounded-lg bg-gray-50 p-3 text-[13px] text-gray-600">
          «{taskTitle(task, i18n.language)}» — {task.clientName}
          <br />
          <span className="text-xs text-gray-500">{t('transfer.hint', { from: task.assigneeName ?? '—' })}</span>
        </p>
        <Field label={t('transfer.to')}>
          <Select value={toUserId} options={options} onChange={setToUserId} placeholder={t('transfer.choose')} aria-label={t('transfer.to')} />
        </Field>
        <Field label={t('transfer.reason')} group>
          <div className="flex flex-wrap gap-2">
            {TRANSFER_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reasonCode === r}
                onClick={() => setReasonCode(r)}
                className={
                  reasonCode === r
                    ? 'cursor-pointer rounded-lg border border-brand-500 bg-brand-50 px-3 py-1.5 text-[13px] font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200'
                    : 'cursor-pointer rounded-lg border border-gray-200 px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50'
                }
              >
                {t(`transfer.reasons.${r}`)}
              </button>
            ))}
          </div>
        </Field>
        <Field label={textRequired ? t('transfer.reasonTextRequired') : t('transfer.reasonTextOptional')}>
          <Textarea value={reasonText} onChange={(e) => setReasonText(e.target.value)} rows={2} maxLength={500} required={textRequired} />
        </Field>
      </form>
    </Dialog>,
    document.body,
  );
}

export function RejectDialog({ transferId, onClose }: { transferId: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { reject } = useTransferDecision();
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [transferId]);
  return createPortal(
    <Dialog
      open={transferId !== null}
      onClose={onClose}
      title={t('transfer.rejectTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            loading={reject.isPending}
            onClick={() => transferId !== null && reject.mutate({ id: transferId, reason: reason.trim() }, { onSuccess: onClose })}
          >
            {t('transfer.reject')}
          </Button>
        </>
      }
    >
      <Field label={t('transfer.rejectReason')}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
      </Field>
    </Dialog>,
    document.body,
  );
}

/** Vazifa panelidagi blok: o'tkazish tugmasi, kutilayotgan so'rov (qabul/rad yoki qaytarib olish) va tarix */
export function TransferSection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const { user, isLeader } = useAuth();
  const qc = useQueryClient();
  const { accept } = useTransferDecision();
  const [dialog, setDialog] = useState(false);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const withdraw = useMutation({
    mutationFn: (id: number) => api.post(`/task-transfers/${id}/cancel`),
    onSuccess: () => {
      invalidateTasks(qc);
      toast.info(t('transfer.withdrawn'));
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  const p = task.pendingTransfer;
  const open = isTransferable(task);
  const canRequest = open && !p && (isLeader || task.assigneeId === user?.id);
  const isRecipient = !!p && p.toUserId === user?.id;
  const canWithdraw = !!p && (isLeader || p.requestedBy === user?.id);
  const history = task.transfers.filter((h) => h.status !== 'PENDING');

  if (!canRequest && !(p && open) && !history.length) return null;
  return (
    <section className="space-y-2">
      {p && open && (
        <div className="rounded-lg border border-blue-300 border-l-4 border-l-blue-500 bg-blue-100 p-3 text-[13px]">
          <p className="font-semibold text-blue-800">
            {isRecipient ? t('transfer.pendingIn', { from: p.fromName ?? p.requestedByName }) : t('transfer.pendingOut', { to: p.toName })}
          </p>
          <p className="mt-0.5 text-xs text-blue-700">
            {t('transfer.reason')}: {reasonLabel(p, t)}
            {p.requestedBy !== p.fromUserId && ` · ${t('transfer.requestedBy', { name: p.requestedByName })}`}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {isRecipient && (
              <>
                <Button size="sm" variant="success" loading={accept.isPending} onClick={() => accept.mutate(p.id)}>
                  <Check className="h-3.5 w-3.5" /> {t('transfer.accept')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(p.id)}>
                  <X className="h-3.5 w-3.5" /> {t('transfer.reject')}
                </Button>
              </>
            )}
            {canWithdraw && !isRecipient && (
              <Button size="sm" variant="outline" loading={withdraw.isPending} onClick={() => withdraw.mutate(p.id)}>
                {t('transfer.withdraw')}
              </Button>
            )}
          </div>
        </div>
      )}
      {canRequest && (
        <Button size="sm" variant="outline" onClick={() => setDialog(true)}>
          <ArrowLeftRight className="h-3.5 w-3.5" /> {t('transfer.button')}
        </Button>
      )}
      {!!history.length && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-foreground">{t('transfer.history')}</h3>
          <ul className="space-y-1 text-xs text-gray-600">
            {history.map((h) => (
              <li key={h.id}>
                {fmtDateTime(h.createdAt)}: {h.fromName ?? '—'} → {h.toName} — {t(`transfer.status.${h.status}`)}
                <span className="text-gray-400"> ({reasonLabel(h, t)}{h.rejectReason ? `; ${h.rejectReason}` : ''})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <TransferDialog task={task} open={dialog} onClose={() => setDialog(false)} />
      <RejectDialog transferId={rejecting} onClose={() => setRejecting(null)} />
    </section>
  );
}

type Incoming = TaskTransfer & { task: Task };

/** "Mening kunim" yuqorisida: menga o'tkazilayotgan vazifalar — bir bosishda qabul / rad */
export function IncomingTransfers({ onOpen }: { onOpen: (id: number) => void }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ['transfers', 'incoming'], queryFn: () => api.get<Incoming[]>('/task-transfers/incoming'), refetchInterval: 60_000 });
  const { accept } = useTransferDecision();
  const [rejecting, setRejecting] = useState<number | null>(null);
  if (!q.data?.length) return null;
  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-blue-500" /> {t('transfer.incoming')} ({q.data.length})
          </span>
        }
      />
      <ul className="divide-y divide-gray-200">
        {q.data.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
            <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => onOpen(x.taskId)}>
              <span className="block font-medium text-foreground">
                {taskTitle(x.task, i18n.language)} <span className="font-normal text-gray-500">— {x.task.clientName}</span>
              </span>
              <span className="block text-xs text-gray-500">
                {t('transfer.from')}: {x.fromName ?? '—'}
                {x.requestedBy !== x.fromUserId && ` (${t('transfer.requestedBy', { name: x.requestedByName })})`} · {t('transfer.reason')}: {reasonLabel(x, t)}
                {x.task.dueAt && ` · ${t('task.due')}: ${fmtDateTime(x.task.dueAt)}`}
              </span>
            </button>
            <div className="flex gap-1.5">
              <Button size="sm" variant="success" loading={accept.isPending && accept.variables === x.id} onClick={() => accept.mutate(x.id)}>
                <Check className="h-3.5 w-3.5" /> {t('transfer.accept')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting(x.id)}>
                <X className="h-3.5 w-3.5" /> {t('transfer.reject')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <RejectDialog transferId={rejecting} onClose={() => setRejecting(null)} />
    </Card>
  );
}
