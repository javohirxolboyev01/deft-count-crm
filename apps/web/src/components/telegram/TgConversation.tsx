import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  CornerUpLeft,
  Forward,
  Languages,
  Pause,
  Pencil,
  Play,
  Pin,
  PinOff,
  Reply,
  SendHorizontal,
  Smile,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { removeTgMessages, tgKeys, upsertTgMessage, useTgTyping, type TgPage } from '@/lib/tgCache';
import type { TgDialog, TgMessage } from '@/lib/types';
import { TgMediaView, isBubbleless, isVisual } from './TgMedia';
import { FormattedText, KIND_EMOJI, Tail, TgAvatar, TgTicks, TypingDots, dayLabel, dtOf, isOnline, statusText } from './tgUi';
import { IconButton } from './TgChatList';
import { DeleteConfirm, ForwardPicker, TranslateView } from './TgDialogs';
import { TgViewer } from './TgViewer';
import { closeTrack, cycleRate, useTgPlayer } from '@/lib/tgPlayer';

const PAGE = 40;

/** Yuborilayotgan (hali Telegram tasdiqlamagan) xabar — Telegram'dagidek soat belgisi bilan */
interface Pending {
  key: number;
  text: string;
  replyToId: number | null;
  date: number;
  failed: boolean;
}

/** Telegram 48 soat ichida tahrirlashga ruxsat beradi; stiker, ovozli xabar va h.k. matnini o'zgartirib bo'lmaydi */
const EDIT_WINDOW_SEC = 48 * 3600;
const CAPTION_KINDS = new Set(['PHOTO', 'VIDEO', 'FILE', 'AUDIO', 'GIF']);
function canEdit(m: TgMessage) {
  return m.out && !m.service && !m.forwardedFrom && Date.now() / 1000 - m.date < EDIT_WINDOW_SEC && (!m.media || CAPTION_KINDS.has(m.media.kind));
}

type MenuEntry = { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean; chevron?: boolean } | 'sep';

export function TgConversation({
  peerId,
  dialog,
  dialogs,
  onBack,
  onOpenChat,
}: {
  peerId: string;
  dialog: TgDialog | null;
  dialogs: TgDialog[];
  onBack: () => void;
  onOpenChat: (peerId: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  const lastIdRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [replyTo, setReplyTo] = useState<TgMessage | null>(null);
  const [menu, setMenu] = useState<{ m: TgMessage; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [highlight, setHighlight] = useState<number | null>(null);
  // Telegram'dagi «Tanlash» rejimi: bir nechta xabarni birdan uzatish/o'chirish/nusxalash
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [editing, setEditing] = useState<TgMessage | null>(null);
  const [deleting, setDeleting] = useState<number[] | null>(null);
  const [forwarding, setForwarding] = useState<number[] | null>(null);
  const [translating, setTranslating] = useState<TgMessage | null>(null);
  const [pinIdx, setPinIdx] = useState(0);
  // Kanalga faqat egasi/admin yozadi; dialog hali kelmagan bo'lsa — yozish mumkin deb turiladi
  const canWrite = dialog?.canWrite ?? true;
  // Kanal va superguruh ("-100…"): o'chirish har doim hammada
  const isChannelLike = peerId.startsWith('-100');
  const isTyping = useTgTyping();
  // «O'qilmagan xabarlar» chizig'i: chat ochilgan paytdagi holat (keyin o'qilgan qilinsa ham joyida qoladi)
  const unreadFrom = useRef<number | null>(dialog && dialog.unread > 0 ? dialog.readInboxMaxId : null);

  const history = useInfiniteQuery({
    queryKey: tgKeys.messages(peerId),
    queryFn: ({ pageParam }) => api.get<TgPage>(`/tg/dialogs/${peerId}/messages${qs({ before: pageParam, limit: PAGE })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore && last.items.length ? last.items[0].id : undefined),
    // Yangi xabarlar SSE orqali keshga qo'shiladi
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  const messages = useMemo(() => (history.data?.pages ?? []).slice().reverse().flatMap((p) => p.items), [history.data]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const readOutbox = dialog?.readOutboxMaxId ?? 0;
  const title = dialog?.title ?? '';
  const authorOf = (r: TgMessage) => (r.out ? t('tg.you') : r.senderName ?? title);

  // Qadalgan xabarlar (eng yangisi birinchi): tepadagi panel; SSE `tg-pinned` yangilaydi
  const pinnedQ = useQuery({
    queryKey: tgKeys.pinned(peerId),
    queryFn: () => api.get<TgMessage[]>(`/tg/dialogs/${peerId}/pinned`),
    staleTime: 60_000,
  });
  const pinned = useMemo(() => pinnedQ.data ?? [], [pinnedQ.data]);
  const pinnedIds = useMemo(() => new Set(pinned.map((m) => m.id)), [pinned]);
  const curPin = pinned.length ? pinned[Math.min(pinIdx, pinned.length - 1)] : null;

  // Chat ochiq va sahifa ko'rinib turgan bo'lsa — Telegram'da ham o'qilgan qilinadi
  const unread = dialog?.unread ?? 0;
  useEffect(() => {
    if (!unread || document.hidden) return;
    const id = setTimeout(() => void api.post(`/tg/dialogs/${peerId}/read`).catch(() => undefined), 500);
    return () => clearTimeout(id);
  }, [peerId, unread]);
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && unread) void api.post(`/tg/dialogs/${peerId}/read`).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [peerId, unread]);

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const send = useCallback(
    async (p: Pending) => {
      try {
        const m = await api.post<TgMessage>(`/tg/dialogs/${peerId}/messages`, { text: p.text, replyTo: p.replyToId ?? undefined });
        upsertTgMessage(qc, peerId, m);
        setPending((list) => list.filter((x) => x.key !== p.key));
        void qc.invalidateQueries({ queryKey: tgKeys.dialogs });
      } catch (e) {
        toast.error(errorText(e, t));
        setPending((list) => list.map((x) => (x.key === p.key ? { ...x, failed: true } : x)));
      }
    },
    [peerId, qc, t],
  );

  const submit = (text: string) => {
    const p: Pending = { key: Date.now(), text, replyToId: replyTo?.id ?? null, date: Math.floor(Date.now() / 1000), failed: false };
    setPending((list) => [...list, p]);
    setReplyTo(null);
    void send(p);
    requestAnimationFrame(() => scrollToBottom());
  };

  const saveEdit = async (m: TgMessage, text: string) => {
    setEditing(null);
    if (text === m.text) return;
    // Darhol ko'rinadi (Telegram kabi), server javobi bilan almashtiriladi
    upsertTgMessage(qc, peerId, { ...m, text, entities: [], edited: true }, false);
    try {
      const r = await api.patch<TgMessage>(`/tg/dialogs/${peerId}/messages/${m.id}`, { text });
      upsertTgMessage(qc, peerId, r, false);
    } catch (e) {
      toast.error(errorText(e, t));
      upsertTgMessage(qc, peerId, m, false);
    }
  };

  const doDelete = async (ids: number[], revoke: boolean) => {
    setSelected(null);
    removeTgMessages(qc, peerId, ids);
    try {
      await api.post(`/tg/dialogs/${peerId}/messages/delete`, { ids, revoke: revoke || isChannelLike });
      if (ids.some((id) => pinnedIds.has(id))) void qc.invalidateQueries({ queryKey: tgKeys.pinned(peerId) });
    } catch (e) {
      toast.error(errorText(e, t));
      void qc.invalidateQueries({ queryKey: tgKeys.messages(peerId) });
    }
  };

  const togglePin = async (m: TgMessage) => {
    const unpin = pinnedIds.has(m.id);
    try {
      await api.post(`/tg/dialogs/${peerId}/messages/${m.id}/pin`, { unpin });
      if (!unpin) setPinIdx(0);
      toast.success(t(unpin ? 'tg.unpinned' : 'tg.pinned'));
      void qc.invalidateQueries({ queryKey: tgKeys.pinned(peerId) });
    } catch (e) {
      toast.error(errorText(e, t));
    }
  };

  const copyText = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success(t('tg.copied')));

  const toggleSelect = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size ? next : null;
    });

  // O'chirish oynasidagi «… da ham o'chirilsin» tanlovi — Telegram qoidasi bo'yicha
  const revokeLabel = (ids: number[]) => {
    if (isChannelLike) return null;
    if (dialog?.kind === 'USER') return t('tg.deleteAlsoFor', { name: title });
    if (dialog?.kind === 'GROUP' && ids.every((id) => byId.get(id)?.out)) return t('tg.deleteForAll');
    return null;
  };
  const canDelete = (m: TgMessage) => !isChannelLike || m.out || (dialog?.kind === 'CHANNEL' && canWrite);

  const menuItems = (m: TgMessage): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (canWrite) items.push({ icon: Reply, label: t('tg.reply'), onClick: () => setReplyTo(m) });
    if (m.text) {
      items.push({ icon: Languages, label: t('tg.translate'), onClick: () => setTranslating(m) });
      items.push({ icon: Copy, label: t('tg.copyText'), onClick: () => copyText(m.text) });
    }
    items.push('sep');
    if (canEdit(m)) items.push({ icon: Pencil, label: t('tg.edit'), onClick: () => setEditing(m) });
    if (canWrite || dialog?.kind === 'USER' || dialog?.kind === 'BOT') {
      const on = pinnedIds.has(m.id);
      items.push({ icon: on ? PinOff : Pin, label: t(on ? 'tg.unpin' : 'tg.pin'), onClick: () => void togglePin(m) });
    }
    items.push({ icon: Forward, label: t('tg.forward'), chevron: true, onClick: () => setForwarding([m.id]) });
    items.push({ icon: CheckCircle2, label: t('tg.select'), onClick: () => setSelected(new Set([m.id])) });
    if (canDelete(m)) {
      items.push('sep');
      items.push({ icon: Trash2, label: t('common.delete'), danger: true, onClick: () => setDeleting([m.id]) });
    }
    return items.filter((x, i, a) => x !== 'sep' || (i > 0 && i < a.length - 1 && a[i - 1] !== 'sep'));
  };

  const selIds = selected ? [...selected].sort((a, b) => a - b) : [];
  const selCanDelete = selIds.every((id) => {
    const m = byId.get(id);
    return !!m && canDelete(m);
  });

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
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (lastIdRef.current === null) {
      // Birinchi ochilish: o'qilmaganlar bo'lsa — chiziqqa, bo'lmasa pastga
      const sep = el.querySelector('[data-unread-sep]') as HTMLElement | null;
      if (sep) el.scrollTop = sep.offsetTop - 60;
      else el.scrollTop = el.scrollHeight;
    } else if (nearBottom || last.out) el.scrollTop = el.scrollHeight;
    lastIdRef.current = last.id;
  }, [messages]);

  // Escape — suhbatni yopish (Telegram kabi)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || menu || document.querySelector('[aria-modal="true"]')) return;
      if (selected) setSelected(null);
      else if (editing) setEditing(null);
      else if (replyTo) setReplyTo(null);
      else onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, replyTo, editing, selected, onBack]);

  const loadOlder = () => {
    const el = scrollRef.current;
    if (!history.hasNextPage || history.isFetchingNextPage || !el) return;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    void history.fetchNextPage();
  };

  const jumpTo = (id: number) => {
    const el = scrollRef.current?.querySelector(`[data-mid="${id}"]`) as HTMLElement | null;
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(id);
    setTimeout(() => setHighlight(null), 1600);
    return true;
  };

  /** Javob/qadalgan xabarga o'tish: hali yuklanmagan bo'lsa eskiroq sahifalar yuklanadi (ko'pi bilan ~400 xabar) */
  const jumpToAny = async (id: number) => {
    if (jumpTo(id)) return;
    let more = history.hasNextPage;
    for (let i = 0; i < 10 && more; i++) {
      const el = scrollRef.current;
      if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
      const r = await history.fetchNextPage();
      if (r.data?.pages.some((p) => p.items.some((x) => x.id === id))) break;
      more = !!r.hasNextPage;
    }
    setTimeout(() => {
      if (!jumpTo(id)) toast.message(t('tg.messageNotFound'));
    }, 60);
  };

  const typing = isTyping(peerId);
  const status = dialog ? statusText(dialog, t) : '';

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      {/* Sarlavha */}
      {selected ? (
        <div className="relative z-[2] flex h-14 shrink-0 items-center gap-1 px-2 shadow-[0_1px_0_var(--tg-border)] sm:gap-2 sm:px-4" style={{ background: 'var(--tg-bg)' }}>
          <IconButton label={t('common.cancel')} onClick={() => setSelected(null)}>
            <X className="h-6 w-6" />
          </IconButton>
          <div className="min-w-0 grow truncate text-base font-medium">{t('tg.selectedCount', { count: selIds.length })}</div>
          <SelBtn icon={Copy} label={t('tg.copy')} onClick={() => {
            copyText(selIds.map((id) => byId.get(id)?.text ?? '').filter(Boolean).join('\n\n'));
            setSelected(null);
          }} />
          <SelBtn icon={Forward} label={t('tg.forward')} count={selIds.length} onClick={() => setForwarding(selIds)} />
          {selCanDelete && <SelBtn icon={Trash2} label={t('common.delete')} count={selIds.length} danger onClick={() => setDeleting(selIds)} />}
        </div>
      ) : (
      <div className="relative z-[2] flex h-14 shrink-0 items-center gap-3 px-2 shadow-[0_1px_0_var(--tg-border)] sm:px-4" style={{ background: 'var(--tg-bg)' }}>
        <IconButton label={t('common.back')} onClick={onBack} className="md:hidden">
          <ArrowLeft className="h-6 w-6" />
        </IconButton>
        <TgAvatar peerId={peerId} name={title || '?'} photoId={dialog?.photoId ?? null} size={40} />
        <div className="min-w-0 grow">
          <div className="truncate text-base font-medium leading-tight">{title}</div>
          <div className={cn('truncate text-sm leading-tight', typing || (dialog && isOnline(dialog.status)) ? 'text-[var(--tg-link)]' : 'text-[var(--tg-secondary)]')}>
            {typing ? (
              <span className="inline-flex items-center gap-1">
                {t('tg.typing')}
                <TypingDots />
              </span>
            ) : (
              <>
                {status}
                {dialog?.phone && dialog.kind === 'USER' && <span className="text-[var(--tg-secondary)]"> · {dialog.phone}</span>}
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Ovozli/dumaloq xabar yoki audio o'ynayotganda — Telegram kabi tepada pleer paneli */}
      <PlayerBar peerId={peerId} onJump={(id) => void jumpToAny(id)} />

      {/* Qadalgan xabar (Telegram kabi: bosilsa unga o'tadi va keyingisini ko'rsatadi) */}
      {curPin && (
        <PinnedBar
          m={curPin}
          index={Math.min(pinIdx, pinned.length - 1)}
          total={pinned.length}
          onOpen={() => {
            void jumpToAny(curPin.id);
            setPinIdx((i) => (i + 1) % pinned.length);
          }}
          onUnpin={canWrite || dialog?.kind === 'USER' || dialog?.kind === 'BOT' ? () => void togglePin(curPin) : undefined}
        />
      )}

      {/* Xabarlar */}
      <div className="tg-chat-bg relative min-h-0 grow">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop < 120) loadOlder();
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
          }}
          className="tg-scroll relative h-full overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto flex min-h-full max-w-[728px] flex-col justify-end px-2 pb-2 pt-2 sm:px-4">
            {history.isFetchingNextPage && <Pill>{t('common.loading')}</Pill>}
            {history.isLoading && <Pill>{t('common.loading')}</Pill>}
            {history.error && <Pill>{errorText(history.error, t)}</Pill>}
            {history.isSuccess && !messages.length && !pending.length && <Pill>{t('tg.noMessages')}</Pill>}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const day = (x: TgMessage) => dtOf(x.date).toISODate();
              const newDay = !prev || day(prev) !== day(m);
              const showUnread = unreadFrom.current !== null && !m.out && m.id > unreadFrom.current && !(prev && !prev.out && prev.id > unreadFrom.current);
              const same = (x?: TgMessage) => !!x && !x.service && !m.service && x.out === m.out && x.senderId === m.senderId && day(x) === day(m);
              return (
                <Fragment key={m.id}>
                  {newDay && <DateSep sec={m.date} />}
                  {showUnread && (
                    <div data-unread-sep className="-mx-4 my-2 py-1 text-center text-sm font-medium text-[var(--tg-secondary)]" style={{ background: 'var(--tg-bg)', opacity: 0.94 }}>
                      {t('tg.unreadMessages')}
                    </div>
                  )}
                  {m.service ? (
                    <Pill>{t('tg.service')}</Pill>
                  ) : (
                    <Bubble
                      peerId={peerId}
                      m={m}
                      first={!same(prev) || showUnread}
                      last={!same(next)}
                      readOutbox={readOutbox}
                      group={dialog?.kind === 'GROUP'}
                      reply={m.replyToId ? (byId.get(m.replyToId) ?? null) : null}
                      replyName={authorOf}
                      highlighted={highlight === m.id}
                      onJump={(id) => void jumpToAny(id)}
                      onMenu={(x, y) => setMenu({ m, x, y })}
                      onReply={() => canWrite && setReplyTo(m)}
                      selecting={!!selected}
                      selected={!!selected?.has(m.id)}
                      onToggle={() => toggleSelect(m.id)}
                    />
                  )}
                </Fragment>
              );
            })}
            {pending.map((p, i) => (
              <PendingBubble
                key={p.key}
                p={p}
                first={i === 0 && !messages.at(-1)?.out}
                last={i === pending.length - 1}
                onRetry={() => {
                  setPending((list) => list.map((x) => (x.key === p.key ? { ...x, failed: false } : x)));
                  void send({ ...p, failed: false });
                }}
                onRemove={() => setPending((list) => list.filter((x) => x.key !== p.key))}
              />
            ))}
          </div>
        </div>

        {/* Pastga tushish tugmasi */}
        {!atBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label={t('tg.scrollDown')}
            className="absolute bottom-3 right-3 z-[2] flex h-[54px] w-[54px] cursor-pointer items-center justify-center rounded-full text-[var(--tg-secondary)] shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-transform active:scale-95 sm:right-5"
            style={{ background: 'var(--tg-bg)' }}
          >
            <ChevronDown className="h-7 w-7" />
            {unread > 0 && (
              <span className="absolute -top-1.5 min-w-[22px] rounded-full px-1.5 text-center text-[13px] font-medium leading-[22px] text-on-brand" style={{ background: dialog?.muted ? 'var(--tg-badge-muted)' : 'var(--tg-badge)' }}>
                {unread}
              </span>
            )}
          </button>
        )}
      </div>

      {canWrite ? (
        <Composer
          peerId={peerId}
          replyTo={replyTo}
          replyName={replyTo ? (replyTo.out ? t('tg.you') : replyTo.senderName ?? title) : ''}
          onCancelReply={() => setReplyTo(null)}
          onSubmit={submit}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onSaveEdit={(text) => editing && void saveEdit(editing, text)}
          onEditLast={() => {
            // Telegram kabi: bo'sh maydonda ↑ — oxirgi o'z xabarini tahrirlash
            const last = [...messages].reverse().find(canEdit);
            if (last) setEditing(last);
            return !!last;
          }}
        />
      ) : (
        <div className="tg-chat-bg relative shrink-0">
          <div className="relative mx-auto flex max-w-[728px] justify-center px-2 pb-2 sm:px-4 sm:pb-4">
            <div className="w-full rounded-[15px] py-4 text-center text-[15px] font-medium text-[var(--tg-secondary)] shadow-[var(--tg-shadow)]" style={{ background: 'var(--tg-bg)' }}>
              {t(dialog?.kind === 'CHANNEL' ? 'tg.channelReadOnly' : 'tg.cannotWrite')}
            </div>
          </div>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.m)} />}
      {deleting && (
        <DeleteConfirm count={deleting.length} revokeLabel={revokeLabel(deleting)} onConfirm={(revoke) => void doDelete(deleting, revoke)} onClose={() => setDeleting(null)} />
      )}
      {forwarding && (
        <ForwardPicker
          fromPeerId={peerId}
          ids={forwarding}
          dialogs={dialogs}
          onDone={(to) => {
            setSelected(null);
            if (to !== peerId) onOpenChat(to);
          }}
          onClose={() => setForwarding(null)}
        />
      )}
      {translating && <TranslateView peerId={peerId} m={translating} onClose={() => setTranslating(null)} />}
      <TgViewer peerId={peerId} messages={messages} authorOf={authorOf} onForward={(id) => setForwarding([id])} />
    </div>
  );
}

function PlayerBar({ peerId, onJump }: { peerId: string; onJump: (id: number) => void }) {
  const { t } = useTranslation();
  const { track, rate, paused } = useTgPlayer();
  if (!track) return null;
  const d = dtOf(track.date);
  return (
    <div className="relative z-[1] flex h-11 shrink-0 items-center gap-1 px-2 shadow-[0_1px_0_var(--tg-border)] sm:px-4" style={{ background: 'var(--tg-bg)' }}>
      <IconButton label={paused ? 'Play' : 'Pause'} onClick={() => (paused ? void track.el.play().catch(() => undefined) : track.el.pause())} className="text-[var(--tg-primary)]">
        {paused ? <Play className="ml-0.5 h-5 w-5 fill-current" /> : <Pause className="h-5 w-5 fill-current" />}
      </IconButton>
      <button
        type="button"
        onClick={() => track.peerId === peerId && onJump(track.msgId)}
        className="flex min-w-0 grow cursor-pointer items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--tg-hover)]"
      >
        <span className="truncate text-sm font-medium">{track.title}</span>
        <span className="shrink-0 text-[13px] text-[var(--tg-secondary)]">
          {t(`tg.kind.${track.kind}`)} · {d.toFormat('dd.MM.yy HH:mm')}
        </span>
      </button>
      {track.kind !== 'AUDIO' && (
        <button
          type="button"
          onClick={cycleRate}
          title={t('tg.speed')}
          className={cn('h-8 min-w-[40px] cursor-pointer rounded-md px-1 text-[13px] font-semibold hover:bg-[var(--tg-hover)]', rate !== 1 ? 'text-[var(--tg-primary)]' : 'text-[var(--tg-secondary)]')}
        >
          {rate}x
        </button>
      )}
      <IconButton label={t('common.close')} onClick={closeTrack}>
        <X className="h-5 w-5" />
      </IconButton>
    </div>
  );
}

function SelBtn({ icon: Icon, label, count, danger, onClick }: { icon: LucideIcon; label: string; count?: number; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[15px] font-semibold uppercase transition-colors hover:bg-[var(--tg-hover)]',
        danger ? 'text-[var(--tg-danger)]' : 'text-[var(--tg-primary)]',
      )}
    >
      <Icon className="h-5 w-5" />
      <span className="hidden sm:inline">
        {label}
        {count ? ` ${count}` : ''}
      </span>
    </button>
  );
}

function PinnedBar({ m, index, total, onOpen, onUnpin }: { m: TgMessage; index: number; total: number; onOpen: () => void; onUnpin?: () => void }) {
  const { t } = useTranslation();
  // Chap chiziq bo'laklari: nechta qadalgan xabar borligi va qaysi biri ko'rsatilayotgani (Telegram kabi, ko'pi bilan 4)
  const segs = Math.min(total, 4);
  const active = total <= 4 ? total - 1 - index : Math.max(0, 3 - Math.min(index, 3));
  const preview = m.text || (m.media ? `${KIND_EMOJI[m.media.kind]} ${t(`tg.kind.${m.media.kind}`)}` : '');
  return (
    <div className="relative z-[1] flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_var(--tg-border)] sm:px-4" style={{ background: 'var(--tg-bg)' }}>
      <button type="button" onClick={onOpen} className="flex min-w-0 grow cursor-pointer items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 text-left transition-colors hover:bg-[var(--tg-hover)]">
        <span className="flex h-9 w-[3px] shrink-0 flex-col gap-[2px]">
          {Array.from({ length: segs }, (_, i) => (
            <span key={i} className="min-h-0 grow rounded-full" style={{ background: i === active ? 'var(--tg-primary)' : 'rgba(var(--tg-primary-rgb),0.35)' }} />
          ))}
        </span>
        <span className="min-w-0 grow">
          <span className="block truncate text-sm font-medium text-[var(--tg-primary)]">
            {t('tg.pinnedMessage')}
            {total > 1 && ` #${total - index}`}
          </span>
          <span className="block truncate text-sm">{preview}</span>
        </span>
      </button>
      {onUnpin && (
        <IconButton label={t('tg.unpin')} onClick={onUnpin}>
          <PinOff className="h-5 w-5" />
        </IconButton>
      )}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-1.5 flex justify-center">
      <span className="rounded-full px-2.5 py-[3px] text-sm font-medium text-on-brand backdrop-blur-sm" style={{ background: 'var(--tg-pill)' }}>
        {children}
      </span>
    </div>
  );
}

function DateSep({ sec }: { sec: number }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-1.5 z-[1] my-2 flex justify-center">
      <span className="rounded-full px-2.5 py-[3px] text-sm font-medium text-on-brand backdrop-blur-sm" style={{ background: 'var(--tg-pill)' }}>
        {dayLabel(sec, t)}
      </span>
    </div>
  );
}

/** Pufakcha burchaklari Telegram kabi: guruh ichida yon tomondagi burchaklar kichik, oxirgisida dum */
function corners(out: boolean, first: boolean, last: boolean) {
  const big = 15;
  const small = 6;
  if (out) return { borderRadius: `${big}px ${first ? big : small}px ${last ? 0 : small}px ${big}px` };
  return { borderRadius: `${first ? big : small}px ${big}px ${big}px ${last ? 0 : small}px` };
}

function Bubble({
  peerId,
  m,
  first,
  last,
  readOutbox,
  group,
  reply,
  replyName,
  highlighted,
  onJump,
  onMenu,
  onReply,
  selecting,
  selected,
  onToggle,
}: {
  peerId: string;
  m: TgMessage;
  first: boolean;
  last: boolean;
  readOutbox: number;
  group: boolean;
  reply: TgMessage | null;
  replyName: (r: TgMessage) => string;
  highlighted: boolean;
  onJump: (id: number) => void;
  onMenu: (x: number, y: number) => void;
  onReply: () => void;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // Sensorli ekran: barmoq bosib turilsa menyu ochiladi (iOS'da contextmenu hodisasi yo'q)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  const media = m.media;
  const bubbleless = isBubbleless(m);
  const visual = !!media && isVisual(m);
  const visualOnly = visual && !m.text;
  const hasHeader = (group && !m.out && first && !!m.senderName) || !!m.forwardedFrom || !!m.replyToId;
  const meta = m.out ? 'var(--tg-out-meta)' : 'var(--tg-in-meta)';
  const link = m.out ? 'text-[var(--tg-out-text)] underline' : 'text-[var(--tg-link)]';
  const showAvatar = group && !m.out;

  const timeInner = (
    <>
      {m.sentBy && <span className="mr-1 max-w-[110px] truncate">{m.sentBy}</span>}
      {m.edited && <span className="mr-1">{t('tg.edited')}</span>}
      <span>{dtOf(m.date).toFormat('HH:mm')}</span>
      {m.out && <TgTicks read={m.id <= readOutbox} className="-mr-0.5 ml-0.5" />}
    </>
  );
  // Rasm/stiker ustida — qorong'i yarim shaffof "tabletka"
  const overlayTime = (
    <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center rounded-full bg-black/45 px-1.5 py-[1px] text-xs text-on-brand">{timeInner}</span>
  );
  const nameColor = m.senderId ? senderColor(m.senderId) : 'var(--tg-primary)';
  const r = corners(m.out, first, last);

  return (
    <div
      data-mid={m.id}
      className={cn(
        'relative flex items-end gap-2',
        m.out ? 'justify-end' : 'justify-start',
        first ? 'mt-2' : 'mt-[2px]',
        highlighted && 'tg-highlight rounded-lg',
        selecting && 'cursor-pointer rounded-lg pl-9',
        selected && 'bg-[rgba(var(--tg-primary-rgb),0.12)]',
      )}
      onClickCapture={(e) => {
        // Tanlash rejimida bosish — belgilash (havola/media ochilmaydi)
        if (!selecting) return;
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => {
        if (selecting || window.getSelection()?.toString()) return;
        e.preventDefault();
        onReply();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        cancelPress();
        onMenu(e.clientX, e.clientY);
      }}
      onTouchStart={(e) => {
        if (selecting) return;
        const p = e.touches[0];
        const x = p.clientX;
        const y = p.clientY;
        cancelPress();
        press.current = setTimeout(() => {
          press.current = null;
          navigator.vibrate?.(10);
          onMenu(x, y);
        }, 450);
      }}
      onTouchMove={cancelPress}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
    >
      {selecting && (
        <span
          className="absolute bottom-1 left-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 text-on-brand"
          style={selected ? { background: 'var(--tg-primary)', borderColor: 'var(--tg-primary)' } : { borderColor: 'rgba(255,255,255,0.9)', background: 'rgba(0,0,0,0.12)' }}
        >
          {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
        </span>
      )}
      {showAvatar && <span className="w-[34px] shrink-0">{last && <TgAvatar peerId={m.senderId ?? '0'} name={m.senderName ?? '?'} size={34} />}</span>}
      <div
        className={cn('relative max-w-[min(480px,calc(100%-48px))]', !bubbleless && 'shadow-[var(--tg-shadow)]')}
        style={bubbleless ? undefined : { ...r, background: m.out ? 'var(--tg-out)' : 'var(--tg-in)', color: m.out ? 'var(--tg-out-text)' : 'var(--tg-text)' }}
      >
        {!bubbleless && last && <Tail out={m.out} />}
        {hasHeader && (
          <div className={cn(visualOnly ? 'px-2.5 pb-1 pt-1.5' : 'px-2.5 pt-1.5')}>
            {group && !m.out && first && m.senderName && (
              <div className="truncate text-sm font-medium" style={{ color: nameColor }}>
                {m.senderName}
              </div>
            )}
            {m.forwardedFrom && (
              <div className="truncate text-sm" style={{ color: m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)' }}>
                {t('tg.forwardedFrom')} <span className="font-medium">{m.forwardedFrom}</span>
              </div>
            )}
            {m.replyToId && (
              <button
                type="button"
                onClick={() => m.replyToId && onJump(m.replyToId)}
                className="mb-0.5 mt-1 flex w-full min-w-[160px] cursor-pointer rounded-[4px] py-0.5 pl-2 pr-2 text-left text-sm"
                style={{
                  borderLeft: `3px solid ${m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)'}`,
                  background: m.out ? 'var(--tg-out-quote)' : 'rgba(var(--tg-primary-rgb),0.08)',
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium" style={{ color: m.out ? 'var(--tg-out-accent)' : 'var(--tg-primary)' }}>
                    {reply ? replyName(reply) : t('tg.reply')}
                  </span>
                  <span className="block truncate opacity-80">
                    {reply ? reply.text || (reply.media ? `${KIND_EMOJI[reply.media.kind]} ${t(`tg.kind.${reply.media.kind}`)}` : '') : t('tg.replyTo')}
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
        {media && (
          <div className={cn(!visual && !bubbleless && 'px-2.5 pt-1.5', !visual && !m.text && !bubbleless && 'pb-1.5', visual && hasHeader && 'pt-0.5')}>
            <TgMediaView
              peerId={peerId}
              m={m}
              author={replyName(m)}
              overlay={visualOnly || bubbleless ? overlayTime : undefined}
              radiusClass={cn(visual && !hasHeader && (m.out ? 'rounded-t-[15px]' : 'rounded-t-[15px]'), visualOnly && 'rounded-b-[15px]', visualOnly && last && (m.out ? 'rounded-br-none' : 'rounded-bl-none'))}
            />
          </div>
        )}
        {m.text ? (
          <div className="px-2.5 pb-1.5 pt-1.5 text-base leading-[1.3125]" style={{ wordBreak: 'break-word' }}>
            <span className="whitespace-pre-wrap">
              <FormattedText text={m.text} entities={m.entities} linkClass={link} />
            </span>
            {/* Vaqt — oxirgi qator oxirida (Telegram kabi o'ngga suzadi) */}
            <span className="relative top-[5px] float-right ml-2 flex select-none items-center text-xs" style={{ color: meta }}>
              {timeInner}
            </span>
          </div>
        ) : (
          !visualOnly &&
          !bubbleless && (
            <div className="-mt-5 flex select-none justify-end px-2.5 pb-1.5 text-xs" style={{ color: meta }}>
              {timeInner}
            </div>
          )
        )}
      </div>
    </div>
  );
}

const SENDER_COLORS = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];
function senderColor(id: string) {
  try {
    return SENDER_COLORS[(Number(BigInt(id) % 7n) + 7) % 7];
  } catch {
    return SENDER_COLORS[0];
  }
}

function PendingBubble({ p, first, last, onRetry, onRemove }: { p: Pending; first: boolean; last: boolean; onRetry: () => void; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex justify-end', first ? 'mt-2' : 'mt-[2px]')}>
      {p.failed && (
        <div className="mr-2 flex items-center gap-1 self-center">
          <button type="button" onClick={onRetry} title={t('tg.retry')} className="cursor-pointer text-[var(--tg-danger)]">
            <AlertCircle className="h-6 w-6" />
          </button>
          <button type="button" onClick={onRemove} title={t('common.delete')} className="cursor-pointer text-[var(--tg-secondary)]">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
      <div
        className="relative max-w-[min(480px,calc(100%-48px))] px-2.5 pb-1.5 pt-1.5 text-base leading-[1.3125] shadow-[var(--tg-shadow)]"
        style={{ ...corners(true, first, last), background: 'var(--tg-out)', color: 'var(--tg-out-text)', wordBreak: 'break-word' }}
      >
        {last && <Tail out />}
        <span className="whitespace-pre-wrap">{p.text}</span>
        <span className="relative top-[5px] float-right ml-2 flex items-center gap-1 text-xs" style={{ color: 'var(--tg-out-meta)' }}>
          {dtOf(p.date).toFormat('HH:mm')}
          {p.failed ? <AlertCircle className="h-3.5 w-3.5 text-[var(--tg-danger)]" /> : <Clock3 className="h-3.5 w-3.5" />}
        </span>
      </div>
    </div>
  );
}

// ---------------- Yozish maydoni ----------------

const EMOJI =
  '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 👋 💪 ✍️ 👀 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 💯 ✅ ❌ ⚠️ ❗ ❓ 🔥 ⭐ 🎉 🎁 📌 📎 📄 📊 📅 ⏰ 💰 💵 🏦 📞 ✉️'.split(' ');

function Composer({
  peerId,
  replyTo,
  replyName,
  onCancelReply,
  onSubmit,
  editing,
  onCancelEdit,
  onSaveEdit,
  onEditLast,
}: {
  peerId: string;
  replyTo: TgMessage | null;
  replyName: string;
  onCancelReply: () => void;
  onSubmit: (text: string) => void;
  editing: TgMessage | null;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => void;
  /** true — tahrirlanadigan xabar topildi */
  onEditLast: () => boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Emoji paneli tashqariga bosilganda yopiladi
  useEffect(() => {
    if (!emoji) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setEmoji(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [emoji]);

  // Har chatning yozilayotgan matni alohida (Telegram'dagi qoralama kabi, faqat shu brauzerda)
  const draftKey = `tg-draft:${peerId}`;
  useEffect(() => {
    try {
      setText(sessionStorage.getItem(draftKey) ?? '');
    } catch {
      setText('');
    }
    ref.current?.focus();
  }, [draftKey]);
  useEffect(() => {
    // Tahrirlash paytidagi matn qoralama emas
    if (editing) return;
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [text, draftKey, editing]);

  // Tahrirlash boshlanganda maydonga xabar matni qo'yiladi; tugaganda qoralama qaytadi
  const stash = useRef<string | null>(null);
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editingId !== null) {
      if (stash.current === null) stash.current = text;
      setText(editing?.text ?? '');
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    } else if (stash.current !== null) {
      setText(stash.current);
      stash.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    setEmoji(false);
    if (editing) onSaveEdit(body);
    else {
      setText('');
      onSubmit(body);
    }
    ref.current?.focus();
  };

  const insert = (e: string) => {
    const el = ref.current;
    if (!el) return setText((v) => v + e);
    const a = el.selectionStart ?? text.length;
    const b = el.selectionEnd ?? text.length;
    const next = text.slice(0, a) + e + text.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + e.length, a + e.length);
    });
  };

  const can = !!text.trim();
  return (
    <div className="tg-chat-bg relative shrink-0">
      <div className="relative mx-auto flex max-w-[728px] items-end gap-2 px-2 pb-2 sm:px-4 sm:pb-4">
        <div ref={boxRef} className="relative min-w-0 grow shadow-[var(--tg-shadow)]" style={{ background: 'var(--tg-bg)', borderRadius: '15px 15px 0 15px' }}>
          <Tail out />
          {editing ? (
            <div className="flex items-center gap-3 px-3 pt-2">
              <Pencil className="h-5 w-5 shrink-0 text-[var(--tg-primary)]" />
              <div className="min-w-0 grow rounded-[4px] py-0.5 pl-2 text-sm" style={{ borderLeft: '3px solid var(--tg-primary)', background: 'rgba(var(--tg-primary-rgb),0.08)' }}>
                <div className="truncate font-medium text-[var(--tg-primary)]">{t('tg.editing')}</div>
                <div className="truncate opacity-80">{editing.text || (editing.media ? t(`tg.kind.${editing.media.kind}`) : '')}</div>
              </div>
              <IconButton label={t('common.cancel')} onClick={onCancelEdit}>
                <X className="h-5 w-5" />
              </IconButton>
            </div>
          ) : replyTo && (
            <div className="flex items-center gap-3 px-3 pt-2">
              <CornerUpLeft className="h-5 w-5 shrink-0 text-[var(--tg-primary)]" />
              <div className="min-w-0 grow rounded-[4px] py-0.5 pl-2 text-sm" style={{ borderLeft: '3px solid var(--tg-primary)', background: 'rgba(var(--tg-primary-rgb),0.08)' }}>
                <div className="truncate font-medium text-[var(--tg-primary)]">{t('tg.replyingTo', { name: replyName })}</div>
                <div className="truncate opacity-80">{replyTo.text || (replyTo.media ? t(`tg.kind.${replyTo.media.kind}`) : '')}</div>
              </div>
              <IconButton label={t('common.cancel')} onClick={onCancelReply}>
                <X className="h-5 w-5" />
              </IconButton>
            </div>
          )}
          <div className="flex items-end">
            <IconButton label={t('tg.emoji')} onClick={() => setEmoji((v) => !v)} active={emoji} className="mb-[7px] ml-1">
              <Smile className="h-6 w-6" />
            </IconButton>
            <textarea
              ref={ref}
              rows={1}
              value={text}
              maxLength={4096}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter — yuborish, Shift+Enter — yangi qator (Telegram kabi)
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                } else if (e.key === 'ArrowUp' && !text && !editing && onEditLast()) {
                  e.preventDefault();
                }
              }}
              placeholder={t('tg.placeholder')}
              aria-label={t('tg.placeholder')}
              className="tg-scroll max-h-[260px] min-h-[54px] grow resize-none bg-transparent px-2 py-[15px] text-base leading-[1.3125] outline-none placeholder:text-[var(--tg-secondary)] focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          {emoji && (
            <div
              className="tg-scroll absolute bottom-full left-0 z-[3] mb-2 grid max-h-[300px] w-[min(380px,100%)] animate-pop-in grid-cols-8 gap-0.5 overflow-y-auto rounded-xl p-2 shadow-[0_4px_16px_rgba(0,0,0,0.18)]"
              style={{ background: 'var(--tg-bg)' }}
            >
              {EMOJI.map((e) => (
                <button key={e} type="button" onClick={() => insert(e)} className="flex h-9 cursor-pointer items-center justify-center rounded-lg text-[22px] hover:bg-[var(--tg-hover)]">
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!can}
          aria-label={editing ? t('common.save') : t('tg.send')}
          title={editing ? t('common.save') : t('tg.send')}
          className="flex h-[54px] w-[54px] shrink-0 cursor-pointer items-center justify-center rounded-full shadow-[var(--tg-shadow)] transition-[transform,opacity] active:scale-95 disabled:cursor-default"
          style={{ background: can ? 'var(--tg-primary)' : 'var(--tg-bg)', color: can ? '#fff' : 'var(--tg-secondary)' }}
        >
          {editing ? <Check className="h-6 w-6" strokeWidth={2.5} /> : <SendHorizontal className="h-6 w-6" />}
        </button>
      </div>
    </div>
  );
}

// ---------------- Kontekst menyu ----------------

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if ((e instanceof MouseEvent || e instanceof TouchEvent) && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('touchstart', close);
    });
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="tg fixed z-[80] w-[min(260px,calc(100vw-16px))] animate-pop-in rounded-2xl py-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.25)] backdrop-blur-xl"
      style={{ ...pos, background: 'var(--tg-menu)' }}
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep${i}`} className="mx-3 my-1.5 h-px bg-black/10 dark:bg-on-brand/10" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            onClick={() => {
              it.onClick();
              onClose();
            }}
            className={cn(
              'flex w-full cursor-pointer items-center gap-4 px-4 py-2 text-left text-[15px] transition-colors hover:bg-black/5 dark:hover:bg-on-brand/10',
              it.danger && 'text-[var(--tg-danger)]',
            )}
          >
            <it.icon className={cn('h-[22px] w-[22px] shrink-0', !it.danger && 'text-[var(--tg-text)] opacity-80')} strokeWidth={1.8} />
            <span className="grow">{it.label}</span>
            {it.chevron && <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
