import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, one, pool, q, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let acc3: number;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let A2: ReturnType<typeof api>;
let A3: ReturnType<typeof api>;
let clientId: number;

const urgent = async (assigneeId: number, text = 'Bank ko\'chirmasi') =>
  (await L.post('/api/tasks/urgent', { clientId, text, assigneeId })).body.id as number;

const notifs = (userId: number, kind: string) =>
  q<{ payload: any }>(pool, `SELECT payload FROM notification WHERE user_id = $1 AND kind = $2 AND channel = 'APP' ORDER BY id`, [userId, kind]);

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  acc3 = await createUser('acc3', 'ACCOUNTANT', 'Yorqin');
  L = api(await token('leader'));
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
  A3 = api(await token('acc3'));
  const c = await L.post('/api/clients', { stir: '301000001', name: 'TRANSFER MCHJ', taxType: 'AOS', accountantId: team.acc1 });
  clientId = c.body.id;
});

describe("vazifani boshqa xodimga o'tkazish", () => {
  it("egasi so'rov yuboradi, qabul qiluvchi rozi bo'lguncha vazifa egasida qoladi", async () => {
    const taskId = await urgent(team.acc1);
    const r = await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'NOT_MINE' });
    expect(r.status).toBe(201);
    expect(r.body.pendingTransfer).toMatchObject({ toUserId: team.acc2, reasonCode: 'NOT_MINE', requestedBy: team.acc1 });
    expect((await one(pool, 'SELECT assignee_id FROM task WHERE id = $1', [taskId])).assignee_id).toBe(team.acc1);

    // Qabul qiluvchiga xabar, vazifani ko'ra oladi, lekin holatini o'zgartira olmaydi
    expect((await notifs(team.acc2, 'TASK_TRANSFER')).at(-1)?.payload).toMatchObject({ taskId, fromName: 'Aziza', reasonCode: 'NOT_MINE' });
    const incoming = await A2.get('/api/task-transfers/incoming');
    expect(incoming.body.map((x: any) => x.taskId)).toContain(taskId);
    expect((await A2.get(`/api/tasks/${taskId}`)).status).toBe(200);
    expect((await A2.patch(`/api/tasks/${taskId}/status`, { status: 'IN_PROGRESS' })).status).toBe(403);

    // Ikkinchi so'rov bir vaqtda bo'lmaydi
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: acc3, reasonCode: 'BUSY' })).status).toBe(409);

    const transferId = r.body.pendingTransfer.id;
    // Faqat qabul qiluvchi qaror qiladi
    expect((await A3.post(`/api/task-transfers/${transferId}/accept`)).status).toBe(403);
    expect((await L.post(`/api/task-transfers/${transferId}/accept`)).status).toBe(403);
    const acc = await A2.post(`/api/task-transfers/${transferId}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.assigneeId).toBe(team.acc2);
    // Natija: so'rov yuborgan va vazifa muallifi (rahbar) biladi
    expect((await notifs(team.acc1, 'TASK_TRANSFER_RESULT')).at(-1)?.payload).toMatchObject({ taskId, accepted: true, toName: 'Bobur' });
    expect((await notifs(team.leader, 'TASK_TRANSFER_RESULT')).at(-1)?.payload).toMatchObject({ taskId, accepted: true });
    expect((await A2.post(`/api/task-transfers/${transferId}/accept`)).status).toBe(409);

    // Zanjir cheklanmaydi: yangi egasi yana o'tkazadi; eski egasi endi o'tkaza olmaydi
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: acc3, reasonCode: 'BUSY' })).status).toBe(403);
    const r2 = await A2.post('/api/task-transfers', { taskId, toUserId: acc3, reasonCode: 'OTHER', reasonText: 'Ertaga ta\'tildaman' });
    expect(r2.status).toBe(201);
    expect((await A3.post(`/api/task-transfers/${r2.body.pendingTransfer.id}/accept`)).body.assigneeId).toBe(acc3);

    const actions = await q<{ action: string }>(pool, `SELECT action FROM audit_log WHERE entity = 'task' AND entity_id = $1 ORDER BY id`, [String(taskId)]);
    expect(actions.map((a) => a.action)).toEqual(['CREATE_URGENT', 'TRANSFER_REQUEST', 'TRANSFER_ACCEPT', 'TRANSFER_REQUEST', 'TRANSFER_ACCEPT']);
    expect((await A3.get(`/api/tasks/${taskId}`)).body.transfers).toHaveLength(2);
  });

  it('rad etilsa vazifa egasida qoladi, egasiga sabab bilan xabar boradi', async () => {
    const taskId = await urgent(team.acc1);
    const r = await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'BUSY' });
    const rej = await A2.post(`/api/task-transfers/${r.body.pendingTransfer.id}/reject`, { reason: 'Men ham bandman' });
    expect(rej.status).toBe(200);
    expect((await one(pool, 'SELECT assignee_id FROM task WHERE id = $1', [taskId])).assignee_id).toBe(team.acc1);
    expect((await notifs(team.acc1, 'TASK_TRANSFER_RESULT')).at(-1)?.payload).toMatchObject({ taskId, accepted: false, rejectReason: 'Men ham bandman' });
    expect((await A2.get(`/api/tasks/${taskId}`)).status).toBe(403);
  });

  it("rahbar ham o'tkaza oladi; jarayondagi vazifa qabul qilinsa taymer to'xtaydi", async () => {
    const taskId = await urgent(team.acc1);
    await A1.patch(`/api/tasks/${taskId}/status`, { status: 'IN_PROGRESS' });
    const r = await L.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'OTHER', reasonText: 'Yuklama' });
    expect(r.status).toBe(201);
    const acc = await A2.post(`/api/task-transfers/${r.body.pendingTransfer.id}/accept`);
    expect(acc.body).toMatchObject({ assigneeId: team.acc2, status: 'TODO', timerStartedAt: null });
    // Rahbar o'zi so'ragan: unga natija xabari, eski egasiga ham
    expect((await notifs(team.acc1, 'TASK_TRANSFER_RESULT')).at(-1)?.payload).toMatchObject({ taskId, accepted: true });
  });

  it("so'rovni yuborgan qaytarib oladi", async () => {
    const taskId = await urgent(team.acc1);
    const r = await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'NOT_MINE' });
    const id = r.body.pendingTransfer.id;
    expect((await A2.post(`/api/task-transfers/${id}/cancel`)).status).toBe(403);
    expect((await A1.post(`/api/task-transfers/${id}/cancel`)).status).toBe(200);
    expect((await A2.post(`/api/task-transfers/${id}/accept`)).status).toBe(409);
  });

  it("cheklovlar: sabab majburiy, faqat URGENT/MANUAL, ochiq vazifa, faol buxgalter", async () => {
    const taskId = await urgent(team.acc1);
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2 })).status).toBe(400);
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'OTHER' })).status).toBe(400);
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: team.acc1, reasonCode: 'BUSY' })).body.code).toBe('TRANSFER_SAME');
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: team.leader, reasonCode: 'BUSY' })).body.code).toBe('INVALID_ASSIGNEE');
    // Begona buxgalter o'tkaza olmaydi
    expect((await A2.post('/api/task-transfers', { taskId, toUserId: acc3, reasonCode: 'BUSY' })).status).toBe(403);

    // Doimiy ish / hisobot o'tkazilmaydi
    const routine = await one<{ id: number }>(
      pool,
      `INSERT INTO task (client_id, kind, routine_type_id, period, title, assignee_id)
       VALUES ($1, 'ROUTINE', (SELECT id FROM routine_work_type ORDER BY id LIMIT 1), date '2020-01-01', 'Ish', $2) RETURNING id`,
      [clientId, team.acc1],
    );
    expect((await A1.post('/api/task-transfers', { taskId: routine!.id, toUserId: team.acc2, reasonCode: 'BUSY' })).body.code).toBe('TRANSFER_KIND');

    // Bajarilgan vazifa o'tkazilmaydi; kutilayotgan so'rovdagi vazifa bajarilsa qabul qilib bo'lmaydi
    const r = await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'BUSY' });
    await A1.post(`/api/tasks/${taskId}/done`);
    expect((await A2.get('/api/task-transfers/incoming')).body.map((x: any) => x.taskId)).not.toContain(taskId);
    expect((await A2.post(`/api/task-transfers/${r.body.pendingTransfer.id}/accept`)).body.code).toBe('TRANSFER_CLOSED');
    expect((await one(pool, 'SELECT status FROM task_transfer WHERE id = $1', [r.body.pendingTransfer.id])).status).toBe('CANCELLED');
    expect((await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'BUSY' })).body.code).toBe('TRANSFER_CLOSED');
  });
});

describe("rahbar shoshilinch vazifani o'chiradi", () => {
  it("buxgalter o'chira olmaydi; rahbar o'chirsa vazifa bekor, taymer to'xtaydi, so'rov bekor, ikkalasiga xabar", async () => {
    const taskId = await urgent(team.acc1, "O'chiriladigan vazifa");
    await A1.patch(`/api/tasks/${taskId}/status`, { status: 'IN_PROGRESS' });
    const tr = await A1.post('/api/task-transfers', { taskId, toUserId: team.acc2, reasonCode: 'BUSY' });

    expect((await A1.del(`/api/tasks/${taskId}`)).status).toBe(403);
    expect((await L.del(`/api/tasks/${taskId}`)).status).toBe(200);

    expect(await one(pool, 'SELECT status, cancel_reason FROM task WHERE id = $1', [taskId])).toMatchObject({ status: 'CANCELLED', cancel_reason: 'LEADER_DELETED' });
    expect((await one(pool, 'SELECT count(*)::int AS n FROM time_entry WHERE task_id = $1 AND ended_at IS NULL', [taskId])).n).toBe(0);
    expect((await one(pool, 'SELECT status FROM task_transfer WHERE id = $1', [tr.body.pendingTransfer.id])).status).toBe('CANCELLED');
    // Mas'ul va o'tkazish so'rovi qabul qiluvchisi biladi
    expect((await notifs(team.acc1, 'TASK_CANCELLED')).at(-1)?.payload).toMatchObject({ taskId, actorName: 'Rahbar' });
    expect((await notifs(team.acc2, 'TASK_CANCELLED')).at(-1)?.payload).toMatchObject({ taskId });
    // Buxgalter ro'yxatidan yo'qoladi
    const myDay = await A1.get('/api/tasks/my-day');
    expect(myDay.body.groups.urgent.map((x: any) => x.id)).not.toContain(taskId);
    // Ikkinchi marta o'chirilmaydi; audit'da qoladi
    expect((await L.del(`/api/tasks/${taskId}`)).body.code).toBe('TASK_NOT_DELETABLE');
    const actions = await q<{ action: string }>(pool, `SELECT action FROM audit_log WHERE entity = 'task' AND entity_id = $1 ORDER BY id`, [String(taskId)]);
    expect(actions.map((a) => a.action).at(-1)).toBe('DELETE');
  });

  it("bajarilgan va oylik (generator) vazifa o'chirilmaydi", async () => {
    const taskId = await urgent(team.acc1, 'Bajariladigan');
    await A1.post(`/api/tasks/${taskId}/done`);
    expect((await L.del(`/api/tasks/${taskId}`)).body.code).toBe('TASK_NOT_DELETABLE');
    const routine = await one(pool, `SELECT id FROM task WHERE kind IN ('ROUTINE','REPORT') AND status <> 'CANCELLED' LIMIT 1`);
    if (routine) expect((await L.del(`/api/tasks/${routine.id}`)).body.code).toBe('TASK_NOT_DELETABLE');
  });
});
