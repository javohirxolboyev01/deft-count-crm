import { DateTime } from 'luxon';
import type { Role } from '../common/auth';
import { TZ, nowTz } from '../common/time';
import { one, pool, q } from '../db';
import { WORKS_SCOPE } from './taskScope';

/**
 * Telegram bot buyruqlari (faqat o'qish). Qaror: chat → xodim har so'rovda bazadan topiladi (faol, o'chirilmagan),
 * rol va ko'rinish doirasi **serverda** shu xodim bo'yicha tekshiriladi — Telegram menyusi faqat qulaylik.
 *  - Rahbar: barcha buxgalterlar (shoshilinch, kechikkan, xodimlar kesimi).
 *  - Buxgalter: faqat o'ziga biriktirilgan vazifalar ("Mening kunim" doirasi bilan bir xil).
 *  - Sotuv operatori: buyruq yo'q (unga vazifa bildirishnomasi ham bormaydi).
 * Botdan holat o'zgartirilmaydi — "Bajarildi" faqat CRM'da (undo va audit oqimi o'sha yerda).
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
    uz: { LEADER: 'Barcha shoshilinch vazifalar va holati', ACCOUNTANT: 'Menga berilgan shoshilinch vazifalar', OPERATOR: '' },
    ru: { LEADER: 'Все срочные задачи и их статус', ACCOUNTANT: 'Мои срочные задачи', OPERATOR: '' },
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

/** Telegram bitta xabar chegarasi 4096; zaxira bilan kesamiz */
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

function line(r: Row, i: number, lang: Lang, opts: { assignee?: boolean } = {}) {
  const uz = lang === 'uz';
  const mark = r.status === 'DONE' ? '✅' : r.overdue ? '🔴' : r.status === 'WAITING_CLIENT' ? '🟠' : r.status === 'IN_PROGRESS' ? '🔵' : '⚪';
  const who = opts.assignee ? `\n   ${uz ? "Mas'ul" : 'Ответств.'}: ${r.assigneeName ?? '—'}` : '';
  const when = r.status === 'DONE' ? `${uz ? 'bajarildi' : 'выполнено'} ${fmt(r.doneAt)}` : `${uz ? 'muddat' : 'срок'} ${fmt(r.dueAt)}`;
  return `${i + 1}. ${mark} ${r.title} — ${r.clientName}${who}\n   ${STATUS[r.status]?.[lang] ?? r.status} · ${when}`;
}

/** Ro'yxatni xabar chegarasiga sig'diradi: sig'magani "… yana N ta" bo'ladi */
function fit(header: string, lines: string[], lang: Lang, footer = '') {
  let out = header;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - i;
    const tail = `\n… ${lang === 'uz' ? `yana ${rest} ta` : `ещё ${rest}`}`;
    if (out.length + lines[i].length + 1 + tail.length + footer.length > MAX_LEN) return out + tail + footer;
    out += `\n${lines[i]}`;
  }
  return out + footer;
}

const LEGEND: Record<Lang, string> = {
  uz: "\n\n🔴 muddati o'tgan · 🔵 jarayonda · 🟠 mijozdan kutilmoqda · ⚪ boshlanmagan",
  ru: '\n\n🔴 просрочено · 🔵 в работе · 🟠 ждём клиента · ⚪ не начато',
};

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
  if (!rows.length) return uz ? '🚨 Ochiq shoshilinch vazifa yo\'q.' : '🚨 Открытых срочных задач нет.';
  const open = rows.filter((r) => r.status !== 'DONE').length;
  const header = uz
    ? `🚨 Shoshilinch vazifalar: ochiq ${open} ta, bugun bajarilgan ${rows.length - open} ta`
    : `🚨 Срочные задачи: открыто ${open}, выполнено сегодня ${rows.length - open}`;
  return fit(header, rows.map((r, i) => line(r, i, u.language, { assignee: leader })), u.language, LEGEND[u.language]);
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
  if (!groups.length) return uz ? "✅ Muddati o'tgan vazifa yo'q." : '✅ Просроченных задач нет.';
  const total = groups.reduce((s, g) => s + g.total, 0);
  const header = uz ? `🔴 Muddati o'tgan vazifalar: ${total} ta` : `🔴 Просроченные задачи: ${total}`;
  const blocks = groups.map((g) => {
    const name = g.assigneeName ?? (uz ? 'Biriktirilmagan' : 'Не назначено');
    const head = uz
      ? `\n👤 ${name} — ${g.total} ta (boshlanmagan ${g.todo})`
      : `\n👤 ${name} — ${g.total} (не начато ${g.todo})`;
    const items = g.items.map((r, i) =>
      line({ ...r, dueAt: r.dueAt ? new Date(r.dueAt) : null, doneAt: null, overdue: true }, i, u.language),
    );
    const more = g.total > g.items.length ? `\n   … ${uz ? `yana ${g.total - g.items.length} ta` : `ещё ${g.total - g.items.length}`}` : '';
    return `${head}\n${items.join('\n')}${more}`;
  });
  return fit(header, blocks, u.language, LEGEND[u.language]);
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
  if (!rows.length) return uz ? "Faol buxgalter yo'q." : 'Активных бухгалтеров нет.';
  const header = uz ? `👥 Buxgalterlar (${nowTz().toFormat('dd.MM.yyyy HH:mm')})` : `👥 Бухгалтеры (${nowTz().toFormat('dd.MM.yyyy HH:mm')})`;
  const lines = rows.map((r) =>
    uz
      ? `\n👤 ${r.fullName}\n   Ochiq: ${r.open} · Kechikkan: ${r.overdue}${r.overdue ? ' 🔴' : ''} · Mijozdan kutilmoqda: ${r.waiting}\n   Shoshilinch: ${r.urgent}${r.urgent ? ' 🚨' : ''} · Bugun bajardi: ${r.doneToday}`
      : `\n👤 ${r.fullName}\n   Открыто: ${r.open} · Просрочено: ${r.overdue}${r.overdue ? ' 🔴' : ''} · Ждут клиента: ${r.waiting}\n   Срочные: ${r.urgent}${r.urgent ? ' 🚨' : ''} · Выполнено сегодня: ${r.doneToday}`,
  );
  return fit(header, lines, u.language);
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
  if (!urgentRows.length && !overdueRows.length && !todayRows.length) {
    return uz
      ? `✅ Shoshilinch, kechikkan va bugungi vazifa yo'q. Jami ochiq: ${rows.length} ta.`
      : `✅ Срочных, просроченных и на сегодня задач нет. Всего открыто: ${rows.length}.`;
  }
  const section = (title: string, list: Row[]) => (list.length ? [`\n${title} (${list.length})`, ...list.map((r, i) => line(r, i, u.language))] : []);
  const lines = [
    ...section(uz ? '🚨 Shoshilinch' : '🚨 Срочные', urgentRows),
    ...section(uz ? "🔴 Muddati o'tgan" : '🔴 Просроченные', overdueRows),
    ...section(uz ? '📅 Bugun' : '📅 Сегодня', todayRows),
  ];
  const header = uz ? `📋 ${u.fullName}: jami ochiq ${rows.length} ta` : `📋 ${u.fullName}: всего открыто ${rows.length}`;
  return fit(header, lines, u.language, uz ? '\n\nHolatni CRM\'da o\'zgartiring.' : '\n\nСтатус меняйте в CRM.');
}

export function helpText(u: BotUser) {
  const uz = u.language === 'uz';
  if (u.role === 'OPERATOR') {
    return uz
      ? `Salom, ${u.fullName}. Sotuv operatori uchun bot buyruqlari yo'q.`
      : `Здравствуйте, ${u.fullName}. Для оператора продаж команд бота нет.`;
  }
  const list = commandsFor(u.role, u.language).map((c) => `/${c.command} — ${c.description}`).join('\n');
  const intro = u.role === 'LEADER'
    ? uz ? 'Sizga shoshilinch vazifa bajarilganda, muddat o\'tganda va boshqa xabarlar shu yerga keladi.' : 'Сюда приходят уведомления о выполнении, просрочках и др.'
    : uz ? 'Sizga berilgan shoshilinch vazifa va eslatmalar shu yerga keladi (brauzer yopiq bo\'lsa ham).' : 'Сюда приходят срочные задачи и напоминания (даже если браузер закрыт).';
  return `${uz ? 'Salom' : 'Здравствуйте'}, ${u.fullName}. ${intro}\n\n${list}`;
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
      const deny = u.language === 'uz' ? "⛔ Bu buyruq sizning rolingiz uchun emas." : '⛔ Эта команда не для вашей роли.';
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
