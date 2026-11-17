import {
  Archive,
  ArrowLeft,
  Bot,
  Briefcase,
  CheckCheck,
  Folder,
  Heart,
  Home,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessagesSquare,
  Moon,
  Pin,
  Search,
  Star,
  Sun,
  User,
  Users,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { useTgTyping } from '@/lib/tgCache';
import { folderBadge, folderDialogs } from '@/lib/tgFolders';
import { useTheme } from '@/lib/theme';
import type { TgDialog, TgFolder, TgStatus } from '@/lib/types';
import { TgAvatar, TgTicks, TypingDots, isOnline, listTime, previewOf } from './tgUi';

/**
 * Telegram'ning chap ustuni: jildlar (katta ekranda chapda alohida ustun — Telegram Desktop kabi, kichik ekranda
 * qidiruv ostida yorliqlar — Telegram Web/telefon kabi), menyu, qidiruv, «Arxiv» qatori va chatlar ro'yxati
 */
export function TgChatList({
  dialogs,
  folders,
  loading,
  error,
  active,
  onPick,
  status,
  canDisconnect,
  onDisconnect,
}: {
  dialogs: TgDialog[];
  folders: TgFolder[];
  loading: boolean;
  error: string | null;
  active: string | null;
  onPick: (peerId: string) => void;
  status: TgStatus;
  canDisconnect: boolean;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [archive, setArchive] = useState(false);
  const [menu, setMenu] = useState(false);
  // null — «Barcha chatlar»
  const [folderId, setFolderId] = useState<number | null>(null);
  const isTyping = useTgTyping();

  // Jild telefondan o'chirilgan bo'lsa — «Barcha chatlar»
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const curId = folder?.id ?? null;
  const archived = useMemo(() => dialogs.filter((d) => d.archived), [dialogs]);
  const main = useMemo(() => dialogs.filter((d) => !d.archived), [dialogs]);
  const byFolder = useMemo(() => new Map(folders.map((f) => [f.id, folderDialogs(dialogs, f, active)])), [dialogs, folders, active]);
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) {
      if (archive) return archived;
      return folder ? (byFolder.get(folder.id) ?? []) : main;
    }
    const digits = s.replace(/\D/g, '');
    return dialogs.filter(
      (d) =>
        d.title.toLowerCase().includes(s) ||
        (!!d.username && d.username.toLowerCase().includes(s.replace(/^@/, ''))) ||
        (digits.length >= 3 && !!d.phone && d.phone.replace(/\D/g, '').includes(digits)),
    );
  }, [dialogs, search, archive, archived, main, folder, byFolder]);
  const archivedUnread = archived.reduce((n, d) => n + d.unread, 0);
  const searching = !!search.trim();

  const tabs = useMemo(
    () => [
      { id: null as number | null, title: t('tg.allChats'), icon: MessagesSquare, badge: folderBadge(main) },
      ...folders.map((f) => ({ id: f.id as number | null, title: f.title, icon: folderIcon(f), badge: folderBadge(byFolder.get(f.id) ?? []) })),
    ],
    [folders, byFolder, main, t],
  );
  const pickFolder = (id: number | null) => {
    setFolderId(id);
    setArchive(false);
    setSearch('');
  };
  const hasFolders = folders.length > 0;

  return (
    <div className="flex h-full">
      {/* Katta ekran: jildlar chapda alohida ustun (Telegram Desktop) */}
      {hasFolders && (
        <nav className="tg-scroll hidden w-[84px] shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto py-1.5 lg:flex" style={{ background: 'var(--tg-rail)', borderRight: '1px solid var(--tg-border)' }} aria-label={t('tg.folders')}>
          {tabs.map((f) => {
            const on = !archive && f.id === curId;
            return (
              <button
                key={f.id ?? 'all'}
                type="button"
                onClick={() => pickFolder(f.id)}
                aria-current={on ? 'true' : undefined}
                className="tg-rail-item relative flex cursor-pointer flex-col items-center gap-1 px-1 py-2.5 transition-colors"
              >
                {/* Faol jild: chapda urg'u chizig'i (Telegram Desktop kabi) */}
                {on && <span className="absolute inset-y-2.5 left-0 w-[3px] rounded-r-full" style={{ background: 'var(--tg-rail-accent)' }} />}
                <span className="relative">
                  <f.icon className="h-8 w-8" strokeWidth={on ? 2 : 1.7} fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.18 : 0} />
                  {f.badge.n > 0 && (
                    <span className="absolute -right-3 -top-2">
                      <Badge n={f.badge.n} muted={f.badge.muted} ring />
                    </span>
                  )}
                </span>
                <span
                  className={cn('line-clamp-2 w-full break-words text-center text-[13px] leading-tight', on ? 'font-semibold' : 'font-medium')}
                  style={on ? undefined : { color: 'var(--tg-rail-text)' }}
                >
                  {f.title}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      <div className="flex h-full min-w-0 grow flex-col lg:w-[400px] lg:grow-0" style={{ background: 'var(--tg-bg)' }}>
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        {archive && !searching ? (
          <>
            <IconButton label={t('common.back')} onClick={() => setArchive(false)}>
              <ArrowLeft className="h-6 w-6" />
            </IconButton>
            <h2 className="grow text-[20px] font-medium">{t('tg.archived')}</h2>
          </>
        ) : (
          <>
            <div className="relative">
              <IconButton label={t('tg.menu')} onClick={() => setMenu((v) => !v)} active={menu}>
                <Menu className="h-6 w-6" />
              </IconButton>
              {menu && (
                <MainMenu
                  status={status}
                  archivedCount={archived.length}
                  onArchive={() => setArchive(true)}
                  canDisconnect={canDisconnect}
                  onDisconnect={onDisconnect}
                  onClose={() => setMenu(false)}
                />
              )}
            </div>
            <label
              className="group flex h-[42px] grow items-center gap-3 rounded-full border-2 border-transparent px-3 transition-colors focus-within:border-[var(--tg-primary)] focus-within:bg-[var(--tg-bg)]"
              style={{ background: 'var(--tg-search)' }}
            >
              <Search className="h-5 w-5 shrink-0 text-[var(--tg-secondary)] group-focus-within:text-[var(--tg-primary)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
                placeholder={t('tg.search')}
                aria-label={t('tg.search')}
                className="w-full bg-transparent text-base outline-none placeholder:text-[var(--tg-secondary)] focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searching && (
                <button type="button" onClick={() => setSearch('')} aria-label={t('common.clear')} className="cursor-pointer text-[var(--tg-secondary)]">
                  <X className="h-5 w-5" />
                </button>
              )}
            </label>
          </>
        )}
      </div>

      {/* Kichik/o'rta ekran: jildlar yorliq ko'rinishida (Telegram Web) */}
      {hasFolders && !archive && !searching && (
        <div className="tg-scroll flex shrink-0 gap-1 overflow-x-auto px-2 lg:hidden" style={{ boxShadow: 'inset 0 -1px 0 var(--tg-border)' }} role="tablist" aria-label={t('tg.folders')}>
          {tabs.map((f) => {
            const on = f.id === curId;
            return (
              <button
                key={f.id ?? 'all'}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => pickFolder(f.id)}
                className={cn('relative flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-t-lg px-3 pb-2.5 pt-2 text-[15px] font-medium transition-colors hover:bg-[var(--tg-hover)]', on ? 'text-[var(--tg-primary)]' : 'text-[var(--tg-secondary)]')}
              >
                {f.title}
                {f.badge.n > 0 && <Badge n={f.badge.n} muted={!on || f.badge.muted} small />}
                {on && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-[var(--tg-primary)]" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="tg-scroll min-h-0 grow overflow-y-auto overscroll-contain px-2 pb-2">
        {loading && <div className="py-10 text-center text-sm text-[var(--tg-secondary)]">{t('common.loading')}</div>}
        {error && <div className="px-4 py-6 text-center text-sm text-[var(--tg-danger)]">{error}</div>}

        {/* Telegram kabi: arxiv — ro'yxat tepasidagi alohida qator */}
        {!archive && !searching && !folder && archived.length > 0 && (
          <button
            type="button"
            onClick={() => setArchive(true)}
            className="flex h-[72px] w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left transition-colors hover:bg-[var(--tg-hover)]"
          >
            <TgAvatar peerId="0" name="" icon={<Archive className="h-6 w-6" />} />
            <span className="min-w-0 grow">
              <span className="block truncate text-base font-medium">{t('tg.archived')}</span>
              <span className="block truncate text-[15px] text-[var(--tg-secondary)]">{archived.map((d) => d.title).join(', ')}</span>
            </span>
            {archivedUnread > 0 && <Badge n={archivedUnread} muted />}
          </button>
        )}

        {!loading && !error && !list.length && (
          <div className="py-10 text-center text-[15px] text-[var(--tg-secondary)]">{t(searching ? 'tg.notFound' : folder ? 'tg.folderEmpty' : 'tg.empty')}</div>
        )}
        {list.map((d) => (
          <ChatRow key={d.peerId} d={d} active={d.peerId === active} typing={isTyping(d.peerId)} onPick={() => onPick(d.peerId)} />
        ))}
      </div>
      </div>
    </div>
  );
}

/** Telegram jild belgisi (emoji) → ikonka; belgi tanlanmagan bo'lsa — jild turidan (Telegram kabi) */
const EMOTICON_ICONS: Record<string, LucideIcon> = {
  '💬': MessageCircle, '✅': CheckCheck, '👤': User, '👥': Users, '📢': Megaphone, '🤖': Bot, '⭐': Star, '⭐️': Star,
  '🏠': Home, '💼': Briefcase, '❤': Heart, '❤️': Heart,
};

function folderIcon(f: TgFolder): LucideIcon {
  if (f.emoticon && EMOTICON_ICONS[f.emoticon]) return EMOTICON_ICONS[f.emoticon];
  return Folder;
}

function ChatRow({ d, active, typing, onPick }: { d: TgDialog; active: boolean; typing: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  const last = d.lastMessage;
  const pv = previewOf(last, t);
  const sec = active ? 'text-on-brand/80' : 'text-[var(--tg-secondary)]';
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex h-[72px] w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left transition-colors',
        active ? 'bg-[var(--tg-primary)] text-on-brand' : 'hover:bg-[var(--tg-hover)]',
      )}
    >
      <TgAvatar peerId={d.peerId} name={d.title} photoId={d.photoId} online={isOnline(d.status)} />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex items-center gap-1">
          <span className="min-w-0 grow truncate text-base font-medium">{d.title || '—'}</span>
          {d.muted && <VolumeX className={cn('h-4 w-4 shrink-0', sec)} />}
          {last?.out && (
            <TgTicks read={last.id <= d.readOutboxMaxId} className={cn('shrink-0', active ? 'text-on-brand' : 'text-[var(--tg-link)]')} />
          )}
          {last && <span className={cn('shrink-0 text-xs', sec)}>{listTime(last.date, t)}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={cn('min-w-0 grow truncate text-[15px]', sec)}>
            {typing ? (
              <span className={cn('inline-flex items-center gap-1', active ? 'text-on-brand' : 'text-[var(--tg-link)]')}>
                {t('tg.typing')}
                <TypingDots />
              </span>
            ) : (
              <>
                {last?.out && !last.service && d.kind !== 'CHANNEL' && <span className={active ? 'text-on-brand' : 'text-[var(--tg-text)]'}>{t('tg.you')}: </span>}
                {pv.prefix}
                {pv.text}
              </>
            )}
          </span>
          {d.unread > 0 ? (
            <Badge n={d.unread} muted={d.muted} inverted={active} />
          ) : (
            d.pinned && <Pin className={cn('h-4 w-4 shrink-0 rotate-45', sec)} />
          )}
        </span>
      </span>
    </button>
  );
}

function Badge({ n, muted, inverted, ring, small }: { n: number; muted?: boolean; inverted?: boolean; ring?: boolean; small?: boolean }) {
  return (
    <span
      className={cn(
        'block shrink-0 rounded-full text-center font-medium',
        small ? 'min-w-[20px] px-[6px] text-xs leading-[20px]' : 'min-w-[22px] px-[7px] text-[13px] leading-[22px]',
      )}
      style={{
        ...(inverted
          ? { background: '#fff', color: 'var(--tg-primary)' }
          : { background: muted ? 'var(--tg-badge-muted)' : 'var(--tg-badge)', color: '#fff' }),
        ...(ring ? { boxShadow: '0 0 0 2px var(--ring, var(--tg-rail))' } : {}),
      }}
    >
      {n > 9999 ? `${Math.floor(n / 1000)}K` : n}
    </span>
  );
}

export function IconButton({ label, onClick, children, active, className }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--tg-secondary)] transition-colors hover:bg-[var(--tg-hover)]',
        active && 'bg-[var(--tg-hover)]',
        className,
      )}
    >
      {children}
    </button>
  );
}

function MainMenu({
  status,
  archivedCount,
  onArchive,
  canDisconnect,
  onDisconnect,
  onClose,
}: {
  status: TgStatus;
  archivedCount: number;
  onArchive: () => void;
  canDisconnect: boolean;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Menyuni ochgan bosish o'zini yopmasin
    setTimeout(() => document.addEventListener('mousedown', onDown));
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item = 'flex w-full cursor-pointer items-center gap-4 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-black/5 dark:hover:bg-on-brand/10';
  return (
    <div
      ref={ref}
      role="menu"
      className="absolute left-0 top-12 z-20 w-[260px] animate-pop-in rounded-xl p-1 shadow-[0_4px_16px_rgba(0,0,0,0.18)] backdrop-blur-md"
      style={{ background: 'var(--tg-menu)' }}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <TgAvatar peerId="1" name={status.account?.name ?? ''} size={40} photoId={null} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{status.account?.name}</div>
          <div className="truncate text-xs text-[var(--tg-secondary)]">{status.account?.phone}</div>
        </div>
      </div>
      <div className="my-1 h-px bg-black/10 dark:bg-on-brand/10" />
      {archivedCount > 0 && (
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => {
            onArchive();
            onClose();
          }}
        >
          <Archive className="h-5 w-5 text-[var(--tg-secondary)]" />
          <span className="grow">{t('tg.archived')}</span>
          <span className="text-xs text-[var(--tg-secondary)]">{archivedCount}</span>
        </button>
      )}
      <button type="button" role="menuitem" className={item} onClick={toggle}>
        {theme === 'dark' ? <Sun className="h-5 w-5 text-[var(--tg-secondary)]" /> : <Moon className="h-5 w-5 text-[var(--tg-secondary)]" />}
        {theme === 'dark' ? t('tg.dayMode') : t('tg.nightMode')}
      </button>
      {canDisconnect && (
        <button
          type="button"
          role="menuitem"
          className={cn(item, 'text-[var(--tg-danger)]')}
          onClick={() => {
            onDisconnect();
            onClose();
          }}
        >
          <LogOut className="h-5 w-5" />
          {t('tg.disconnect')}
        </button>
      )}
    </div>
  );
}
