import { DateTime } from 'luxon';
import type { Role } from '../common/auth';
import { TZ, nowTz } from '../common/time';
import { one, pool, q } from '../db';
import { WORKS_SCOPE } from './taskScope';
import { b, esc, i } from './telegramFormat';

/**
 * Telegram bot buyruqlari (faqat o'qish). Qaror: chat → xodim har so'rovda bazadan topiladi (faol, o'chirilmagan),
 * rol va ko'rinish doirasi **serverda** shu xodim bo'yicha tekshiriladi — Telegram menyusi faqat qulaylik.
 *  - Rahbar: barcha buxgalterlar (shoshilinch, kechikkan, xodimlar kesimi).
 *  - Buxgalter: faqat o'ziga biriktirilgan vazifalar ("Mening kunim" doirasi bilan bir xil).
 *  - Sotuv operatori: buyruq yo'q (unga vazifa bildirishnomasi ham bormaydi).
 * Botdan holat o'zgartirilmaydi — "Bajarildi" faqat CRM'da (undo va audit oqimi o'sha yerda).
 * Javoblar HTML (telegramFormat.ts): har bir dinamik qiymat esc/b/i orqali.
 */

type Lang = 'uz' | 'ru';
export interface BotUser {
  id: number;
  role: Role;
  language: Lang;
  fullName: string;
}

export type BotCommand = 'tasks' | 'urgent' | 'overdue' | 'team' | 'help';

/** Har rol uchun buyruqlar (Telegram menyusi ham shundan) */
export const COMMANDS_BY_ROLE: Record<Role, BotCommand[]> = {
  LEADER: ['urgent', 'overdue', 'team', 'help'],
  ACCOUNTANT: ['tasks', 'urgent', 'help'],
  OPERATOR: ['help'],
};

export const COMMAND_DESCRIPTIONS: Record<BotCommand, Record<Lang, Record<'LEADER' | 'ACCOUNTANT' | 'OPERATOR', string>>> = {
  tasks: {
    uz: { LEADER: '', ACCOUNTANT: 'Mening vazifalarim: shoshilinch, kechikkan, bugungi', OPERATOR: '' },
    ru: { LEADER: '', ACCOUNTANT: 'Мои задачи: срочные, просроченные, на сегодня', OPERATOR: '' },
  },
  urgent: {
    uz: { LEADER: 'Shoshilinch vazifalar: kimda va qaysi holatda', ACCOUNTANT: 'Menga berilgan shoshilinch vazifalar', OPERATOR: '' },
    ru: { LEADER: 'Срочные задачи: у кого и в каком статусе', ACCOUNTANT: 'Мои срочные задачи', OPERATOR: '' },
  },
  overdue: {
    uz: { LEADER: 'Muddati o\'tgan vazifalar (buxgalterlar bo\'yicha)', ACCOUNTANT: '', OPERATOR: '' },
    ru: { LEADER: 'Просроченные задачи (по бухгалтерам)', ACCOUNTANT: '', OPERATOR: '' },
  },
  team: {
    uz: { LEADER: 'Buxgalterlar: yuklama, kechikkan, bugun bajargan', ACCOUNTANT: '', OPERATOR: '' },
    ru: { LEADER: 'Бухгалтеры: нагрузка, просрочки, выполнено сегодня', ACCOUNTANT: '', OPERATOR: '' },
  },
  help: {
    uz: { LEADER: 'Yordam', ACCOUNTANT: 'Yordam', OPERATOR: 'Yordam' },
    ru: { LEADER: 'Помощь', ACCOUNTANT: 'Помощь', OPERATOR: 'Помощь' },
  },
};

export function commandsFor(role: Role, lang: Lang) {
  return COMMANDS_BY_ROLE[role].map((c) => ({ command: c, description: COMMAND_DESCRIPTIONS[c][lang][role] }));
}

/** Telegram bitta xabar chegarasi 4096 belgi; HTML teglari bilan zaxira qoldiramiz */
const MAX_LEN = 3800;
const OPEN = `('TODO','IN_PROGRESS','WAITING_CLIENT')`;

const STATUS: Record<string, Record<Lang, string>> = {
  TODO: { uz: 'Bajarilishi kerak', ru: 'К выполнению' },
  IN_PROGRESS: { uz: 'Jarayonda', ru: 'В работе' },
  WAITING_CLIENT: { uz: 'Mijozdan kutilmoqda', ru: 'Ждём клиента' },
  DONE: { uz: 'Bajarildi', ru: 'Выполнено' },
};

const fmt = (d: Date | null) => (d ? DateTime.fromJSDate(d).setZone(TZ).toFormat('dd.MM HH:mm') : '—');

interface Row {
  id: number;
  title: string;
  status: string;
  dueAt: Date | null;
  doneAt: Date | null;
  clientName: string;
  assigneeName: string | null;
  createdByName: string | null;
  overdue: boolean;
}

const ROW_SELECT = `t.id, t.assignee_id AS "assigneeId", t.title, t.status, t.due_at AS "dueAt", t.done_at AS "doneAt", c.name AS "clientName",
  a.full_name AS "assigneeName", cb.full_name AS "createdByName",
  (t.status IN ${OPEN} AND t.due_at < now()) AS overdue
  FROM task t JOIN client c ON c.id = t.client_id
  LEFT JOIN app_user a ON a.id = t.assignee_id LEFT JOIN app_user cb ON cb.id = t.created_by`;

const mark = (r: Row) =>
  r.status === 'DONE' ? '✅' : r.overdue ? '🔴' : r.status === 'WAITING_CLIENT' ? '🟠' : r.status === 'IN_PROGRESS' ? '🔵' : '⚪';

/**
 * Bitta vazifa — kartochka:
 *   1. 🔴 Vazifa nomi
 *   🏢 Mijoz
 *   👤 Mas'ul          (faqat rahbarga)
 *   ⏰ 11.11 18:00 · Jarayonda
 */
function card(r: Row, n: number, lang: Lang, opts: { assignee?: boolean } = {}) {
  const uz = lang === 'uz';
  const when = r.status === 'DONE' ? `✔️ ${fmt(r.doneAt)}` : `⏰ ${r.overdue ? b(fmt(r.dueAt)) : esc(fmt(r.dueAt))}`;
  return [
    `${b(`${n}.`)} ${mark(r)} ${b(r.title)}`,
    `🏢 ${esc(r.clientName)}`,
    opts.assignee ? `👤 ${esc(r.assigneeName ?? (uz ? 'Biriktirilmagan' : 'Не назначено'))}` : null,
    `${when} · ${i(STATUS[r.status]?.[lang] ?? r.status)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Bloklarni xabar chegarasiga sig'diradi (bloklar orasida bo'sh qator): sig'magani "… yana N ta" bo'ladi */
function fit(header: string, blocks: string[], lang: Lang, footer = '') {
  const foot = footer ? `\n\n${footer}` : '';
  let out = header;
  for (let k = 0; k < blocks.length; k++) {
    const rest = blocks.length - k;
    const tail = `\n\n${i(lang === 'uz' ? `… yana ${rest} ta` : `… ещё ${rest}`)}`;
    if (out.length + blocks[k].length + 2 + tail.length + foot.length > MAX_LEN) return out + tail + foot;
    out += `\n\n${blocks[k]}`;
  }
  return out + foot;
}

const LEGEND: Record<Lang, string> = {
  uz: i("🔴 muddati o'tgan · 🔵 jarayonda · 🟠 mijozdan kutilmoqda · ⚪ boshlanmagan"),
  ru: i('🔴 просрочено · 🔵 в работе · 🟠 ждём клиента · ⚪ не начато'),
};

/** Sarlavha: belgi + qalin nom, ostida qisqa xulosa */
const head = (icon: string, title: string, summary?: string) => `${icon} ${b(title)}${summary ? `\n${summary}` : ''}`;
const now = () => nowTz().toFormat('dd.MM.yyyy HH:mm');

/** Shoshilinch vazifalar: rahbar — hammasi, buxgalter — faqat o'zi. Bugun bajarilganlari ham ko'rinadi. */
async function urgent(u: BotUser) {
  const uz = u.language === 'uz';
  const leader = u.role === 'LEADER';
  const todayStart = nowTz().startOf('day').toJSDate();
  const rows = await q<Row>(
    pool,
    `SELECT ${ROW_SELECT}
     WHERE t.kind = 'URGENT' AND (t.status IN ${OPEN} OR (t.status = 'DONE' AND t.done_at >= $1))
       ${leader ? '' : 'AND t.assignee_id = $2'}
     ORDER BY (t.status = 'DONE'), t.due_at NULLS LAST, t.id`,
    leader ? [todayStart] : [todayStart, u.id],
  );
  if (!rows.length) return head('🚨', uz ? 'Shoshilinch vazifalar' : 'Срочные задачи', i(uz ? "Ochiq shoshilinch vazifa yo'q." : 'Открытых срочных задач нет.'));
  const open = rows.filter((r) => r.status !== 'DONE').length;
  const summary = uz
    ? `Ochiq: ${b(open)} · Bugun bajarilgan: ${b(rows.length - open)}`
    : `Открыто: ${b(open)} · Выполнено сегодня: ${b(rows.length - open)}`;
  return fit(
    head('🚨', uz ? 'Shoshilinch vazifalar' : 'Срочные задачи', summary),
    rows.map((r, k) => card(r, k + 1, u.language, { assignee: leader })),
    u.language,
    LEGEND[u.language],
  );
}

/**
 * Rahbar: muddati o'tgan ochiq vazifalar buxgalter bo'yicha (dashboarddagi "Muddati o'tgan vazifalar" bilan bir xil:
 * buxgalteri biriktirilmagan mijoz kirmaydi, 6.11). Har buxgalterdan eng eski 5 tasi.
 */
async function overdue(u: BotUser) {
  const uz = u.language === 'uz';
  const groups = await q<{ assigneeName: string | null; total: number; todo: number; items: Row[] }>(
    pool,
    `WITH od AS (
       SELECT ${ROW_SELECT}
       WHERE t.status IN ${OPEN} AND t.due_at < now() AND c.accountant_id IS NOT NULL
     )
     SELECT max(od."assigneeName") AS "assigneeName", count(*)::int AS total,
            count(*) FILTER (WHERE od.status = 'TODO')::int AS todo,
            (array_agg(row_to_json(od) ORDER BY od."dueAt"))[1:5] AS items
     FROM od GROUP BY od."assigneeId" ORDER BY count(*) DESC`,
  );
  const title = uz ? "Muddati o'tgan vazifalar" : 'Просроченные задачи';
  if (!groups.length) return head('✅', title, i(uz ? "Muddati o'tgan vazifa yo'q." : 'Просроченных задач нет.'));
  const total = groups.reduce((s, g) => s + g.total, 0);
  const blocks = groups.map((g) => {
    const name = g.assigneeName ?? (uz ? 'Biriktirilmagan' : 'Не назначено');
    const top = uz
      ? `👤 ${b(name)} — ${b(g.total)} ta ${i(`(boshlanmagan ${g.todo})`)}`
      : `👤 ${b(name)} — ${b(g.total)} ${i(`(не начато ${g.todo})`)}`;
    // Ixcham qator: holat · nom — mijoz · muddat
    const items = g.items.map((r) => {
      const row = { ...r, dueAt: r.dueAt ? new Date(r.dueAt) : null, overdue: true } as Row;
      return `${mark(row)} ${esc(row.title)} — ${esc(row.clientName)} · ${esc(fmt(row.dueAt))}`;
    });
    const more = g.total > g.items.length ? `\n${i(uz ? `… yana ${g.total - g.items.length} ta` : `… ещё ${g.total - g.items.length}`)}` : '';
    return `${top}\n<blockquote>${items.join('\n')}${more}</blockquote>`;
  });
  return fit(head('🔴', title, uz ? `Jami: ${b(total)} ta` : `Всего: ${b(total)}`), blocks, u.language, LEGEND[u.language]);
}

/** Rahbar: buxgalterlar kesimi (dashboarddagi Buxgalterlar jadvali formulalari, "Kechikkan" = muddati o'tgan TODO) */
async function team(u: BotUser) {
  const uz = u.language === 'uz';
  const todayStart = nowTz().startOf('day').toJSDate();
  const rows = await q<{ fullName: string; open: number; overdue: number; waiting: number; urgent: number; doneToday: number }>(
    pool,
    `SELECT u.full_name AS "fullName",
       count(t.id) FILTER (WHERE t.status IN ${OPEN} AND t.assignee_id = u.id)::int AS open,
       count(t.id) FILTER (WHERE t.status = 'TODO' AND t.due_at < now() AND t.assignee_id = u.id)::int AS overdue,
       count(t.id) FILTER (WHERE t.status = 'WAITING_CLIENT' AND t.assignee_id = u.id)::int AS waiting,
       count(t.id) FILTER (WHERE t.kind = 'URGENT' AND t.status IN ${OPEN} AND t.assignee_id = u.id)::int AS urgent,
       count(t.id) FILTER (WHERE t.status = 'DONE' AND t.done_by = u.id AND t.done_at >= $1)::int AS "doneToday"
     FROM app_user u
     LEFT JOIN task t ON (t.assignee_id = u.id OR t.done_by = u.id)
       AND EXISTS (SELECT 1 FROM client c WHERE c.id = t.client_id AND c.accountant_id IS NOT NULL)
     WHERE u.role = 'ACCOUNTANT' AND u.active AND u.deleted_at IS NULL
     GROUP BY u.id ORDER BY u.full_name`,
    [todayStart],
  );
  const title = uz ? 'Buxgalterlar' : 'Бухгалтеры';
  if (!rows.length) return head('👥', title, i(uz ? "Faol buxgalter yo'q." : 'Активных бухгалтеров нет.'));
  const L = (a: string, r: string) => (uz ? a : r);
  const blocks = rows.map((r) =>
    [
      `👤 ${b(r.fullName)}`,
      `├ ${L('Ochiq', 'Открыто')}: ${b(r.open)}`,
      `├ ${L('Kechikkan', 'Просрочено')}: ${b(r.overdue)}${r.overdue ? ' 🔴' : ''}`,
      `├ ${L('Mijozdan kutilmoqda', 'Ждут клиента')}: ${b(r.waiting)}`,
      `├ ${L('Shoshilinch', 'Срочные')}: ${b(r.urgent)}${r.urgent ? ' 🚨' : ''}`,
      `└ ${L('Bugun bajardi', 'Выполнено сегодня')}: ${b(r.doneToday)}${r.doneToday ? ' ✅' : ''}`,
    ].join('\n'),
  );
  return fit(head('👥', title, i(now())), blocks, u.language);
}

/** Buxgalter: o'z vazifalari ("Mening kunim" guruhlari bilan bir xil) */
async function myTasks(u: BotUser) {
  const uz = u.language === 'uz';
  const rows = await q<Row & { kind: string }>(
    pool,
    `SELECT t.kind, ${ROW_SELECT}
     WHERE t.assignee_id = $1 AND t.status IN ${OPEN} AND ${WORKS_SCOPE}
     ORDER BY t.due_at NULLS LAST, t.id`,
    [u.id],
  );
  const today = nowTz().toISODate();
  const isToday = (d: Date | null) => !!d && DateTime.fromJSDate(d).setZone(TZ).toISODate() === today;
  const urgentRows = rows.filter((r) => r.kind === 'URGENT');
  const overdueRows = rows.filter((r) => r.overdue && r.status === 'TODO' && r.kind !== 'URGENT');
  const todayRows = rows.filter((r) => isToday(r.dueAt) && !r.overdue && r.kind !== 'URGENT');
  const title = uz ? 'Mening vazifalarim' : 'Мои задачи';
  const summary = uz ? `Jami ochiq: ${b(rows.length)} ta` : `Всего открыто: ${b(rows.length)}`;
  if (!urgentRows.length && !overdueRows.length && !todayRows.length) {
    return head('📋', title, `${summary}\n\n${i(uz ? "✅ Shoshilinch, kechikkan va bugungi vazifa yo'q." : '✅ Срочных, просроченных и на сегодня задач нет.')}`);
  }
  // Bo'lim sarlavhasi + kartochkalar; raqamlash har bo'limda 1 dan
  const section = (icon: string, name: string, list: Row[]) =>
    list.length ? [`${icon} ${b(`${name.toUpperCase()} · ${list.length}`)}`, ...list.map((r, k) => card(r, k + 1, u.language))] : [];
  const blocks = [
    ...section('🚨', uz ? 'Shoshilinch' : 'Срочные', urgentRows),
    ...section('🔴', uz ? "Muddati o'tgan" : 'Просроченные', overdueRows),
    ...section('📅', uz ? 'Bugun' : 'Сегодня', todayRows),
  ];
  return fit(head('📋', title, summary), blocks, u.language, i(uz ? "Holatni CRM'da o'zgartiring." : 'Статус меняйте в CRM.'));
}

export function helpText(u: BotUser) {
  const uz = u.language === 'uz';
  const hello = `👋 ${b(`${uz ? 'Salom' : 'Здравствуйте'}, ${u.fullName}!`)}`;
  if (u.role === 'OPERATOR') {
    return `${hello}\n\n${i(uz ? "Sotuv operatori uchun bot buyruqlari yo'q." : 'Для оператора продаж команд бота нет.')}`;
  }
  const L = (a: string, r: string) => (uz ? a : r);
  // help menyuda bor, matnda takrorlanmaydi
  const list = commandsFor(u.role, u.language)
    .filter((c) => c.command !== 'help')
    .map((c) => `/${c.command} — ${esc(c.description)}`)
    .join('\n');
  const settings = i(L("Qaysi xabar Telegram'ga kelishini CRM → Profil sahifasida sozlaysiz.", 'Какие уведомления приходят в Telegram — настраивается в CRM → Профиль.'));
  if (u.role === 'LEADER') {
    // Rahbar — nazorat qiluvchi: buyruqlar bilan istalgan paytda holatni ko'radi, muhim hodisalar o'zi keladi
    return [
      hello,
      `👔 ${esc(L('Rahbar paneli — buxgalterlar ishini shu yerdan nazorat qilasiz.', 'Панель руководителя — здесь вы контролируете работу бухгалтеров.'))}`,
      `${b(L('Nazorat', 'Контроль'))}\n${list}`,
      `${b(L('Avtomatik xabarlar', 'Автоматические уведомления'))}\n${esc(
        L(
          "✅ Vazifa bajarildi\n🔴 Muddat o'tdi\n⏰ Kechikkan mijozlar (kunlik)\n🔁 O'tkazilgan vazifa qabul qilindi",
          '✅ Задача выполнена\n🔴 Срок истёк\n⏰ Просроченные клиенты (ежедневно)\n🔁 Переданная задача принята',
        ),
      )}`,
      settings,
    ].join('\n\n');
  }
  return [
    hello,
    `🧾 ${esc(L("Sizga berilgan vazifalar shu yerga keladi — brauzer yopiq bo'lsa ham.", 'Сюда приходят ваши задачи — даже если браузер закрыт.'))}`,
    `${b(L('Buyruqlar', 'Команды'))}\n${list}`,
    `${b(L('Avtomatik xabarlar', 'Автоматические уведомления'))}\n${esc(
      L(
        "🚨 Shoshilinch vazifa\n🔁 Sizga vazifa o'tkazilmoqda\n🔴 Muddat o'tdi",
        '🚨 Срочная задача\n🔁 Вам передают задачу\n🔴 Срок истёк',
      ),
    )}`,
    i(L("Holat (Jarayonda, Bajarildi) CRM'da o'zgartiriladi.", 'Статус («В работе», «Выполнено») меняется в CRM.')),
  ].join('\n\n');
}

/** Bog'langan chat egasi: faqat faol, o'chirilmagan xodim */
export function botUserByChat(chatId: number) {
  return one<BotUser>(
    pool,
    `SELECT id, role, language, full_name AS "fullName" FROM app_user
     WHERE telegram_chat_id = $1 AND active AND deleted_at IS NULL`,
    [chatId],
  );
}

/** Buyruqqa javob matni. Rolga tegishli bo'lmagan buyruq — ruxsat yo'q (server tekshiradi, menyuga ishonilmaydi). */
export async function runCommand(u: BotUser, cmd: string): Promise<string> {
  const allowed = COMMANDS_BY_ROLE[u.role] as string[];
  if (cmd === 'start' || cmd === 'help' || !allowed.includes(cmd)) {
    if (cmd !== 'start' && cmd !== 'help' && (COMMAND_DESCRIPTIONS as any)[cmd]) {
      const deny = `⛔ ${b(u.language === 'uz' ? 'Bu buyruq sizning rolingiz uchun emas.' : 'Эта команда не для вашей роли.')}`;
      return `${deny}\n\n${helpText(u)}`;
    }
    return helpText(u);
  }
  switch (cmd as BotCommand) {
    case 'urgent':
      return urgent(u);
    case 'overdue':
      return overdue(u);
    case 'team':
      return team(u);
    case 'tasks':
      return myTasks(u);
    default:
      return helpText(u);
  }
}
