import { beforeAll, describe, expect, it } from 'vitest';
import { botUserByChat, runCommand } from '../src/modules/telegramCommands';
import { api, createUser, pool, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let operator: number;

/** Chatni xodimga bog'lash (bot /start <kod> natijasi bilan bir xil) */
const link = (userId: number, chatId: number) =>
  pool.query('UPDATE app_user SET telegram_chat_id = $2 WHERE id = $1', [userId, chatId]);

const ask = async (chatId: number, cmd: string) => {
  const u = await botUserByChat(chatId);
  if (!u) throw new Error('bog\'lanmagan');
  return runCommand(u, cmd);
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

  it('bog\'lanmagan yoki faolsizlantirilgan xodim chati hech narsa olmaydi', async () => {
    expect(await botUserByChat(9999)).toBeUndefined();
    await pool.query('UPDATE app_user SET active = false WHERE id = $1', [team.acc2]);
    expect(await botUserByChat(1003)).toBeUndefined();
    await pool.query('UPDATE app_user SET active = true WHERE id = $1', [team.acc2]);
  });
});
