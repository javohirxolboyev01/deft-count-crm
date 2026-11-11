import { DateTime } from 'luxon';
import { TZ } from '../common/time';
import { b, esc, link, post } from './telegramFormat';

type Lang = 'uz' | 'ru';

const fmt = (iso?: string | null) =>
  iso ? DateTime.fromISO(iso).setZone(TZ).toFormat('dd.MM.yyyy HH:mm') : '—';

/**
 * Telegram uchun matn (foydalanuvchi tilida, HTML — telegramFormat.ts). Ilova ichida frontend o'zi i18n qiladi.
 * Ko'rinish bir xil "post": belgi + sarlavha, vazifa nomi qalin, maydonlar alohida qatorda, sabab/izoh iqtibosda.
 */
export function renderNotification(kind: string, p: any, lang: Lang): string {
  const uz = lang === 'uz';
  const L = (a: string, r: string) => (uz ? a : r);
  const client = { icon: '🏢', label: L('Mijoz', 'Клиент'), value: p.clientName };
  switch (kind) {
    case 'TASK_DONE':
      return post({
        icon: '✅',
        title: L('Vazifa bajarildi', 'Задача выполнена'),
        subject: p.taskTitle,
        rows: [client, { icon: '👤', label: L('Buxgalter', 'Бухгалтер'), value: p.actorName ?? L('tizim', 'система') }],
      });
    case 'TASK_OVERDUE':
      return post({
        icon: '🔴',
        title: L("Muddat o'tdi", 'Срок истёк'),
        subject: p.taskTitle,
        rows: [
          client,
          { icon: '⏰', label: L('Muddat', 'Срок'), value: fmt(p.dueAt), strong: true },
          { icon: '👤', label: L("Mas'ul", 'Ответственный'), value: p.assigneeName ?? '—' },
        ],
      });
    case 'CLIENTS_OVERDUE': {
      const MAX = 20;
      const list: any[] = p.clients ?? [];
      const lines = list.slice(0, MAX).map((c, i) => {
        const who = p.scope === 'ALL' && c.accountantName ? ` (${c.accountantName})` : '';
        const wait = c.waiting ? (uz ? `, ${c.waiting} tasi mijozdan kutilmoqda` : `, ${c.waiting} ждут клиента`) : '';
        const rest = uz ? ` — ${c.days} kun, ${c.tasks} ta vazifa${wait}${who}` : ` — ${c.days} дн., задач: ${c.tasks}${wait}${who}`;
        return `${i + 1}. ${b(c.clientName)}${esc(rest)}`;
      });
      if (list.length > MAX) lines.push(esc(uz ? `… va yana ${list.length - MAX} ta mijoz` : `… и ещё клиентов: ${list.length - MAX}`));
      const date = p.date ? DateTime.fromISO(p.date).toFormat('dd.MM.yyyy') : '';
      return post({
        icon: '⏰',
        title: L(`Kechikkan mijozlar · ${date}`, `Просроченные клиенты · ${date}`),
        rows: [
          { icon: '🏢', label: L('Mijozlar', 'Клиентов'), value: p.clientCount, strong: true },
          { icon: '📋', label: L('Vazifalar', 'Задач'), value: p.taskCount, strong: true },
          { icon: '📊', label: L('Jami kechikkan mijozlar', 'Всего просроченных клиентов'), value: p.totalOverdueClients },
        ],
        // Uzun ro'yxat yig'ilgan holda turadi, bosilsa ochiladi
        extra: lines.length ? `<blockquote expandable>${lines.join('\n')}</blockquote>` : null,
      });
    }
    case 'URGENT_TASK':
      return post({
        icon: '🚨',
        title: L('SHOSHILINCH VAZIFA', 'СРОЧНАЯ ЗАДАЧА'),
        subject: p.title,
        rows: [
          client,
          { icon: '⏰', label: L('Muddat', 'Срок'), value: fmt(p.dueAt), strong: true },
          { icon: '👤', label: L('Kim berdi', 'Поставил'), value: p.createdByName },
        ],
        footer: L("CRM'da vazifani oching va «Jarayonda» ni bosing.", 'Откройте задачу в CRM и нажмите «В работе».'),
      });
    case 'TASK_TRANSFER': {
      const by = p.actorName && p.actorName !== p.fromName ? L(` (so'rov: ${p.actorName})`, ` (запрос: ${p.actorName})`) : '';
      return post({
        icon: '🔁',
        title: L("Sizga vazifa o'tkazilmoqda", 'Вам передают задачу'),
        subject: p.taskTitle,
        rows: [
          client,
          { icon: '👤', label: L('Kimdan', 'От кого'), value: `${p.fromName ?? '—'}${by}` },
          { icon: '⏰', label: L('Muddat', 'Срок'), value: fmt(p.dueAt), strong: true },
        ],
        quote: `${L('Sabab', 'Причина')}: ${transferReason(p, uz)}`,
        footer: L("CRM'da «Qabul qilaman» yoki «Rad etaman» ni bosing.", 'В CRM нажмите «Принять» или «Отклонить».'),
      });
    }
    case 'TASK_TRANSFER_RESULT':
      return p.accepted
        ? post({
            icon: '✅',
            title: L('Vazifa qabul qilindi', 'Задача принята'),
            subject: p.taskTitle,
            rows: [client, { icon: '👤', label: L('Qabul qildi', 'Принял(а)'), value: p.toName }],
          })
        : post({
            icon: '↩️',
            title: L('Vazifa rad etildi', 'Задача отклонена'),
            subject: p.taskTitle,
            rows: [client, { icon: '👤', label: L('Rad etdi', 'Отклонил(а)'), value: p.toName }],
            quote: p.rejectReason ? `${L('Sabab', 'Причина')}: ${p.rejectReason}` : null,
            footer: L('Vazifa sizda qoldi.', 'Задача осталась за вами.'),
          });
    case 'LEAD_WON':
      return post({
        icon: '🤝',
        title: L('Yangi mijoz topildi', 'Найден новый клиент'),
        subject: p.leadName,
        rows: [
          { icon: '🆔', label: L('STIR', 'ИНН'), value: p.stir, strong: true },
          { icon: '🎧', label: L('Operator', 'Оператор'), value: p.actorName },
        ],
        quote: p.comment ? `${L('Izoh', 'Комментарий')}: ${p.comment}` : null,
        footer: L('Buxgalter biriktiring.', 'Назначьте бухгалтера.'),
      });
    case 'SERVER_PAYMENT': {
      const pay = p.billingUrl ? link(p.billingUrl, L("Railway'da to'lash →", 'Оплатить в Railway →')) : null;
      if (p.paymentFailed) {
        return post({
          icon: '⚠️',
          title: L("Server to'lovi o'tmadi", 'Оплата сервера не прошла'),
          quote: L("Kartani tekshiring yoki to'lang, aks holda CRM to'xtab qolishi mumkin.", 'Проверьте карту или оплатите, иначе CRM может остановиться.'),
          extra: pay,
        });
      }
      const date = p.nextPaymentDate ? DateTime.fromISO(p.nextPaymentDate).toFormat('dd.MM.yyyy') : '—';
      const amount = p.amount != null ? ` (~$${Number(p.amount).toFixed(2)})` : '';
      const when = p.daysLeft === 0 ? L('bugun', 'сегодня') : uz ? `${p.daysLeft} kundan keyin` : `через ${p.daysLeft} дн.`;
      if (p.trial) {
        return post({
          icon: '⏳',
          title: L(`Server sinov muddati ${when} tugaydi`, `Пробный период сервера закончится ${when}`),
          rows: [{ icon: '📅', label: L('Sana', 'Дата'), value: date, strong: true }],
          quote: L("CRM to'xtamasligi uchun Railway'da Hobby tarifini tanlang va karta ulang.", 'Чтобы CRM не остановилась, выберите тариф Hobby в Railway и привяжите карту.'),
          extra: pay,
        });
      }
      const card = p.hasCard
        ? L("Kartadan o'zi yechiladi — kartada pul borligini tekshiring.", 'Спишется с карты автоматически — проверьте баланс карты.')
        : L("Karta ulanmagan — Railway'da karta ulang.", 'Карта не привязана — привяжите карту в Railway.');
      return post({
        icon: '💳',
        title: L(`Server to'lovi ${when}: ${date}${amount}`, `Оплата сервера ${when}: ${date}${amount}`),
        quote: card,
        extra: pay,
      });
    }
    default:
      return esc(uz ? `Bildirishnoma: ${kind}` : `Уведомление: ${kind}`);
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

/** Bot xizmat matnlari (HTML) */
export const telegramTexts = {
  linked: { uz: "✅ <b>Telegram CRM bilan bog'landi</b>", ru: '✅ <b>Telegram привязан к CRM</b>' },
  badCode: {
    uz: "❌ <b>Kod noto'g'ri yoki muddati o'tgan</b>\n<i>Profil sahifasidan yangi kod oling.</i>",
    ru: '❌ <b>Код неверный или устарел</b>\n<i>Получите новый код на странице профиля.</i>',
  },
  help: {
    uz: "🔗 <b>Bog'lash</b>\nCRM → Profil → «Kod olish», so'ng havolani bosing yoki botga <code>/start KOD</code> yuboring.",
    ru: '🔗 <b>Привязка</b>\nCRM → Профиль → «Получить код», затем откройте ссылку или отправьте боту <code>/start КОД</code>.',
  },
};
