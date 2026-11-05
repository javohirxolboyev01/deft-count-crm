import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCheck, MessageCircle, Pencil, Search, SendHorizontal, Trash2, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { TZ } from '@/lib/time';
import type { ChatContact, ChatMessage } from '@/lib/types';
import { ConfirmDialog } from './ui/dialog';
import { Spinner } from './ui/spinner';

/**
 * Ichki chat (Telegram ko'rinishida): o'ng pastki burchakdagi yumaloq tugma — o'qilmaganlar soni bilan,
 * bosilsa suhbatdoshlar ro'yxati (har biri yonida o'qilmaganlar soni), keyin suhbat oynasi.
 * Real vaqt yangilanishi Layout'dagi SSE orqali (`['chat']` so'rovlari yangilanadi).
 */

const PAGE = 50;
// Telegram avatar ranglari: id bo'yicha barqaror tanlanadi
const AVATAR_GRADIENTS = [
  ['#ff885e', '#ff516a'],
  ['#ffcd6a', '#ffa85c'],
  ['#82b1ff', '#665fff'],
  ['#a0de7e', '#54cb68'],
  ['#53edd6', '#28c9b7'],
  ['#72d5fd', '#2a9ef1'],
  ['#e0a2f3', '#d669ed'],
];

const dt = (iso: string) => DateTime.fromISO(iso).setZone(TZ);

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function Avatar({ id, name, size = 48 }: { id: number; name: string; size?: number }) {
  const [a, b] = AVATAR_GRADIENTS[id % AVATAR_GRADIENTS.length];
  return (
    <span
      aria-hidden
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-on-brand"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(180deg, ${a}, ${b})` }}
    >
      {initials(name)}
    </span>
  );
}

function Ticks({ read, className }: { read: boolean; className?: string }) {
  const Icon = read ? CheckCheck : Check;
  return <Icon className={cn('h-4 w-4 shrink-0', className)} aria-hidden />;
}

function UnreadBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cn('min-w-[22px] rounded-full bg-brand-500 px-1.5 text-center text-xs font-semibold leading-[22px] text-on-brand', className)}>
      {n > 999 ? '999+' : n}
    </span>
  );
}

export function ChatWidget({ pulse }: { pulse: number }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);

  const unread = useQuery({
    queryKey: ['chat', 'unread'],
    queryFn: () => api.get<{ count: number; chats: number }>('/chat/unread-count'),
    refetchInterval: 60_000, // SSE asosiy kanal; polling — zaxira
    enabled: !!user,
  });
  const total = unread.data?.count ?? 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if (activeId) setActiveId(null);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeId]);

  if (!user) return null;

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label={t('chat.title')}
          className="fixed inset-x-2 bottom-24 top-16 z-[56] flex animate-pop-in flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-pop sm:inset-x-auto sm:right-6 sm:top-auto sm:h-[600px] sm:max-h-[calc(100vh-128px)] sm:w-[400px]"
        >
          {activeId ? (
            <Conversation userId={activeId} meId={user.id} onBack={() => setActiveId(null)} onClose={() => setOpen(false)} />
          ) : (
            <ContactList onPick={setActiveId} onClose={() => setOpen(false)} meId={user.id} />
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={total ? `${t('chat.open')} — ${t('chat.unread', { count: total })}` : t('chat.open')}
        aria-expanded={open}
        title={t('chat.title')}
        className="fixed bottom-6 right-6 z-[56] flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-gradient-to-tl from-[#048494] to-[#10B981] text-on-brand shadow-[0_6px_20px_rgba(4,132,148,0.45)] transition-transform hover:scale-105 active:scale-95"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle key={`chat-${pulse}`} className={cn('h-6 w-6', pulse > 0 && 'animate-bell-ring')} />}
        {!!total && (
          <span key={`chat-badge-${pulse}`} className="absolute -right-1 -top-1 animate-badge-pop">
            <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-60" />
            <span className="relative block min-w-[22px] rounded-full border-2 border-white bg-red-500 px-1 text-center text-[11px] font-bold leading-[18px] text-on-brand">
              {total > 99 ? '99+' : total}
            </span>
          </span>
        )}
      </button>
    </>
  );
}

// ---------------- Suhbatdoshlar ro'yxati ----------------

function listTime(iso: string, t: ReturnType<typeof useTranslation>['t']) {
  const d = dt(iso);
  const now = DateTime.now().setZone(TZ);
  if (d.hasSame(now, 'day')) return d.toFormat('HH:mm');
  if (d.hasSame(now.minus({ days: 1 }), 'day')) return t('chat.yesterday');
  if (now.diff(d, 'days').days < 7) return (t('weekdaysShort', { returnObjects: true }) as string[])[d.weekday - 1];
  return d.toFormat('dd.MM.yy');
}

function ContactList({ onPick, onClose, meId }: { onPick: (id: number) => void; onClose: () => void; meId: number }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const contacts = useQuery({ queryKey: ['chat', 'contacts'], queryFn: () => api.get<ChatContact[]>('/chat/contacts') });

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (contacts.data ?? []).filter((c) => !s || c.fullName.toLowerCase().includes(s));
  }, [contacts.data, search]);

  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4">
        <h2 className="text-base font-semibold text-gray-900">{t('chat.title')}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="shrink-0 px-3 py-2">
        <label className="flex h-10 items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3.5 text-gray-500 focus-within:border-brand-500">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.search')}
            aria-label={t('chat.search')}
            className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-500 focus-visible:ring-0 focus-visible:ring-offset-0"
            autoFocus
          />
        </label>
      </div>
      <ul className="min-h-0 grow overflow-y-auto">
        {contacts.isLoading && (
          <li className="flex justify-center py-10">
            <Spinner />
          </li>
        )}
        {contacts.isSuccess && !list.length && <li className="py-10 text-center text-sm text-gray-500">{t('chat.empty')}</li>}
        {list.map((c) => {
          const last = c.lastMessage;
          const mine = last?.senderId === meId;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-100"
              >
                <Avatar id={c.id} name={c.fullName} size={52} />
                <span className="flex min-w-0 grow flex-col gap-1 border-b border-gray-100 py-1.5">
                  <span className="flex items-center gap-2">
                    <span className={cn('min-w-0 grow truncate font-semibold text-gray-900', !c.active && 'text-gray-500')}>{c.fullName}</span>
                    {mine && <Ticks read={!!last?.readAt} className="text-brand-500" />}
                    {last && <span className="shrink-0 text-xs text-gray-500">{listTime(last.createdAt, t)}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 grow truncate text-sm text-gray-500">
                      {last ? (
                        <>
                          {mine && <span className="text-gray-700">{t('chat.you')}: </span>}
                          {last.body}
                        </>
                      ) : (
                        `${t(`roles.${c.role}`)}${c.active ? '' : ` · ${t('chat.inactive')}`}`
                      )}
                    </span>
                    {!!c.unread && <UnreadBadge n={c.unread} />}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------- Suhbat ----------------

function dayLabel(iso: string, t: ReturnType<typeof useTranslation>['t']) {
  const d = dt(iso);
  const now = DateTime.now().setZone(TZ);
  if (d.hasSame(now, 'day')) return t('chat.today');
  if (d.hasSame(now.minus({ days: 1 }), 'day')) return t('chat.yesterday');
  const months = t('months', { returnObjects: true }) as string[];
  return `${d.day} ${months[d.month - 1]}${d.year !== now.year ? ` ${d.year}` : ''}`;
}

function Conversation({ userId, meId, onBack, onClose }: { userId: number; meId: number; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  // Tahrirlanayotgan o'z xabari (matn maydoni shu xabar matni bilan to'ladi)
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [menu, setMenu] = useState<{ msg: ChatMessage; x: number; y: number } | null>(null);
  const [toDelete, setToDelete] = useState<ChatMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Eski xabarlar yuklanganda ko'rinayotgan joy siljimasin
  const keepFromBottom = useRef<number | null>(null);
  const lastIdRef = useRef<number | null>(null);

  const contacts = useQuery({ queryKey: ['chat', 'contacts'], queryFn: () => api.get<ChatContact[]>('/chat/contacts') });
  const peer = contacts.data?.find((c) => c.id === userId);

  const history = useInfiniteQuery({
    queryKey: ['chat', 'with', userId],
    queryFn: ({ pageParam }) =>
      api.get<{ items: ChatMessage[]; hasMore: boolean }>(`/chat/with/${userId}${qs({ before: pageParam, limit: PAGE })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.items[0]?.id : undefined),
  });
  const messages = useMemo(() => (history.data?.pages ?? []).slice().reverse().flatMap((p) => p.items), [history.data]);

  const markRead = useMutation({
    mutationFn: () => api.post(`/chat/with/${userId}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat'] }),
  });
  const hasUnreadIncoming = messages.some((m) => m.senderId === userId && !m.readAt);
  useEffect(() => {
    // Suhbat ko'rinib turgan bo'lsagina o'qilgan sanaladi (boshqa tabda yoki oyna yashirin bo'lsa — yo'q)
    const read = () => {
      if (hasUnreadIncoming && !document.hidden && !markRead.isPending) markRead.mutate();
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUnreadIncoming, userId]);

  const send = useMutation({
    mutationFn: (body: string) => api.post<ChatMessage>(`/chat/with/${userId}`, { body }),
    onSuccess: (m) => {
      // Darhol ko'rinsin (SSE keyin ham yangilaydi)
      qc.setQueryData(['chat', 'with', userId], (d: typeof history.data) =>
        d && !d.pages[0].items.some((x) => x.id === m.id)
          ? { ...d, pages: [{ ...d.pages[0], items: [...d.pages[0].items, m] }, ...d.pages.slice(1)] }
          : d,
      );
      void qc.invalidateQueries({ queryKey: ['chat', 'contacts'] });
    },
  });

  /** Keshdagi suhbat sahifalarida bitta xabarni almashtirish (null — olib tashlash) */
  const patchCached = (id: number, fn: (m: ChatMessage) => ChatMessage | null) =>
    qc.setQueryData(['chat', 'with', userId], (d: typeof history.data) =>
      d && {
        ...d,
        pages: d.pages.map((p) => ({ ...p, items: p.items.flatMap((x) => (x.id === id ? (fn(x) ?? []) : [x])) })),
      },
    );

  const edit = useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) => api.patch<ChatMessage>(`/chat/messages/${id}`, { body }),
    onSuccess: (m) => {
      patchCached(m.id, () => m);
      void qc.invalidateQueries({ queryKey: ['chat', 'contacts'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/chat/messages/${id}`),
    onSuccess: (_r, id) => {
      patchCached(id, () => null);
      setToDelete(null);
      if (editing?.id === id) cancelEdit();
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });

  const startEdit = (m: ChatMessage) => {
    setEditing(m);
    setText(m.body);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const cancelEdit = () => {
    setEditing(null);
    setText('');
  };

  const submit = () => {
    const body = text.trim();
    if (!body || send.isPending || edit.isPending) return;
    if (editing) {
      const target = editing;
      cancelEdit();
      if (body !== target.body) edit.mutate({ id: target.id, body }, { onError: () => startEdit({ ...target, body }) });
    } else {
      setText('');
      send.mutate(body, { onError: () => setText(body) });
    }
    inputRef.current?.focus();
  };

  // Pastga aylantirish: birinchi ochilishda, o'z xabarida yoki pastda turgan bo'lsa yangi xabarda
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
      return;
    }
    const last = messages.at(-1);
    if (!last || last.id === lastIdRef.current) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (lastIdRef.current === null || nearBottom || last.senderId === meId) el.scrollTop = el.scrollHeight;
    lastIdRef.current = last.id;
  }, [messages, meId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [userId]);

  const openMenu = (m: ChatMessage, e: React.MouseEvent) => {
    // Matn belgilanayotgan bo'lsa (nusxa olish uchun) menyu ochilmasin
    if (e.type === 'click' && window.getSelection()?.toString()) return;
    e.preventDefault();
    setMenu({ msg: m, x: e.clientX, y: e.clientY });
  };

  // Matn maydoni balandligi matnga qarab (ko'pi bilan ~6 qator)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const loadOlder = () => {
    const el = scrollRef.current;
    if (!history.hasNextPage || history.isFetchingNextPage || !el) return;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    void history.fetchNextPage();
  };

  const canSend = peer?.active !== false;
  const name = peer?.fullName ?? '';

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-gray-200 px-2">
        <button type="button" onClick={onBack} aria-label={t('common.back')} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100">
          <ArrowLeft className="h-5 w-5" />
        </button>
        {peer && <Avatar id={peer.id} name={name} size={38} />}
        <div className="min-w-0 grow">
          <div className="truncate text-sm font-semibold text-gray-900">{name}</div>
          {peer && <div className="truncate text-xs text-gray-500">{peer.active ? t(`roles.${peer.role}`) : t('chat.inactive')}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          if (e.currentTarget.scrollTop < 60) loadOlder();
        }}
        className="min-h-0 grow overflow-y-auto bg-brand-25 px-3 py-2 dark:bg-gray-50"
      >
        {history.isLoading && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {history.isFetchingNextPage && (
          <div className="flex justify-center py-2">
            <Spinner />
          </div>
        )}
        {history.isSuccess && !messages.length && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <span className="rounded-2xl bg-black/20 px-4 py-2 text-sm text-on-brand">
              {t('chat.noMessages')}
              <br />
              <span className="text-xs opacity-90">{t('chat.startHint')}</span>
            </span>
          </div>
        )}
        {messages.map((m, i) => {
          const mine = m.senderId === meId;
          const prev = messages[i - 1];
          const newDay = !prev || !dt(prev.createdAt).hasSame(dt(m.createdAt), 'day');
          const grouped = !newDay && prev?.senderId === m.senderId;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="sticky top-0 z-[1] my-2 flex justify-center">
                  <span className="rounded-full bg-black/25 px-3 py-0.5 text-xs font-medium text-on-brand backdrop-blur-sm">{dayLabel(m.createdAt, t)}</span>
                </div>
              )}
              <div className={cn('flex', mine ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-2')}>
                <div
                  onClick={mine ? (e) => openMenu(m, e) : undefined}
                  onContextMenu={mine ? (e) => openMenu(m, e) : undefined}
                  className={cn(
                    'relative max-w-[82%] rounded-2xl px-3 py-1.5 text-sm shadow-sm',
                    mine && 'cursor-pointer',
                    menu?.msg.id === m.id && 'ring-2 ring-brand-300',
                    mine ? 'bg-brand-500 text-on-brand dark:bg-brand-700' : 'bg-white text-gray-900',
                    !grouped && (mine ? 'rounded-br-md' : 'rounded-bl-md'),
                  )}
                >
                  <span className="whitespace-pre-wrap break-words">{m.body}</span>
                  {/* Vaqt va ✓ — Telegram'dagidek matn oxirida, o'ng pastda */}
                  <span className={cn('float-right ml-2 mt-1.5 flex translate-y-0.5 items-center gap-0.5 text-[11px] leading-none', mine ? 'text-on-brand/80' : 'text-gray-500')}>
                    {m.editedAt && <span className="mr-0.5 italic">{t('chat.edited')}</span>}
                    {dt(m.createdAt).toFormat('HH:mm')}
                    {mine && <Ticks read={!!m.readAt} className="h-3.5 w-3.5" />}
                  </span>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      {canSend && editing && (
        <div className="flex shrink-0 items-center gap-3 border-t border-gray-200 px-3 py-1.5">
          <Pencil className="h-4 w-4 shrink-0 text-brand-500" />
          <div className="min-w-0 grow border-l-2 border-brand-500 pl-2">
            <div className="text-xs font-semibold text-brand-500">{t('chat.editing')}</div>
            <div className="truncate text-xs text-gray-500">{editing.body}</div>
          </div>
          <button type="button" onClick={cancelEdit} aria-label={t('chat.cancelEdit')} title={t('chat.cancelEdit')} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {canSend ? (
        <form
          className={cn('flex shrink-0 items-end gap-2 p-2', !editing && 'border-t border-gray-200')}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter — yuborish, Shift+Enter — yangi qator (Telegram kabi)
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape' && editing) {
                e.preventDefault();
                cancelEdit();
              } else if (e.key === 'ArrowUp' && !text) {
                // Telegram kabi: bo'sh maydonda ↑ — oxirgi o'z xabarini tahrirlash
                const lastMine = messages.findLast((x) => x.senderId === meId);
                if (lastMine) {
                  e.preventDefault();
                  startEdit(lastMine);
                }
              }
            }}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            className="max-h-[140px] min-h-10 grow resize-none rounded-2xl border border-gray-200 bg-gray-50 px-3.5 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-500 focus:border-brand-500 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <button
            type="submit"
            disabled={!text.trim() || send.isPending || edit.isPending}
            aria-label={editing ? t('common.save') : t('chat.send')}
            title={editing ? t('common.save') : t('chat.send')}
            className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand-500 text-on-brand transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:cursor-default disabled:opacity-40"
          >
            {editing ? <Check className="h-5 w-5" /> : <SendHorizontal className="h-5 w-5" />}
          </button>
        </form>
      ) : (
        <div className="shrink-0 border-t border-gray-200 p-3 text-center text-xs text-gray-500">{t('chat.inactiveHint')}</div>
      )}

      {menu && (
        <MessageMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(canSend ? [{ icon: Pencil, label: t('chat.edit'), onClick: () => startEdit(menu.msg) }] : []),
            { icon: Trash2, label: t('chat.delete'), danger: true, onClick: () => setToDelete(menu.msg) },
          ]}
        />
      )}
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        loading={remove.isPending}
        title={t('chat.deleteTitle')}
        text={t('chat.deleteText')}
      />
    </>
  );
}

/** Xabar ustida o'ng tugma / bosilganda chiqadigan menyu (Telegram kabi). Body'ga portal: chat oynasining transform'i fixed'ni buzmasin */
function MessageMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: { icon: typeof Pencil; label: string; danger?: boolean; onClick: () => void }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Oyna chetidan chiqmasin
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, []);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={pos}
      className="fixed z-[58] min-w-[170px] animate-pop-in overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-pop"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            it.onClick();
          }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-3 px-3.5 py-2 text-left text-sm outline-none hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:ring-0 focus-visible:ring-offset-0',
            it.danger ? 'text-red-600' : 'text-gray-900',
          )}
        >
          <it.icon className="h-4 w-4" />
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
