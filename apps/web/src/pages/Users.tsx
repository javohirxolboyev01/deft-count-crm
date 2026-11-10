import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2, UserCheck, UserX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Card, PageHeader } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, PIN_MIN, PinInput } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Empty, QueryState } from '@/components/ui/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorText } from '@/lib/errors';
import { fmtDate } from '@/lib/time';
import type { Lang, Role, User } from '@/lib/types';

type Edit = { id?: number; fullName: string; login: string; password: string; role: Role; language: Lang; phoneExt: string };
const blank: Edit = { fullName: '', login: '', password: '', role: 'ACCOUNTANT', language: 'uz', phoneExt: '' };

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    // Header'dagi bildirishnoma tugmasi bilan bir xil "karta" ko'rinishi
    <Button
      size="icon"
      variant="ghost"
      className="h-8 w-8 rounded-lg border border-gray-200 bg-white text-gray-600 shadow-card hover:bg-gray-50 hover:text-brand-500 dark:hover:bg-white/5"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

export default function Users() {
  const { t } = useTranslation();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [reset, setReset] = useState<{ id: number; name: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['accountants'] });
  };
  const onErr = (e: unknown) => toast.error(errorText(e, t));

  const save = useMutation({
    mutationFn: (e: Edit) =>
      e.id
        ? api.patch(`/users/${e.id}`, { fullName: e.fullName, role: e.role, language: e.language, phoneExt: e.phoneExt })
        : api.post('/users', { fullName: e.fullName, login: e.login, password: e.password, role: e.role, language: e.language, phoneExt: e.phoneExt }),
    onSuccess: () => {
      setEdit(null);
      toast.success(t('common.saved'));
      refresh();
      void qc.invalidateQueries({ queryKey: ['calls'] });
    },
    onError: onErr,
  });
  const toggle = useMutation({ mutationFn: (u: User) => api.patch(`/users/${u.id}`, { active: !u.active }), onSuccess: refresh, onError: onErr });
  // Tarixi bor xodim bazada qoladi, lekin ro'yxatdan yo'qoladi va kira olmaydi (server: DELETE /users/:id)
  const remove = useMutation({
    mutationFn: (u: User) => api.del(`/users/${u.id}`),
    onSuccess: () => {
      setRemoving(null);
      toast.success(t('users.deleted'));
      refresh();
    },
    onError: (e) => {
      setRemoving(null);
      onErr(e);
    },
  });
  const resetPw = useMutation({
    mutationFn: (r: { id: number; password: string }) => api.post(`/users/${r.id}/reset-password`, { password: r.password }),
    onSuccess: () => {
      setReset(null);
      toast.success(t('users.passwordReset'));
    },
    onError: onErr,
  });

  return (
    <div>
      <PageHeader title={t('users.title')} actions={<Button onClick={() => setEdit({ ...blank })}><Plus className="h-4 w-4" /> {t('users.new')}</Button>} />
      <Card>
        <QueryState q={q} skeleton={<TableSkeleton rows={10} cols={8} />}>
          {!q.data?.length ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-2.5">{t('users.fullName')}</th>
                  <th className="px-4 py-2.5">{t('users.login')}</th>
                  <th className="px-4 py-2.5">{t('users.role')}</th>
                  <th className="px-4 py-2.5">{t('users.language')}</th>
                  <th className="px-4 py-2.5">{t('users.phoneExt')}</th>
                  <th className="px-4 py-2.5">Telegram</th>
                  <th className="px-4 py-2.5">{t('users.created')}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {q.data?.map((u) => (
                  <tr key={u.id} className={`border-t border-gray-200 transition-colors hover:bg-gray-100 ${u.active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-2.5 font-medium">{u.fullName} {!u.active && <Badge className="ml-1 border-gray-300 text-gray-500">{t('common.inactive')}</Badge>}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{u.login}</td>
                    <td className="px-4 py-2.5">{t(`roles.${u.role}`)}</td>
                    <td className="px-4 py-2.5 uppercase">{u.language}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{u.phoneExt ?? '—'}</td>
                    <td className="px-4 py-2.5">{u.telegramLinked ? '✓' : '—'}</td>
                    <td className="px-4 py-2.5 text-xs">{fmtDate(u.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-1.5">
                      {/* Ikonka tugmalar: matn title/aria-label'da (Sozlamalar sahifasidagidek) */}
                      <div className="flex justify-end gap-1.5">
                        <IconAction label={t('common.edit')} onClick={() => setEdit({ id: u.id, fullName: u.fullName, login: u.login, password: '', role: u.role, language: u.language, phoneExt: u.phoneExt ?? '' })}>
                          <Pencil className="h-4 w-4" />
                        </IconAction>
                        <IconAction label={t('users.resetPassword')} onClick={() => setReset({ id: u.id, name: u.fullName, password: '' })}>
                          <KeyRound className="h-4 w-4" />
                        </IconAction>
                        {u.id !== me?.id && (
                          <>
                            <IconAction label={u.active ? t('users.deactivate') : t('users.activate')} onClick={() => toggle.mutate(u)}>
                              {u.active ? <UserX className="h-4 w-4 text-amber-600" /> : <UserCheck className="h-4 w-4 text-green-600" />}
                            </IconAction>
                            <IconAction label={t('common.delete')} onClick={() => setRemoving(u)}>
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </IconAction>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </QueryState>
      </Card>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? t('users.edit') : t('users.new')}
        footer={<Button disabled={!edit?.fullName || (!edit.id && (!edit.login || edit.password.length < PIN_MIN)) || save.isPending} onClick={() => edit && save.mutate(edit)}>{t('common.save')}</Button>}
      >
        {edit && (
          <div className="grid gap-3">
            <Field label={t('users.fullName')}><Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} /></Field>
            <Field label={t('users.login')}><Input value={edit.login} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, login: e.target.value })} /></Field>
            {!edit.id && <Field label={t('users.password')} hint={t('users.passwordHint')}><PinInput value={edit.password} onChange={(v) => setEdit({ ...edit, password: v })} /></Field>}
            <Field label={t('users.role')}>
              <Select
                value={edit.role}
                disabled={edit.id === me?.id}
                onChange={(v) => setEdit({ ...edit, role: v as Role })}
                options={[
                  { value: 'ACCOUNTANT', label: t('roles.ACCOUNTANT') },
                  { value: 'LEADER', label: t('roles.LEADER') },
                  { value: 'OPERATOR', label: t('roles.OPERATOR') },
                ]}
              />
            </Field>
            <Field label={t('users.language')}>
              <Select value={edit.language} onChange={(v) => setEdit({ ...edit, language: v as Lang })} options={[{ value: 'uz', label: "O'zbekcha" }, { value: 'ru', label: 'Русский' }]} />
            </Field>
            <Field label={t('users.phoneExt')} hint={t('users.phoneExtHint')}>
              <Input value={edit.phoneExt} inputMode="numeric" maxLength={32} placeholder="101" onChange={(e) => setEdit({ ...edit, phoneExt: e.target.value.replace(/[^0-9A-Za-z_.-]/g, '') })} />
            </Field>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        title={t('users.deleteTitle', { name: removing?.fullName ?? '' })}
        text={t('users.deleteText')}
      />

      <Dialog
        open={!!reset}
        onClose={() => setReset(null)}
        title={`${t('users.resetPassword')}: ${reset?.name ?? ''}`}
        footer={<Button disabled={(reset?.password.length ?? 0) < PIN_MIN} onClick={() => reset && resetPw.mutate(reset)}>{t('common.save')}</Button>}
      >
        {reset && (
          <Field label={t('profile.newPassword')} hint={t('users.passwordHint')}>
            <PinInput value={reset.password} onChange={(v) => setReset({ ...reset, password: v })} />
          </Field>
        )}
      </Dialog>
    </div>
  );
}
