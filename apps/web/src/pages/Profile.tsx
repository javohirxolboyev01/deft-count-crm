import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { Field, Input, PIN_MIN, PinInput } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { showDesktopNotification, useDesktopPermission } from '@/lib/desktopNotify';
import { errorText } from '@/lib/errors';
import { fmtDateTime } from '@/lib/time';
import type { Lang, NotificationKind } from '@/lib/types';

export default function Profile() {
  const { t, i18n } = useTranslation();
  const { user, reload } = useAuth();
  const desktop = useDesktopPermission();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [code, setCode] = useState<{ code: string; expiresAt: string; deepLink: string | null; botEnabled: boolean } | null>(null);
  const onErr = (e: unknown) => toast.error(errorText(e, t));

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/me', body),
    onSuccess: async () => {
      await reload();
      toast.success(t('common.saved'));
    },
    onError: onErr,
  });
  const changePw = useMutation({
    mutationFn: () => api.post('/me/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }),
    onSuccess: () => {
      setPw({ currentPassword: '', newPassword: '', repeat: '' });
      toast.success(t('profile.passwordChanged'));
    },
    onError: onErr,
  });
  const getCode = useMutation({ mutationFn: () => api.post<any>('/me/telegram/code'), onSuccess: setCode, onError: onErr });
  const unlink = useMutation({ mutationFn: () => api.del('/me/telegram'), onSuccess: () => reload(), onError: onErr });

  if (!user) return null;
  const prefs = user.notificationPrefs ?? {};
  const kinds = user.notificationKinds ?? [];
  const setPref = (kind: NotificationKind, channel: 'app' | 'telegram', value: boolean) =>
    save.mutate({ notificationPrefs: { ...prefs, [kind]: { ...prefs[kind], [channel]: value } } });

  return (
    <div className="space-y-4">
      <PageHeader title={t('profile.title')} />
      <Card>
        <CardHeader title={user.fullName} />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label={t('users.login')}><Input value={user.login} disabled /></Field>
          <Field label={t('users.role')}><Input value={t(`roles.${user.role}`)} disabled /></Field>
          <Field label={t('profile.language')}>
            <Select
              value={user.language}
              onChange={(v) => {
                void i18n.changeLanguage(v);
                save.mutate({ language: v as Lang });
              }}
              options={[{ value: 'uz', label: "O'zbekcha" }, { value: 'ru', label: 'Русский' }]}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('profile.changePassword')} />
        <form
          className="grid gap-4 p-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw.newPassword !== pw.repeat) return toast.error(t('profile.passwordMismatch'));
            changePw.mutate();
          }}
        >
          <Field label={t('profile.currentPassword')}><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label={t('profile.newPassword')} hint={t('users.passwordHint')}><PinInput value={pw.newPassword} onChange={(v) => setPw({ ...pw, newPassword: v })} /></Field>
          <Field label={t('profile.repeatPassword')}><PinInput value={pw.repeat} onChange={(v) => setPw({ ...pw, repeat: v })} /></Field>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={!pw.currentPassword || pw.newPassword.length < PIN_MIN || changePw.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title={t('profile.telegram')} />
        <div className="space-y-3 p-4 text-sm">
          {!user.telegramBotEnabled && <p className="text-amber-700">{t('profile.botDisabled')}</p>}
          {user.telegramLinked ? (
            <div className="flex items-center gap-3">
              <span className="text-green-700">✓ {t('profile.linked')}</span>
              <Button size="sm" variant="outline" onClick={() => unlink.mutate()}>{t('profile.unlink')}</Button>
            </div>
          ) : (
            <>
              <p>{t('profile.notLinked')}</p>
              <Button size="sm" onClick={() => getCode.mutate()} disabled={!user.telegramBotEnabled}>{t('profile.getCode')}</Button>
              {code && (
                <div className="rounded-md border bg-gray-50 p-3">
                  <p>{t('profile.codeHint', { bot: user.telegramBotUsername ? '@' + user.telegramBotUsername : t('profile.theBot') })}</p>
                  <p className="my-2 font-mono text-lg font-semibold">/start {code.code}</p>
                  <p className="text-xs text-gray-500">{t('profile.codeExpires', { at: fmtDateTime(code.expiresAt) })}</p>
                  {code.deepLink && <a className="text-brand underline" href={code.deepLink} target="_blank" rel="noreferrer">{t('profile.openBot')}</a>}
                  <Button size="sm" variant="ghost" className="ml-2" onClick={() => reload()}>{t('profile.checkLinked')}</Button>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {!!kinds.length && <Card>
        <CardHeader title={t('desktopNotif.title')} />
        <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <p className="min-w-0 flex-1 text-gray-600">
            {desktop.perm === 'granted' ? t('desktopNotif.on') : desktop.perm === 'denied' ? t('desktopNotif.denied') : desktop.perm === 'unsupported' ? t('desktopNotif.unsupported') : t('desktopNotif.banner')}
          </p>
          {desktop.perm === 'default' && <Button size="sm" onClick={() => void desktop.request()}>{t('desktopNotif.enable')}</Button>}
          {desktop.perm === 'granted' && (
            <Button size="sm" variant="outline" onClick={() => showDesktopNotification({ title: 'CRM', body: t('desktopNotif.testText'), tag: 'desktop-test' })}>
              {t('desktopNotif.test')}
            </Button>
          )}
        </div>
      </Card>}

      {!!kinds.length && <Card>
        <CardHeader title={t('profile.prefs')} />
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr><th className="px-4 py-2.5">{t('profile.kind')}</th><th className="px-4 py-2.5">{t('profile.inApp')}</th><th className="px-4 py-2.5">Telegram</th></tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k} className="border-t">
                <td className="px-4 py-2">{t(`notifKind.${k}`)}</td>
                <td className="px-4 py-2"><input type="checkbox" aria-label={`${t(`notifKind.${k}`)} — ${t('profile.inApp')}`} checked={prefs[k]?.app !== false} onChange={(e) => setPref(k, 'app', e.target.checked)} /></td>
                <td className="px-4 py-2"><input type="checkbox" aria-label={`${t(`notifKind.${k}`)} — Telegram`} checked={prefs[k]?.telegram !== false} onChange={(e) => setPref(k, 'telegram', e.target.checked)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>}
    </div>
  );
}
