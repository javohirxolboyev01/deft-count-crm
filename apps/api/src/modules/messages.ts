import { DateTime } from 'luxon';
import { TZ } from '../common/time';

type Lang = 'uz' | 'ru';

const fmt = (iso?: string | null) =>
  iso ? DateTime.fromISO(iso).setZone(TZ).toFormat('dd.MM.yyyy HH:mm') : '—';

/** Telegram uchun matn (foydalanuvchi tilida). Ilova ichida frontend o'zi i18n qiladi. */
export function renderNotification(kind: string, p: any, lang: Lang): string {
  const uz = lang === 'uz';
  switch (kind) {
    case 'TASK_DONE':
      return uz
        ? `✅ Bajarildi: ${p.taskTitle}\nMijoz: ${p.clientName}\nBuxgalter: ${p.actorName ?? 'tizim'}`
        : `✅ Выполнено: ${p.taskTitle}\nКлиент: ${p.clientName}\nБухгалтер: ${p.actorName ?? 'система'}`;
    case 'TASK_OVERDUE':
      return uz
        ? `🔴 Muddat o'tdi: ${p.taskTitle}\nMijoz: ${p.clientName}\nMuddat: ${fmt(p.dueAt)}\nMas'ul: ${p.assigneeName ?? '—'}`
        : `🔴 Срок истёк: ${p.taskTitle}\nКлиент: ${p.clientName}\nСрок: ${fmt(p.dueAt)}\nОтветственный: ${p.assigneeName ?? '—'}`;
    case 'CLIENTS_OVERDUE': {
      const MAX = 20;
      const list: any[] = p.clients ?? [];
      const lines = list.slice(0, MAX).map((c, i) => {
        const who = p.scope === 'ALL' && c.accountantName ? ` (${c.accountantName})` : '';
        const wait = c.waiting ? (uz ? `, ${c.waiting} tasi mijozdan kutilmoqda` : `, ${c.waiting} ждут клиента`) : '';
        return uz
          ? `${i + 1}. ${c.clientName} — ${c.days} kun, ${c.tasks} ta vazifa${wait}${who}`
          : `${i + 1}. ${c.clientName} — ${c.days} дн., задач: ${c.tasks}${wait}${who}`;
      });
      if (list.length > MAX) lines.push(uz ? `… va yana ${list.length - MAX} ta mijoz` : `… и ещё клиентов: ${list.length - MAX}`);
      const date = p.date ? DateTime.fromISO(p.date).toFormat('dd.MM.yyyy') : '';
      return uz
        ? `⏰ Kechikkan mijozlar (${date})\nEslatma: ${p.clientCount} ta mijoz, ${p.taskCount} ta vazifa (jami kechikkan mijozlar: ${p.totalOverdueClients})\n\n${lines.join('\n')}`
        : `⏰ Просроченные клиенты (${date})\nНапоминание: клиентов ${p.clientCount}, задач ${p.taskCount} (всего просроченных клиентов: ${p.totalOverdueClients})\n\n${lines.join('\n')}`;
    }
    case 'URGENT_TASK':
      return uz
        ? `🚨 Shoshilinch vazifa: ${p.title}\nMijoz: ${p.clientName}\nMuddat: ${fmt(p.dueAt)}\nKim berdi: ${p.createdByName}`
        : `🚨 Срочная задача: ${p.title}\nКлиент: ${p.clientName}\nСрок: ${fmt(p.dueAt)}\nПоставил: ${p.createdByName}`;
    case 'TASK_TRANSFER': {
      const reason = transferReason(p, uz);
      return uz
        ? `🔁 Sizga vazifa o'tkazilmoqda: ${p.taskTitle}\nMijoz: ${p.clientName}\nKimdan: ${p.fromName ?? '—'}${p.actorName !== p.fromName ? ` (so'rov: ${p.actorName})` : ''}\nSabab: ${reason}\nMuddat: ${fmt(p.dueAt)}\nCRM'da "Qabul qilaman" yoki "Rad etaman" ni bosing.`
        : `🔁 Вам передают задачу: ${p.taskTitle}\nКлиент: ${p.clientName}\nОт кого: ${p.fromName ?? '—'}${p.actorName !== p.fromName ? ` (запрос: ${p.actorName})` : ''}\nПричина: ${reason}\nСрок: ${fmt(p.dueAt)}\nВ CRM нажмите «Принять» или «Отклонить».`;
    }
    case 'TASK_TRANSFER_RESULT':
      return p.accepted
        ? uz
          ? `✅ ${p.toName} vazifani qabul qildi: ${p.taskTitle}\nMijoz: ${p.clientName}`
          : `✅ ${p.toName} принял(а) задачу: ${p.taskTitle}\nКлиент: ${p.clientName}`
        : uz
          ? `↩️ ${p.toName} vazifani rad etdi: ${p.taskTitle}\nMijoz: ${p.clientName}${p.rejectReason ? `\nSabab: ${p.rejectReason}` : ''}\nVazifa sizda qoldi.`
          : `↩️ ${p.toName} отклонил(а) задачу: ${p.taskTitle}\nКлиент: ${p.clientName}${p.rejectReason ? `\nПричина: ${p.rejectReason}` : ''}\nЗадача осталась за вами.`;
    case 'LEAD_WON':
      return uz
        ? `🤝 Yangi mijoz topildi: ${p.leadName}\nSTIR: ${p.stir}\nOperator: ${p.actorName}${p.comment ? `\nIzoh: ${p.comment}` : ''}\nBuxgalter biriktiring.`
        : `🤝 Найден новый клиент: ${p.leadName}\nИНН: ${p.stir}\nОператор: ${p.actorName}${p.comment ? `\nКомментарий: ${p.comment}` : ''}\nНазначьте бухгалтера.`;
    default:
      return uz ? `Bildirishnoma: ${kind}` : `Уведомление: ${kind}`;
  }
}

function transferReason(p: any, uz: boolean) {
  const base: Record<string, [string, string]> = {
    NOT_MINE: ['Menga tegishli emas', 'Не относится ко мне'],
    BUSY: ['Bandman', 'Занят(а)'],
    OTHER: ['Boshqa sabab', 'Другая причина'],
  };
  const label = base[p.reasonCode]?.[uz ? 0 : 1] ?? p.reasonCode;
  return p.reasonText ? (p.reasonCode === 'OTHER' ? p.reasonText : `${label} — ${p.reasonText}`) : label;
}

export const telegramTexts = {
  linked: { uz: 'Telegram hisobingiz CRM bilan bog\'landi ✅', ru: 'Telegram привязан к CRM ✅' },
  badCode: {
    uz: 'Kod noto\'g\'ri yoki muddati o\'tgan. Profil sahifasidan yangi kod oling.',
    ru: 'Код неверный или устарел. Получите новый код на странице профиля.',
  },
  help: {
    uz: 'Bog\'lash uchun: profil sahifasidagi kodni /start <kod> ko\'rinishida yuboring.',
    ru: 'Для привязки отправьте /start <код> с кодом из профиля.',
  },
};
