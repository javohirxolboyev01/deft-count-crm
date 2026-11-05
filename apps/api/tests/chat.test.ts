import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, pool, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let operator: number;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let A2: ReturnType<typeof api>;
let O: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  operator = await createUser('op', 'OPERATOR', 'Operator');
  L = api(await token('leader'));
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
  O = api(await token('op'));
});

describe('ichki chat', () => {
  it('hamma rol yozadi, qabul qiluvchida o\'qilmaganlar soni, o\'qilgach nol', async () => {
    expect((await O.post(`/api/chat/with/${team.leader}`, { body: 'Salom, rahbar' })).status).toBe(201);
    expect((await A1.post(`/api/chat/with/${team.leader}`, { body: 'Hisobot tayyor' })).status).toBe(201);
    const sent = await A1.post(`/api/chat/with/${team.leader}`, { body: '  Tekshirib ko\'ring  ' });
    expect(sent.body).toMatchObject({ senderId: team.acc1, recipientId: team.leader, body: "Tekshirib ko'ring", readAt: null });

    expect((await L.get('/api/chat/unread-count')).body).toEqual({ count: 3, chats: 2 });
    const contacts = (await L.get('/api/chat/contacts')).body;
    // Oxirgi xabar bo'yicha tartib: avval acc1, keyin operator, keyin yozishmasiz acc2
    expect(contacts.map((c: any) => c.id)).toEqual([team.acc1, operator, team.acc2]);
    expect(contacts[0]).toMatchObject({ fullName: 'Aziza', unread: 2, lastMessage: { body: "Tekshirib ko'ring", senderId: team.acc1 } });
    expect(contacts[2].lastMessage).toBeNull();

    const hist = (await L.get(`/api/chat/with/${team.acc1}`)).body;
    expect(hist.items.map((m: any) => m.body)).toEqual(['Hisobot tayyor', "Tekshirib ko'ring"]);

    expect((await L.post(`/api/chat/with/${team.acc1}/read`)).body).toEqual({ read: 2 });
    expect((await L.get('/api/chat/unread-count')).body).toEqual({ count: 1, chats: 1 });
    // Yuboruvchi o'z xabari o'qilganini ko'radi (✓✓)
    const mine = (await A1.get(`/api/chat/with/${team.leader}`)).body.items;
    expect(mine.every((m: any) => m.readAt)).toBe(true);
  });

  it('begona suhbatni o\'qib bo\'lmaydi, bo\'sh xabar va o\'ziga yozish taqiqlangan', async () => {
    // acc2 leader↔acc1 suhbatini so'rasa — o'zi bilan acc1 suhbati (bo'sh) qaytadi, begona xabar emas
    const h = (await A2.get(`/api/chat/with/${team.acc1}`)).body;
    expect(h.items).toEqual([]);
    expect((await A2.post(`/api/chat/with/${team.acc1}`, { body: '   ' })).status).toBe(400);
    expect((await A2.post(`/api/chat/with/${team.acc2}`, { body: 'men' })).status).toBe(404);
    expect((await A2.post('/api/chat/with/999999', { body: 'yo\'q' })).status).toBe(404);
  });

  it('sahifalash: before bilan eski xabarlar', async () => {
    for (let i = 1; i <= 5; i++) await A2.post(`/api/chat/with/${operator}`, { body: `m${i}` });
    const p1 = (await O.get(`/api/chat/with/${team.acc2}?limit=3`)).body;
    expect(p1.items.map((m: any) => m.body)).toEqual(['m3', 'm4', 'm5']);
    expect(p1.hasMore).toBe(true);
    const p2 = (await O.get(`/api/chat/with/${team.acc2}?limit=3&before=${p1.items[0].id}`)).body;
    expect(p2.items.map((m: any) => m.body)).toEqual(['m1', 'm2']);
    expect(p2.hasMore).toBe(false);
  });

  it('faqat yuboruvchi tahrirlaydi va o\'chiradi; o\'chirilgan xabar hech qayerda ko\'rinmaydi', async () => {
    const m = (await A1.post(`/api/chat/with/${operator}`, { body: 'Xato yozildi' })).body;
    expect((await O.patch(`/api/chat/messages/${m.id}`, { body: 'begona' })).status).toBe(403);
    expect((await A2.patch(`/api/chat/messages/${m.id}`, { body: 'begona' })).status).toBe(404);
    expect((await A1.patch(`/api/chat/messages/${m.id}`, { body: ' ' })).status).toBe(400);
    const ed = await A1.patch(`/api/chat/messages/${m.id}`, { body: "To'g'ri yozildi" });
    expect(ed.status).toBe(200);
    expect(ed.body).toMatchObject({ body: "To'g'ri yozildi" });
    expect(ed.body.editedAt).toBeTruthy();
    expect((await O.get(`/api/chat/with/${team.acc1}`)).body.items.at(-1)).toMatchObject({ id: m.id, body: "To'g'ri yozildi" });

    const before = (await O.get('/api/chat/unread-count')).body.count;
    expect((await O.del(`/api/chat/messages/${m.id}`)).status).toBe(403);
    expect((await A1.del(`/api/chat/messages/${m.id}`)).status).toBe(200);
    expect((await O.get('/api/chat/unread-count')).body.count).toBe(before - 1);
    expect((await O.get(`/api/chat/with/${team.acc1}`)).body.items).toEqual([]);
    expect((await O.get('/api/chat/contacts')).body.find((c: any) => c.id === team.acc1)).toMatchObject({ unread: 0, lastMessage: null });
    expect((await A1.del(`/api/chat/messages/${m.id}`)).status).toBe(404);
    expect((await A1.patch(`/api/chat/messages/${m.id}`, { body: 'qayta' })).status).toBe(404);
  });

  it('faolsizlantirilgan xodimga yozilmaydi, lekin yozishma ro\'yxatda qoladi', async () => {
    await pool.query('UPDATE app_user SET active = false WHERE id = $1', [team.acc2]);
    expect((await O.post(`/api/chat/with/${team.acc2}`, { body: 'salom' })).status).toBe(404);
    const contacts = (await O.get('/api/chat/contacts')).body;
    expect(contacts.find((c: any) => c.id === team.acc2)).toMatchObject({ active: false, unread: 5 });
    expect((await O.get('/api/chat/unread-count')).status).toBe(200);
  });
});
