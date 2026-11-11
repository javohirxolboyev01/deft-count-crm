import { beforeAll, describe, expect, it } from 'vitest';
import { renderNotification } from '../src/modules/messages';
import { botUserByChat, runCommand } from '../src/modules/telegramCommands';
import { api, createUser, pool, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let operator: number;

/** Chatni xodimga bog'lash (bot /start <kod> natijasi bilan bir xil) */
const link = (userId: number, chatId: number) =>
  pool.query('UPDATE app_user SET telegram_chat_id = $2 WHERE id = $1', [userId, chatId]);

/**
 * Telegram HTML talabi: faqat ruxsat etilgan teglar, hammasi yopilgan, `<`/`&` ekranlangan.
 * Buzilsa Telegram 400 qaytaradi va xabar yetmaydi.
 */
function assertTelegramHtml(html: string) {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>|&(?!amp;|lt;|gt;|quot;)/g)) {
    if (m[0] === '&') throw new Error(`ekranlanmagan &: ${html}`);
    const [, close, tag] = m;
    if (!['b', 'i', 'code', 'a', 'blockquote'].includes(tag!)) throw new Error(`ruxsatsiz teg <${tag}>`);
    if (close) {
      if (stack.pop() !== tag) throw new Error(`teg yopilishi noto'g'ri </${tag}>: ${html}`);
    } else stack.push(tag!);
  }
  expect(stack).toEqual([]);
}

/** Tekshiruv uchun ko'rinadigan matn (teglarsiz) */
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const ask = async (chatId: number, cmd: string) => {
  const u = await botUserByChat(chatId);
  if (!u) throw new Error('bog\'lanmagan');
  const html = await runCommand(u, cmd);
  assertTelegramHtml(html);
  return plain(html);
};

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  operator = await createUser('op1', 'OPERATOR', 'Operator');
  const L = api(await token('leader'));
  const c1 = await L.post('/api/clients', { stir: '401000001', name: 'ALFA MCHJ', taxType: 'AOS', accountantId: team.acc1 });
  const c2 = await L.post('/api/clients', { stir: '401000002', name: 'BETA MCHJ', taxType: 'AOS', accountantId: team.acc2 });
  await L.post('/api/tasks/urgent', { clientId: c1.body.id, text: 'Alfa uchun akt sverka', assigneeId: team.acc1 });
  await L.post('/api/tasks/urgent', { clientId: c2.body.id, text: 'Beta bank ko\'chirmasi', assigneeId: team.acc2 });
  await link(team.leader, 1001);
  await link(team.acc1, 1002);
  await link(team.acc2, 1003);
  await link(operator, 1004);
});

describe('Telegram bot buyruqlari: rollar aralashmaydi', () => {
  it('rahbar barcha buxgalterlarning shoshilinch vazifalarini mas\'uli bilan ko\'radi', async () => {
    const text = await ask(1001, 'urgent');
    expect(text).toContain('Alfa uchun akt sverka');
    expect(text).toContain('Beta bank ko\'chirmasi');
    expect(text).toContain('Aziza');
    expect(text).toContain('Bobur');
  });

  it('rahbar xodimlar kesimini ko\'radi', async () => {
    const text = await ask(1001, 'team');
    expect(text).toMatch(/Aziza[\s\S]*Shoshilinch: 1/);
    expect(text).toMatch(/Bobur[\s\S]*Shoshilinch: 1/);
  });

  it('buxgalter faqat o\'z vazifasini ko\'radi', async () => {
    const urgent = await ask(1002, 'urgent');
    expect(urgent).toContain('Alfa uchun akt sverka');
    expect(urgent).not.toContain('Beta');
    const tasks = await ask(1002, 'tasks');
    expect(tasks).toContain('Alfa uchun akt sverka');
    expect(tasks).not.toContain('Beta');
  });

  it('buxgalterga rahbar buyruqlari yopiq', async () => {
    for (const cmd of ['team', 'overdue']) {
      const text = await ask(1003, cmd);
      expect(text).toContain('⛔');
      expect(text).not.toContain('Aziza');
      expect(text).not.toContain('Alfa');
    }
  });

  it('operatorga vazifa ma\'lumoti berilmaydi', async () => {
    for (const cmd of ['urgent', 'tasks', 'team', 'overdue']) {
      const text = await ask(1004, cmd);
      expect(text).not.toContain('Alfa');
      expect(text).not.toContain('Beta');
    }
  });

  it('bildirishnoma matni Telegram HTML: maxsus belgilar ekranlanadi, teglar to\'g\'ri', () => {
    const p = {
      title: 'Akt <sverka> & hisob',
      taskTitle: 'Akt <sverka> & hisob',
      clientName: 'A&B <MCHJ>',
      dueAt: '2026-11-11T13:00:00.000Z',
      createdByName: 'Rahbar',
      fromName: 'Aziza',
      actorName: 'Aziza',
      reasonCode: 'OTHER',
      reasonText: 'Menda <vaqt> yo\'q & band',
      toName: 'Bobur',
      leadName: 'X & Y',
      stir: '123',
      comment: '<b>',
    };
    for (const kind of ['URGENT_TASK', 'TASK_TRANSFER', 'TASK_DONE', 'TASK_OVERDUE', 'TASK_CANCELLED', 'LEAD_WON']) {
      for (const lang of ['uz', 'ru'] as const) {
        const html = renderNotification(kind, p, lang);
        assertTelegramHtml(html);
        expect(html).not.toContain('<sverka>');
      }
    }
    for (const accepted of [true, false]) {
      assertTelegramHtml(renderNotification('TASK_TRANSFER_RESULT', { ...p, accepted, rejectReason: 'a < b' }, 'uz'));
    }
    const urgent = renderNotification('URGENT_TASK', p, 'uz');
    expect(urgent).toContain('<b>Akt &lt;sverka&gt; &amp; hisob</b>');
    expect(plain(urgent)).toContain('Mijoz: A&B <MCHJ>');
    expect(plain(urgent)).toContain('Muddat: 11.11.2026 18:00');
    const clients = renderNotification('CLIENTS_OVERDUE', {
      date: '2026-11-11', scope: 'ALL', clientCount: 1, taskCount: 2, totalOverdueClients: 1,
      clients: [{ clientName: 'A&B', days: 3, tasks: 2, waiting: 0, accountantName: 'Aziza' }],
    }, 'uz');
    assertTelegramHtml(clients);
    for (const p2 of [{ daysLeft: 1, nextPaymentDate: '2026-12-15', amount: 5, hasCard: true, billingUrl: 'https://x.y/a?b=1&c=2' }]) {
      assertTelegramHtml(renderNotification('SERVER_PAYMENT', p2, 'ru'));
      assertTelegramHtml(renderNotification('SERVER_PAYMENT', { ...p2, trial: true }, 'uz'));
      assertTelegramHtml(renderNotification('SERVER_PAYMENT', { ...p2, paymentFailed: true }, 'uz'));
    }
  });

  it('bog\'lanmagan yoki faolsizlantirilgan xodim chati hech narsa olmaydi', async () => {
    expect(await botUserByChat(9999)).toBeUndefined();
    await pool.query('UPDATE app_user SET active = false WHERE id = $1', [team.acc2]);
    expect(await botUserByChat(1003)).toBeUndefined();
    await pool.query('UPDATE app_user SET active = true WHERE id = $1', [team.acc2]);
  });
});
