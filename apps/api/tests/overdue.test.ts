import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { TZ } from '../src/common/time';
import { DEFAULT_OVERDUE_REMINDER, isReminderDay, reminderDays, remindOverdueClients } from '../src/modules/overdueReminder';
import { renderNotification } from '../src/modules/messages';
import { api, one, pool, q, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;

const steps = DEFAULT_OVERDUE_REMINDER.steps;
// Ish kuni 10:00 (sendAt 09:00 dan keyin)
const at10 = DateTime.now().setZone(TZ).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  L = api(await token('leader'));
  A1 = api(await token('acc1'));
});

describe('eslatma kunlari algoritmi', () => {
  it('standart: 1,2,3 har kuni → 2 kunda → 3 kunda → haftada', () => {
    expect(reminderDays(steps, 40)).toEqual([1, 2, 3, 5, 7, 10, 13, 16, 23, 30, 37]);
    expect(isReminderDay(0, steps)).toBe(false);
    expect(isReminderDay(4, steps)).toBe(false);
    expect(isReminderDay(100, steps)).toBe((100 - 16) % 7 === 0);
  });

  it('birinchi bosqich keyinroq boshlansa, undan oldingi kunlar jim', () => {
    expect(reminderDays([{ fromDay: 3, everyDays: 3 }], 12)).toEqual([3, 6, 9, 12]);
  });
});

describe('kechikkan mijozlar: buxgalter va rahbarga kunlik xabar', () => {
  let a: number;
  let b: number;
  let c: number;

  /** Mijozning bitta ochiq vazifasini `days` kun oldin muddati o'tgan qilish */
  const overdue = async (clientId: number, days: number, status = 'TODO') => {
    const t = await one<{ id: number }>(
      pool,
      `SELECT id FROM task WHERE client_id = $1 AND status = 'TODO' AND due_at > now() ORDER BY id LIMIT 1`,
      [clientId],
    );
    await pool.query(`UPDATE task SET due_at = $2, status = $3, overdue_notified_at = now() WHERE id = $1`, [
      t!.id,
      at10.minus({ days }).toJSDate(),
      status,
    ]);
  };

  beforeAll(async () => {
    const mk = async (stir: string, name: string, accountantId: number) =>
      (await L.post('/api/clients', { stir, name, taxType: 'AOS', accountantId })).body.id as number;
    a = await mk('301000001', 'ALFA', team.acc1);
    b = await mk('301000002', 'BETA', team.acc2);
    c = await mk('301000003', 'GAMMA', team.acc1);
    // Hamma ochiq vazifa kelajakda, faqat kerakli vazifalar kechikadi
    await pool.query(`UPDATE task SET due_at = now() + interval '10 days' WHERE status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')`);
    await overdue(a, 5); // eslatma kuni
    await overdue(a, 1);
    await overdue(b, 4); // eslatma kuni emas
    await overdue(c, 2, 'WAITING_CLIENT');
  });

  it('sendAt dan oldin yubormaydi', async () => {
    expect((await remindOverdueClients(at10.set({ hour: 8 }))).skipped).toBe('TOO_EARLY');
  });

  it('eslatma kuni kelgan mijozlar yuboriladi, kuniga bir marta', async () => {
    const r = await remindOverdueClients(at10);
    expect(r.skipped).toBeNull();
    expect((await remindOverdueClients(at10.plus({ hours: 3 }))).skipped).toBe('ALREADY_RAN');

    const rows = await q(pool, `SELECT user_id, payload FROM notification WHERE kind = 'CLIENTS_OVERDUE' ORDER BY user_id`);
    expect(rows.map((x) => x.user_id)).toEqual([team.leader, team.acc1]); // acc2: BETA 4-kun, eslatma yo'q

    const leader = rows[0].payload;
    expect(leader.scope).toBe('ALL');
    expect(leader.clients.map((x: any) => [x.clientName, x.days, x.tasks, x.waiting])).toEqual([
      ['ALFA', 5, 2, 0],
      ['GAMMA', 2, 1, 1],
    ]);
    expect(leader.totalOverdueClients).toBe(3);
    expect(leader.clients[0].accountantName).toBe('Aziza');

    const acc = rows[1].payload;
    expect(acc.scope).toBe('MINE');
    expect(acc.clients.map((x: any) => x.clientId)).toEqual([a, c]);

    const text = renderNotification('CLIENTS_OVERDUE', leader, 'uz');
    expect(text).toContain('<b>ALFA</b> — 5 kun, 2 ta vazifa (Aziza)');
    expect(text).toContain('mijozdan kutilmoqda');
  });

  it('keyingi kun: kechikish kunlari oshadi, ro\'yxat qayta hisoblanadi', async () => {
    // Ertaga: ALFA 6 (yo'q), BETA 5 (bor), GAMMA 3 (bor)
    await remindOverdueClients(at10.plus({ days: 1 }));
    const rows = await q(
      pool,
      `SELECT user_id, payload FROM notification WHERE kind = 'CLIENTS_OVERDUE' AND dedupe_key = $1 ORDER BY user_id`,
      [`clients-overdue:${at10.plus({ days: 1 }).toISODate()}`],
    );
    expect(rows.map((x) => x.user_id)).toEqual([team.leader, team.acc1, team.acc2]);
    expect(rows[0].payload.clients.map((x: any) => [x.clientName, x.days])).toEqual([
      ['BETA', 5],
      ['GAMMA', 3],
    ]);
  });

  it('sozlama: faqat rahbar o\'zgartiradi, noto\'g\'ri qoida 400, o\'chirilsa yubormaydi', async () => {
    const body = { enabled: false, sendAt: '08:30', steps: [{ fromDay: 2, everyDays: 2 }, { fromDay: 1, everyDays: 1 }] };
    expect((await A1.put('/api/settings/overdue-reminder', body)).status).toBe(403);
    expect((await L.put('/api/settings/overdue-reminder', { ...body, steps: [{ fromDay: 1, everyDays: 1 }, { fromDay: 1, everyDays: 2 }] })).status).toBe(400);
    const r = await L.put('/api/settings/overdue-reminder', body);
    expect(r.status).toBe(200);
    expect(r.body.steps[0].fromDay).toBe(1); // tartiblanadi
    expect(r.body.previewDays.slice(0, 4)).toEqual([1, 2, 4, 6]);
    expect((await A1.get('/api/settings/overdue-reminder')).body.sendAt).toBe('08:30');
    expect((await remindOverdueClients(at10.plus({ days: 2 }))).skipped).toBe('DISABLED');
  });
});
