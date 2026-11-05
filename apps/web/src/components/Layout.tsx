import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  AlignJustify,
  Bell,
  Building2,
  CircleUserRound,
  History,
  LayoutDashboard,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  PhoneCall,
  Plus,
  Settings,
  Sheet,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { showDesktopNotification } from '@/lib/desktopNotify';
import { useServerEvents } from '@/lib/events';
import { useTheme } from '@/lib/theme';
import type { AppNotification, Lang } from '@/lib/types';
import { ChatWidget } from './ChatWidget';
import { DesktopNotifPrompt } from './DesktopNotifPrompt';
import { Logo } from './Logo';
import { NotificationsDrawer, notificationParts, notificationText } from './NotificationsDrawer';
import { TaskPanel } from './TaskPanel';
import { UrgentDialog } from './UrgentDialog';

const SIDEBAR_KEY = 'sidebar-expanded';
/** Kompyuter bildirishnomasi chiqadigan turlar: xodimdan darhol harakat kutadiganlari */
const DESKTOP_KINDS = new Set(['URGENT_TASK', 'TASK_TRANSFER']);
const readExpanded = () => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'false';
  } catch {
    return true;
  }
};

/** WinPro mavzu belgilari (quyosh / oy) */
function ThemeIcon() {
  return (
    <>
      <svg width="24" height="24" fill="none" viewBox="0 0 20 20" className="hidden dark:block" aria-hidden>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M9.99998 1.5415C10.4142 1.5415 10.75 1.87729 10.75 2.2915V3.5415C10.75 3.95572 10.4142 4.2915 9.99998 4.2915C9.58577 4.2915 9.24998 3.95572 9.24998 3.5415V2.2915C9.24998 1.87729 9.58577 1.5415 9.99998 1.5415ZM10.0009 6.79327C8.22978 6.79327 6.79402 8.22904 6.79402 10.0001C6.79402 11.7712 8.22978 13.207 10.0009 13.207C11.772 13.207 13.2078 11.7712 13.2078 10.0001C13.2078 8.22904 11.772 6.79327 10.0009 6.79327ZM5.29402 10.0001C5.29402 7.40061 7.40135 5.29327 10.0009 5.29327C12.6004 5.29327 14.7078 7.40061 14.7078 10.0001C14.7078 12.5997 12.6004 14.707 10.0009 14.707C7.40135 14.707 5.29402 12.5997 5.29402 10.0001ZM15.9813 5.08035C16.2742 4.78746 16.2742 4.31258 15.9813 4.01969C15.6884 3.7268 15.2135 3.7268 14.9207 4.01969L14.0368 4.90357C13.7439 5.19647 13.7439 5.67134 14.0368 5.96423C14.3297 6.25713 14.8045 6.25713 15.0974 5.96423L15.9813 5.08035ZM18.4577 10.0001C18.4577 10.4143 18.1219 10.7501 17.7077 10.7501H16.4577C16.0435 10.7501 15.7077 10.4143 15.7077 10.0001C15.7077 9.58592 16.0435 9.25013 16.4577 9.25013H17.7077C18.1219 9.25013 18.4577 9.58592 18.4577 10.0001ZM14.9207 15.9806C15.2135 16.2735 15.6884 16.2735 15.9813 15.9806C16.2742 15.6877 16.2742 15.2128 15.9813 14.9199L15.0974 14.036C14.8045 13.7431 14.3297 13.7431 14.0368 14.036C13.7439 14.3289 13.7439 14.8038 14.0368 15.0967L14.9207 15.9806ZM9.99998 15.7088C10.4142 15.7088 10.75 16.0445 10.75 16.4588V17.7088C10.75 18.123 10.4142 18.4588 9.99998 18.4588C9.58577 18.4588 9.24998 18.123 9.24998 17.7088V16.4588C9.24998 16.0445 9.58577 15.7088 9.99998 15.7088ZM5.96356 15.0972C6.25646 14.8043 6.25646 14.3295 5.96356 14.0366C5.67067 13.7437 5.1958 13.7437 4.9029 14.0366L4.01902 14.9204C3.72613 15.2133 3.72613 15.6882 4.01902 15.9811C4.31191 16.274 4.78679 16.274 5.07968 15.9811L5.96356 15.0972ZM4.29224 10.0001C4.29224 10.4143 3.95645 10.7501 3.54224 10.7501H2.29224C1.87802 10.7501 1.54224 10.4143 1.54224 10.0001C1.54224 9.58592 1.87802 9.25013 2.29224 9.25013H3.54224C3.95645 9.25013 4.29224 9.58592 4.29224 10.0001ZM4.9029 5.9637C5.1958 6.25659 5.67067 6.25659 5.96356 5.9637C6.25646 5.6708 6.25646 5.19593 5.96356 4.90303L5.07968 4.01915C4.78679 3.72626 4.31191 3.72626 4.01902 4.01915C3.72613 4.31204 3.72613 4.78692 4.01902 5.07981L4.9029 5.9637Z"
          fill="currentColor"
        />
      </svg>
      <svg width="24" height="24" fill="none" viewBox="0 0 20 20" className="dark:hidden" aria-hidden>
        <path
          d="M17.4547 11.97L18.1799 12.1611C18.265 11.8383 18.1265 11.4982 17.8401 11.3266C17.5538 11.1551 17.1885 11.1934 16.944 11.4207L17.4547 11.97ZM8.0306 2.5459L8.57989 3.05657C8.80718 2.81209 8.84554 2.44682 8.67398 2.16046C8.50243 1.8741 8.16227 1.73559 7.83948 1.82066L8.0306 2.5459ZM12.9154 13.0035C9.64678 13.0035 6.99707 10.3538 6.99707 7.08524H5.49707C5.49707 11.1823 8.81835 14.5035 12.9154 14.5035V13.0035ZM16.944 11.4207C15.8869 12.4035 14.4721 13.0035 12.9154 13.0035V14.5035C14.8657 14.5035 16.6418 13.7499 17.9654 12.5193L16.944 11.4207ZM16.7295 11.7789C15.9437 14.7607 13.2277 16.9586 10.0003 16.9586V18.4586C13.9257 18.4586 17.2249 15.7853 18.1799 12.1611L16.7295 11.7789ZM10.0003 16.9586C6.15734 16.9586 3.04199 13.8433 3.04199 10.0003H1.54199C1.54199 14.6717 5.32892 18.4586 10.0003 18.4586V16.9586ZM3.04199 10.0003C3.04199 6.77289 5.23988 4.05695 8.22173 3.27114L7.83948 1.82066C4.21532 2.77574 1.54199 6.07486 1.54199 10.0003H3.04199ZM6.99707 7.08524C6.99707 5.52854 7.5971 4.11366 8.57989 3.05657L7.48132 2.03522C6.25073 3.35885 5.49707 5.13487 5.49707 7.08524H6.99707Z"
          fill="currentColor"
        />
      </svg>
    </>
  );
}

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, isLeader, logout, reload } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { theme, toggle: toggleTheme } = useTheme();
  const [expanded, setExpanded] = useState(readExpanded);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [urgentOpen, setUrgentOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [openTask, setOpenTask] = useState<number | null>(null);
  // Har yangi bildirishnomada oshadi: `key` orqali qo'ng'iroq va badge animatsiyasini boshidan qayta boshlaydi
  const [ringKey, setRingKey] = useState(0);
  // Chatga boshqa xodimdan xabar kelganda oshadi: chat tugmasi belgisi va badge animatsiyasi
  const [chatPulse, setChatPulse] = useState(0);
  // Mobil menyu ochiq bo'lsa yozuvlar har doim ko'rinadi (WinPro sidebar mantiqi)
  const wide = expanded || mobileOpen;

  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    // SSE asosiy kanal; polling — zaxira (ulanish uzilsa)
    refetchInterval: 60_000,
  });
  const unreadCount = unread.data?.count ?? 0;

  const setLang = useMutation({
    mutationFn: (language: Lang) => api.patch('/me', { language }),
    onSuccess: () => reload(),
  });

  useServerEvents(!!user, (n: AppNotification) => {
    setRingKey((k) => k + 1);
    const text = notificationText(n, t);
    // Boshqa dastur yoki oynada ishlayotgan bo'lsa ham ko'rinsin: OS bildirishnomasi (CRM oynasi faol bo'lsa toast yetarli)
    if (DESKTOP_KINDS.has(n.kind) && (document.hidden || !document.hasFocus())) {
      const parts = notificationParts(n, t);
      showDesktopNotification({
        ...parts,
        tag: `notif-${n.id}`,
        sticky: n.kind === 'URGENT_TASK',
        onClick: n.taskId ? () => setOpenTask(n.taskId) : undefined,
      });
    }
    if (n.kind === 'URGENT_TASK') {
      // Shoshilinch: ekranda qizil xabar, foydalanuvchi o'zi yopmaguncha turadi
      toast.error(text, {
        duration: Infinity,
        className: 'toast-urgent',
        action: n.taskId ? { label: t('common.open'), onClick: () => setOpenTask(n.taskId) } : undefined,
      });
    } else if (n.kind === 'TASK_OVERDUE' || n.kind === 'CLIENTS_OVERDUE') {
      toast.warning(text);
    } else if (n.kind === 'TASK_TRANSFER') {
      toast.info(text, {
        duration: 15000,
        action: n.taskId ? { label: t('common.open'), onClick: () => setOpenTask(n.taskId) } : undefined,
      });
    } else if (n.kind === 'LEAD_WON') {
      toast.success(text, {
        duration: 10000,
        action: n.payload?.leadId ? { label: t('common.open'), onClick: () => navigate(`/leads?lead=${n.payload.leadId}`) } : undefined,
      });
    } else {
      toast(text);
    }
  }, (m) => {
    if (m.senderId !== user?.id) setChatPulse((k) => k + 1);
  });

  const isOperator = user?.role === 'OPERATOR';
  // staff — buxgalteriya bo'limlari (operatorga yo'q); operator faqat "Yangi mijozlar"ni ko'radi
  const nav = [
    { to: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, leader: true },
    // Rahbarga "Mening kunim" hozircha kerak emas (sahifa o'zi ochiladi, faqat menyuda yo'q)
    ...(isLeader ? [] : [{ to: '/my-day', label: t('nav.home'), icon: LayoutDashboard, staff: true }]),
    { to: '/clients', label: t(isLeader ? 'nav.clientsLeader' : 'nav.clients'), icon: Building2, staff: true },
    { to: '/monthly', label: t('nav.monthly'), icon: Sheet, staff: true },
    { to: '/client-issues', label: t('nav.issues'), icon: AlertTriangle, leader: true },
    ...(isLeader || isOperator ? [{ to: '/leads', label: t('nav.leads'), icon: PhoneCall }] : []),
    { to: '/audit', label: t('nav.audit'), icon: History, leader: true },
    { to: '/users', label: t('nav.users'), icon: Users, leader: true },
    { to: '/settings', label: t('nav.settings'), icon: Settings, leader: true },
  ].filter((n) => (!n.leader || isLeader) && (!n.staff || !isOperator));

  const toggleSidebar = () =>
    setExpanded((v) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, String(!v));
      } catch {
        /* ignore */
      }
      return !v;
    });

  const changeLang = (l: Lang) => {
    void i18n.changeLanguage(l);
    setLang.mutate(l);
  };

  const itemCls = (active = false) => cn('menu-item group', active ? 'menu-item-active' : 'menu-item-inactive', !wide && 'justify-center');
  const iconCls = (active = false) => cn('menu-item-icon-size', active ? 'menu-item-icon-active' : 'menu-item-icon-inactive');

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:bg-white focus:p-2">
        {t('common.skipToContent')}
      </a>

      <aside
        className={cn(
          'fixed left-0 top-0 z-[51] mt-14 flex h-[calc(100vh-56px)] flex-col border-r border-gray-200 bg-white dark:bg-page text-gray-900 transition-[width,transform] duration-300 xl:mt-0 xl:h-screen xl:translate-x-0',
          wide ? 'w-[256px] px-3.5' : 'w-[70px] px-2',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Balandligi va pastki chizig'i header bilan bir xil: logo qatori header bilan bitta chiziqda turadi */}
        <div className={cn('hidden h-14 shrink-0 items-center border-b border-gray-200 xl:flex', wide ? '-mx-3.5 justify-between pl-5 pr-3.5' : '-mx-2 justify-center px-2')}>
          {wide && (
            <Link to="/" title={t('nav.home')} className="flex min-w-0 items-center rounded-md transition-opacity hover:opacity-80">
              <Logo variant="row" className="h-8 w-auto" />
            </Link>
          )}
          <button type="button" title={t(wide ? 'nav.collapse' : 'nav.openMenu')} aria-label={t(wide ? 'nav.collapse' : 'nav.openMenu')} onClick={toggleSidebar} className="menu-item menu-item-inactive group h-11 w-auto cursor-pointer">
            <span className="menu-item-icon-size text-gray-500">{wide ? <PanelRightOpen /> : <PanelRightClose />}</span>
          </button>
        </div>

        <div className="no-scrollbar flex h-full flex-col justify-between overflow-y-auto pb-4">
          <nav className="mb-6 mt-4" aria-label={t('nav.main')}>
            <ul className="flex flex-col gap-1">
              {nav.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} onClick={() => setMobileOpen(false)} title={wide ? undefined : n.label} className={({ isActive }) => itemCls(isActive)}>
                    {({ isActive }) => (
                      <>
                        <span className={iconCls(isActive)}>
                          <n.icon />
                        </span>
                        {wide && <span className="line-clamp-1">{n.label}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <div className="space-y-1">
            <NavLink to="/profile" onClick={() => setMobileOpen(false)} title={wide ? undefined : user?.fullName} className={({ isActive }) => itemCls(isActive)}>
              {({ isActive }) => (
                <>
                  <span className={iconCls(isActive)}>
                    <CircleUserRound />
                  </span>
                  {wide && <span className="line-clamp-1">{user?.fullName}</span>}
                </>
              )}
            </NavLink>
            <button type="button" onClick={toggleTheme} title={theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')} className={cn(itemCls(), 'cursor-pointer')}>
              <span className={iconCls()}>
                <ThemeIcon />
              </span>
              {wide && <span className="line-clamp-1">{theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')}</span>}
            </button>
            <button
              type="button"
              title={wide ? undefined : t('nav.logout')}
              className={cn(itemCls(), 'cursor-pointer')}
              onClick={async () => {
                await logout();
                qc.clear();
                navigate('/login');
              }}
            >
              <span className={iconCls()}>
                <LogOut />
              </span>
              {wide && <span className="line-clamp-1">{t('nav.logout')}</span>}
            </button>
          </div>
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-50 bg-black/40 xl:hidden" onClick={() => setMobileOpen(false)} />}

      <div className={cn('flex min-w-0 grow flex-col transition-all duration-300', expanded ? 'xl:pl-[256px]' : 'xl:pl-[70px]')}>
        {/* Header: mobil menyu tugmasi va logo (xl'dan kichik), chapda shoshilinch, o'ngda til, bildirishnomalar */}
        <header className="sticky top-0 z-[51] flex h-14 w-full items-center gap-2 border-b border-gray-200 bg-white px-2 dark:bg-page sm:px-4">
          <button type="button" onClick={() => setMobileOpen((v) => !v)} aria-label={t('nav.menu')} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-gray-500 xl:hidden">
            {mobileOpen ? <X className="h-6 w-6" /> : <AlignJustify className="h-6 w-6" />}
          </button>
          <Link to="/" title={t('nav.home')} className="mr-2 flex items-center xl:hidden">
            <Logo variant="row" className="h-7 w-auto" />
          </Link>
          {isLeader && (
            <button
              type="button"
              onClick={() => setUrgentOpen(true)}
              title={t('urgent.button')}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-gradient-to-tl from-[#048494] to-[#10B981] px-3.5 py-2 text-xs font-medium text-on-brand shadow-[0_3px_10px_rgba(59,127,232,0.28)] transition-[opacity,transform] hover:opacity-80 active:scale-95"
            >
              <Plus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('urgent.button')}</span>
            </button>
          )}
          <div className="flex-1" />
          <div className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-white/5" role="group" aria-label={t('nav.language')}>
            {(['uz', 'ru'] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => changeLang(l)}
                aria-pressed={i18n.language === l}
                className={cn(
                  'cursor-pointer rounded-md px-2.5 py-1 text-xs font-semibold uppercase transition-colors',
                  i18n.language === l ? 'bg-brand-500 text-on-brand shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300',
                )}
              >
                {l}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setNotifOpen(true)} aria-label={t('nav.notifications')} aria-haspopup="dialog" className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 shadow-card transition-colors hover:bg-gray-50 hover:text-brand-500 dark:hover:bg-white/5 dark:hover:text-brand-400">
            <Bell key={`bell-${ringKey}`} className={cn('h-4 w-4 origin-top', !!unreadCount && 'animate-bell-ring')} />
            {!!unreadCount && (
              <span key={`badge-${ringKey}`} className="absolute -right-1.5 -top-1.5 animate-badge-pop">
                <span className="absolute inset-0 animate-ping rounded-full bg-orange-400 opacity-75" />
                <span className="relative block min-w-[16px] rounded-full bg-orange-500 px-1 text-center text-[9px] font-semibold leading-[16px] text-on-brand">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              </span>
            )}
          </button>
        </header>
        <main id="main" className="w-full grow p-2 sm:p-4">
          <Outlet context={{ openTask: setOpenTask }} />
        </main>
      </div>
      <UrgentDialog open={urgentOpen} onClose={() => setUrgentOpen(false)} />
      <DesktopNotifPrompt enabled={!!user && !isOperator} />
      <NotificationsDrawer open={notifOpen} onClose={() => setNotifOpen(false)} onOpenTask={setOpenTask} />
      <TaskPanel taskId={openTask} onClose={() => setOpenTask(null)} />
      <ChatWidget pulse={chatPulse} />
    </div>
  );
}
