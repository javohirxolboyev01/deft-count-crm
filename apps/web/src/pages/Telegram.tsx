import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Eye, EyeOff, Lock, MessageSquareText, Pencil } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { TgChatList } from '@/components/telegram/TgChatList';
import { TgConversation } from '@/components/telegram/TgConversation';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { tgKeys } from '@/lib/tgCache';
import type { TgDialog, TgFolder, TgStatus } from '@/lib/types';

/**
 * «Telegram» bo'limi (V53): firma Telegram akkaunti CRM ichida, Telegram Web ko'rinishida.
 * Rahbar bir marta raqam + kod bilan ulaydi; keyin rahbar va buxgalterlar shu yerdan mijozlar bilan yozishadi.
 * Xabarlar Telegram'dan olinadi (CRM'da saqlanmaydi); CRM'dan yozilgan xabar yonida xodim ismi ko'rinadi.
 */

/** CRM header (56px) ostidagi butun maydon: main'ning ichki chekinishi bekor qilinadi */
const FULL = 'tg -m-2 flex h-[calc(100dvh-var(--banner-h)-56px)] overflow-hidden sm:-m-4';

export default function Telegram() {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const status = useQuery({ queryKey: tgKeys.status, queryFn: () => api.get<TgStatus>('/tg/status') });

  if (status.isLoading) {
    return (
      <div className={cn(FULL, 'items-center justify-center')} style={{ background: 'var(--tg-bg)' }}>
        <Spinner />
      </div>
    );
  }
  const s = status.data;
  if (!s) {
    return (
      <div className={cn(FULL, 'items-center justify-center')} style={{ background: 'var(--tg-bg)' }}>
        <p className="text-[var(--tg-danger)]">{errorText(status.error, t)}</p>
      </div>
    );
  }
  if (!s.connected) {
    return (
      <div className={cn(FULL, 'tg-scroll overflow-y-auto')} style={{ background: 'var(--tg-bg)' }}>
        {!s.configured ? (
          <AuthNotice title={t('tg.notConfigured')} text={t(isLeader ? 'tg.notConfiguredLeader' : 'tg.askLeader')} />
        ) : isLeader ? (
          <AuthFlow status={s} />
        ) : (
          <AuthNotice title={t('tg.notConnected')} text={t('tg.askLeader')} />
        )}
      </div>
    );
  }
  return <Messenger status={s} />;
}

// ---------------- Kirish (Telegram Web'dagidek) ----------------

/** Telegram uslubidagi dumaloq belgi (o'zimiz chizgan qog'oz samolyot) */
function Logo({ children }: { children?: ReactNode }) {
  return (
    <div className="mx-auto mb-7 flex h-[160px] w-[160px] items-center justify-center rounded-full bg-gradient-to-tl from-[#048494] to-[#10B981] text-on-brand shadow-[0_10px_30px_rgba(4,132,148,0.35)]">
      {children ?? (
        <svg viewBox="0 0 24 24" width="84" height="84" aria-hidden className="-ml-2">
          <path fill="currentColor" d="M2.6 11.2 20.3 4.4c.8-.3 1.6.2 1.4 1.4l-3 14.2c-.2 1-.8 1.2-1.6.8l-4.5-3.3-2.2 2.1c-.2.2-.5.4-.9.4l.3-4.6 8.4-7.6c.4-.3-.1-.5-.6-.2L7.2 14.1l-4.5-1.4c-1-.3-1-1 .1-1.5Z" />
        </svg>
      )}
    </div>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[360px] px-4 pb-10 pt-[min(10vh,96px)] text-center">{children}</div>;
}

function AuthNotice({ title, text }: { title: string; text: string }) {
  return (
    <AuthShell>
      <Logo />
      <h1 className="mb-2 text-[32px] font-medium leading-tight">{title}</h1>
      <p className="whitespace-pre-line text-base leading-[1.35] text-[var(--tg-secondary)]">{text}</p>
    </AuthShell>
  );
}

/** Telegram'ning "suzuvchi yorliqli" maydoni: yorliq ramka ustiga ko'tariladi, xatoda qizil */
function FloatingInput({
  label,
  value,
  onChange,
  error,
  type = 'text',
  inputMode,
  autoComplete = 'off',
  autoFocus,
  right,
  onFocus,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  autoComplete?: string;
  autoFocus?: boolean;
  right?: ReactNode;
  onFocus?: () => void;
  readOnly?: boolean;
}) {
  const [focus, setFocus] = useState(false);
  const up = focus || !!value;
  const color = error ? 'var(--tg-danger)' : focus ? 'var(--tg-primary)' : 'var(--tg-secondary)';
  return (
    <label className="relative mb-5 block text-left">
      <input
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        readOnly={readOnly}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          setFocus(true);
          onFocus?.();
        }}
        onBlur={() => setFocus(false)}
        className={cn(
          'h-[54px] w-full rounded-xl bg-transparent px-[15px] text-base outline-none transition-[border-color,box-shadow] focus-visible:ring-0 focus-visible:ring-offset-0',
          readOnly && 'cursor-pointer',
        )}
        style={{
          border: `1px solid ${error ? 'var(--tg-danger)' : focus ? 'var(--tg-primary)' : 'var(--tg-border)'}`,
          boxShadow: focus || error ? `inset 0 0 0 1px ${error ? 'var(--tg-danger)' : 'var(--tg-primary)'}` : undefined,
          paddingRight: right ? 48 : undefined,
        }}
      />
      <span
        className={cn('pointer-events-none absolute left-3 px-1 transition-all', up ? '-top-[9px] text-xs' : 'top-[15px] text-base')}
        style={{ color, background: 'var(--tg-bg)' }}
      >
        {error || label}
      </span>
      {right && <span className="absolute right-2 top-1/2 -translate-y-1/2">{right}</span>}
    </label>
  );
}

function BigButton({ children, loading, disabled }: { children: ReactNode; loading?: boolean; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled || loading}
      className="flex h-[54px] w-full cursor-pointer items-center justify-center rounded-xl bg-gradient-to-tl from-[#048494] to-[#10B981] text-base font-medium uppercase tracking-wide text-on-brand shadow-[0_3px_10px_rgba(4,132,148,0.28)] transition-[opacity,transform] hover:opacity-90 active:scale-[0.99] disabled:cursor-default disabled:opacity-50"
    >
      {loading ? <Spinner size="small" className="text-on-brand" /> : children}
    </button>
  );
}

// Ko'p ishlatiladigan mamlakatlar; boshqa raqamni to'g'ridan-to'g'ri + bilan yozish mumkin
const COUNTRIES = [
  { code: '998', flag: '🇺🇿', name: { uz: "O'zbekiston", ru: 'Узбекистан' } },
  { code: '7', flag: '🇷🇺', name: { uz: 'Rossiya', ru: 'Россия' } },
  { code: '7', flag: '🇰🇿', name: { uz: "Qozog'iston", ru: 'Казахстан' } },
  { code: '996', flag: '🇰🇬', name: { uz: "Qirg'iziston", ru: 'Кыргызстан' } },
  { code: '992', flag: '🇹🇯', name: { uz: 'Tojikiston', ru: 'Таджикистан' } },
  { code: '993', flag: '🇹🇲', name: { uz: 'Turkmaniston', ru: 'Туркменистан' } },
  { code: '90', flag: '🇹🇷', name: { uz: 'Turkiya', ru: 'Турция' } },
  { code: '971', flag: '🇦🇪', name: { uz: 'BAA', ru: 'ОАЭ' } },
  { code: '82', flag: '🇰🇷', name: { uz: 'Janubiy Koreya', ru: 'Южная Корея' } },
  { code: '1', flag: '🇺🇸', name: { uz: 'AQSH', ru: 'США' } },
];

/** +998 90 123 45 67 ko'rinishida (O'zbekiston), boshqalarda — guruhlarsiz */
function formatPhone(digits: string) {
  if (digits.startsWith('998')) {
    const r = digits.slice(3, 12);
    const g = [r.slice(0, 2), r.slice(2, 5), r.slice(5, 7), r.slice(7, 9)].filter(Boolean);
    return `+998${g.length ? ' ' + g.join(' ') : ''}`;
  }
  return digits ? `+${digits}` : '';
}

function AuthFlow({ status }: { status: TgStatus }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('+998 ');
  const [countryOpen, setCountryOpen] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [via, setVia] = useState<'APP' | 'SMS' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const step = status.login?.step ?? 'PHONE';
  const refresh = () => qc.invalidateQueries({ queryKey: ['tg'] });
  const lang = (i18n.language === 'ru' ? 'ru' : 'uz') as 'uz' | 'ru';

  useEffect(() => setErr(null), [step]);

  const digits = phone.replace(/\D/g, '');
  const country = useMemo(
    () => [...COUNTRIES].sort((a, b) => b.code.length - a.code.length).find((c) => digits.startsWith(c.code)) ?? null,
    [digits],
  );

  const fieldError = (e: unknown) => (e instanceof ApiError ? errorText(e, t) : t('errors.INTERNAL'));

  const start = useMutation({
    mutationFn: () => api.post<{ via: 'APP' | 'SMS' }>('/tg/login/start', { phone: `+${digits}` }),
    onSuccess: (r) => {
      setVia(r.via);
      setCode('');
      void refresh();
    },
    onError: (e) => setErr(fieldError(e)),
  });
  const sendCode = useMutation({
    mutationFn: (c: string) => api.post<{ done: boolean }>('/tg/login/code', { code: c }),
    onSuccess: (r) => {
      if (r.done) toast.success(t('tg.connected'));
      void refresh();
    },
    onError: (e) => {
      setErr(fieldError(e));
      if (e instanceof ApiError && (e.code === 'TG_LOGIN_EXPIRED' || e.code === 'TG_CODE_EXPIRED')) void refresh();
    },
  });
  const sendPassword = useMutation({
    mutationFn: () => api.post('/tg/login/password', { password }),
    onSuccess: () => {
      toast.success(t('tg.connected'));
      setPassword('');
      void refresh();
    },
    onError: (e) => setErr(fieldError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api.post('/tg/login/cancel'),
    onSettled: () => void refresh(),
  });

  if (step === 'CODE') {
    return (
      <AuthShell>
        <Logo>
          <MessageSquareText className="h-20 w-20" strokeWidth={1.5} />
        </Logo>
        <h1 className="mb-2 flex items-center justify-center gap-2 text-[32px] font-medium leading-tight">
          {formatPhone((status.login?.phone ?? '').replace(/\D/g, ''))}
          <button
            type="button"
            onClick={() => cancel.mutate()}
            aria-label={t('tg.editPhone')}
            title={t('tg.editPhone')}
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-[var(--tg-secondary)] hover:bg-[var(--tg-hover)]"
          >
            <Pencil className="h-5 w-5" />
          </button>
        </h1>
        <p className="mb-10 text-base leading-[1.35] text-[var(--tg-secondary)]">{t(via === 'SMS' ? 'tg.codeViaSms' : 'tg.codeViaApp')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length >= 5) sendCode.mutate(code);
          }}
        >
          <FloatingInput
            label={t('tg.code')}
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            error={err}
            onChange={(v) => {
              const c = v.replace(/\D/g, '').slice(0, 6);
              setCode(c);
              setErr(null);
              // Telegram kabi: kod to'liq yozilishi bilan o'zi yuboriladi
              if (c.length === 5 && !sendCode.isPending) sendCode.mutate(c);
            }}
          />
          {sendCode.isPending && (
            <div className="flex justify-center">
              <Spinner size="small" />
            </div>
          )}
        </form>
      </AuthShell>
    );
  }

  if (step === 'PASSWORD') {
    return (
      <AuthShell>
        <Logo>
          <Lock className="h-20 w-20" strokeWidth={1.5} />
        </Logo>
        <h1 className="mb-2 text-[32px] font-medium leading-tight">{t('tg.passwordTitle')}</h1>
        <p className="mb-10 text-base leading-[1.35] text-[var(--tg-secondary)]">{t('tg.passwordText')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) sendPassword.mutate();
          }}
        >
          <FloatingInput
            label={status.login?.hint ? t('tg.passwordHint', { hint: status.login.hint }) : t('tg.password')}
            value={password}
            type={showPw ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus
            error={err}
            onChange={(v) => {
              setPassword(v);
              setErr(null);
            }}
            right={
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? t('login.hidePassword') : t('login.showPassword')}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-[var(--tg-secondary)] hover:bg-[var(--tg-hover)]"
              >
                {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            }
          />
          <BigButton loading={sendPassword.isPending} disabled={!password}>
            {t('tg.next')}
          </BigButton>
        </form>
        <button type="button" onClick={() => cancel.mutate()} className="mt-4 cursor-pointer text-sm text-[var(--tg-primary)] hover:underline">
          {t('tg.startOver')}
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Logo />
      <h1 className="mb-2 text-[32px] font-semibold leading-tight">Telegram</h1>
      <p className="mb-10 text-base leading-[1.35] text-[var(--tg-secondary)]">{t('tg.phoneText')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          if (digits.length >= 9) start.mutate();
        }}
      >
        <div className="relative">
          <FloatingInput
            label={t('tg.country')}
            value={country ? `${country.flag}  ${country.name[lang]}` : ''}
            onChange={() => undefined}
            onFocus={() => setCountryOpen(true)}
            readOnly
            right={<ChevronDown className={cn('mr-2 h-5 w-5 text-[var(--tg-secondary)] transition-transform', countryOpen && 'rotate-180')} />}
          />
          {countryOpen && (
            <CountryList
              lang={lang}
              onPick={(c) => {
                setPhone(formatPhone(c.code) + ' ');
                setCountryOpen(false);
              }}
              onClose={() => setCountryOpen(false)}
            />
          )}
        </div>
        <FloatingInput
          label={t('tg.phone')}
          value={phone}
          type="tel"
          inputMode="tel"
          autoFocus
          error={err}
          onChange={(v) => {
            setErr(null);
            setPhone(formatPhone(v.replace(/\D/g, '').slice(0, 15)));
          }}
        />
        <BigButton loading={start.isPending} disabled={digits.length < 9}>
          {t('tg.next')}
        </BigButton>
      </form>
      <p className="mt-6 text-xs leading-relaxed text-[var(--tg-secondary)]">{t('tg.safetyNote')}</p>
    </AuthShell>
  );
}

function CountryList({ lang, onPick, onClose }: { lang: 'uz' | 'ru'; onPick: (c: (typeof COUNTRIES)[number]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="tg-scroll absolute left-0 right-0 top-[58px] z-10 max-h-[260px] overflow-y-auto rounded-xl p-1 text-left shadow-[0_4px_16px_rgba(0,0,0,0.18)]"
      style={{ background: 'var(--tg-bg)' }}
    >
      {COUNTRIES.map((c) => (
        <button
          key={c.flag}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
          className="flex w-full cursor-pointer items-center gap-4 rounded-lg px-3 py-2.5 text-[15px] hover:bg-[var(--tg-hover)]"
        >
          <span className="text-xl">{c.flag}</span>
          <span className="grow">{c.name[lang]}</span>
          <span className="text-[var(--tg-secondary)]">+{c.code}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------- Messenger ----------------

function Messenger({ status }: { status: TgStatus }) {
  const { t } = useTranslation();
  const { isLeader } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const active = params.get('chat');
  const [confirmLogout, setConfirmLogout] = useState(false);

  const dialogs = useQuery({
    queryKey: tgKeys.dialogs,
    queryFn: () => api.get<TgDialog[]>('/tg/dialogs'),
    // SSE asosiy kanal; polling — zaxira (ro'yxat serverda xotirada, Telegram'ga so'rov ketmaydi)
    refetchInterval: 60_000,
  });
  // Jildlar kamdan-kam o'zgaradi: SSE (`tg-folders`) yangilaydi
  const folders = useQuery({ queryKey: tgKeys.folders, queryFn: () => api.get<TgFolder[]>('/tg/folders'), staleTime: 10 * 60_000 });
  const logout = useMutation({
    mutationFn: () => api.post('/tg/logout'),
    onSuccess: () => {
      setConfirmLogout(false);
      void qc.invalidateQueries({ queryKey: ['tg'] });
    },
    onError: (e) => toast.error(errorText(e, t)),
  });

  const open = (peerId: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (peerId) n.set('chat', peerId);
      else n.delete('chat');
      return n;
    });
  const dialog = dialogs.data?.find((d) => d.peerId === active) ?? null;

  return (
    <div className={FULL}>
      <aside
        className={cn('h-full w-full shrink-0 md:w-[340px] lg:w-auto', active && 'max-md:hidden')}
        style={{ borderRight: '1px solid var(--tg-border)' }}
      >
        <TgChatList
          dialogs={dialogs.data ?? []}
          folders={folders.data ?? []}
          loading={dialogs.isLoading}
          error={dialogs.error ? errorText(dialogs.error, t) : null}
          active={active}
          onPick={open}
          status={status}
          canDisconnect={isLeader}
          onDisconnect={() => setConfirmLogout(true)}
        />
      </aside>
      <section className={cn('h-full min-w-0 grow', !active && 'max-md:hidden')}>
        {active ? (
          <TgConversation key={active} peerId={active} dialog={dialog} dialogs={dialogs.data ?? []} onBack={() => open(null)} onOpenChat={open} />
        ) : (
          <div className="tg-chat-bg relative flex h-full items-center justify-center">
            <span className="relative rounded-full px-3 py-1 text-[15px] font-medium text-on-brand backdrop-blur-sm" style={{ background: 'var(--tg-pill)' }}>
              {t('tg.pickChat')}
            </span>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => logout.mutate()}
        loading={logout.isPending}
        title={t('tg.disconnectTitle')}
        text={t('tg.disconnectText')}
      />
    </div>
  );
}
