import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { api, app, createUser, pool, resetDb, seedTeam, token } from './helpers';

// Telegram ombori o'rniga xotira: testlar tashqi tarmoqqa chiqmaydi
const tg = vi.hoisted(() => ({ files: new Map<string, Buffer>(), enabled: true, captions: [] as string[] }));
vi.mock('../src/modules/telegramStorage', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    storageEnabled: () => tg.enabled,
    uploadToTelegram: async (buf: Buffer, _name: string, _mime: string, caption: string) => {
      const fileId = `f${tg.files.size + 1}`;
      tg.files.set(fileId, buf);
      tg.captions.push(caption);
      return { fileId, fileUniqueId: `u${fileId}`, chatId: '-1001', messageId: tg.files.size };
    },
    downloadFromTelegram: async (fileId: string) => tg.files.get(fileId)!,
  };
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

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

describe('chat fayllari (Telegram ombori, V43)', () => {
  const upload = (tok: string, to: number, fields: Record<string, string>, file?: { buf: Buffer; name: string; type: string }) => {
    let r = request(app).post(`/api/chat/with/${to}/attachment`).set('Authorization', `Bearer ${tok}`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    if (file) r = r.attach('file', file.buf, { filename: file.name, contentType: file.type });
    return r;
  };
  let tL: string;
  let tA1: string;
  let tO: string;
  beforeAll(async () => {
    tL = await token('leader');
    tA1 = await token('acc1');
    tO = await token('op');
  });

  it('rasm izoh bilan: ro\'yxatda, tarixda, faqat ishtirokchilarga beriladi', async () => {
    expect((await L.get('/api/chat/config')).body).toEqual({ attachments: true, maxFileBytes: 20 * 1024 * 1024 });
    const r = await upload(tA1, team.leader, { kind: 'IMAGE', body: ' Hujjat surati ', width: '800', height: '600' }, { buf: PNG, name: 'chek.png', type: 'image/png' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      senderId: team.acc1,
      body: 'Hujjat surati',
      attachment: { kind: 'IMAGE', mime: 'image/png', fileName: 'chek.png', sizeBytes: PNG.length, width: 800, height: 600 },
    });
    // Kanalga ism yoki matn emas, faqat texnik belgi ketadi
    expect(tg.captions.at(-1)).toBe(`crm-chat IMAGE u${team.acc1}→u${team.leader}`);

    const fileId = r.body.attachment.id;
    const got = await L.get(`/api/chat/files/${fileId}`).buffer(true);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(got.body, PNG)).toBe(0);
    expect((await O.get(`/api/chat/files/${fileId}`)).status).toBe(404);

    const last = (await L.get('/api/chat/contacts')).body.find((c: any) => c.id === team.acc1).lastMessage;
    expect(last).toMatchObject({ body: 'Hujjat surati', attachmentKind: 'IMAGE' });
    expect((await L.get(`/api/chat/with/${team.acc1}`)).body.items.at(-1).attachment.id).toBe(fileId);
  });

  it('ovozli xabar izohsiz; izohni olib tashlash mumkin, matnli xabarda — yo\'q', async () => {
    const r = await upload(tL, team.acc1, { kind: 'VOICE', durationSec: '7', waveform: '0,5,31,12' }, { buf: Buffer.from('ogg'), name: 'voice.webm', type: 'audio/webm;codecs=opus' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ body: '', attachment: { kind: 'VOICE', mime: 'audio/webm', durationSec: 7, waveform: [0, 5, 31, 12] } });
    const bad = await upload(tL, team.acc1, { kind: 'VOICE', waveform: '0,99' }, { buf: Buffer.from('ogg'), name: 'voice.webm', type: 'audio/webm' });
    expect(bad.status).toBe(400);
    expect((await L.patch(`/api/chat/messages/${r.body.id}`, { body: 'izoh' })).body.body).toBe('izoh');
    expect((await L.patch(`/api/chat/messages/${r.body.id}`, { body: '' })).status).toBe(200);
    const txt = (await L.post(`/api/chat/with/${team.acc1}`, { body: 'matn' })).body;
    expect((await L.patch(`/api/chat/messages/${txt.id}`, { body: '' })).status).toBe(400);
  });

  it('tur, hajm va davomiylik tekshiriladi; o\'chirilgan xabar fayli berilmaydi', async () => {
    const svg = { buf: Buffer.from('<svg/>'), name: 'x.svg', type: 'image/svg+xml' };
    expect((await upload(tA1, team.leader, { kind: 'IMAGE' }, svg)).status).toBe(415);
    expect((await upload(tA1, team.leader, { kind: 'VOICE' }, { buf: PNG, name: 'a.png', type: 'image/png' })).status).toBe(415);
    expect((await upload(tA1, team.leader, { kind: 'IMAGE' })).status).toBe(400);
    const long = await upload(tA1, team.leader, { kind: 'VIDEO_NOTE', durationSec: '61' }, { buf: Buffer.from('v'), name: 'v.webm', type: 'video/webm' });
    expect(long.status).toBe(400);
    const big = await upload(tA1, team.leader, { kind: 'VIDEO' }, { buf: Buffer.alloc(20 * 1024 * 1024 + 1), name: 'big.mp4', type: 'video/mp4' });
    expect(big.status).toBe(413);

    const v = await upload(tA1, team.leader, { kind: 'VIDEO_NOTE', durationSec: '12' }, { buf: Buffer.from('v'), name: 'v.webm', type: 'video/webm' });
    expect(v.status).toBe(201);
    expect((await A1.del(`/api/chat/messages/${v.body.id}`)).status).toBe(200);
    expect((await L.get(`/api/chat/files/${v.body.attachment.id}`)).status).toBe(404);
  });

  it('brauzer turni buzib yuborsa (text/plain) — kengaytmadan aniqlanadi', async () => {
    const r = await upload(tA1, team.leader, { kind: 'VIDEO_NOTE', durationSec: '5', width: '384', height: '384' }, { buf: Buffer.from('v'), name: 'video-note-1.mp4', type: 'text/plain' });
    expect(r.status).toBe(201);
    expect(r.body.attachment).toMatchObject({ kind: 'VIDEO_NOTE', mime: 'video/mp4' });
  });

  it('hujjat (FILE): istalgan tur, faqat yuklab olinadi', async () => {
    const html = Buffer.from('<script>alert(1)</script>');
    const r = await upload(tA1, team.leader, { kind: 'FILE' }, { buf: html, name: 'Hisobot 2026.html', type: 'text/html' });
    expect(r.status).toBe(201);
    expect(r.body.attachment).toMatchObject({ kind: 'FILE', mime: 'text/html', fileName: 'Hisobot 2026.html' });
    const got = await L.get(`/api/chat/files/${r.body.attachment.id}`).buffer(true);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['content-disposition']).toMatch(/^attachment;/);
    expect(got.headers['content-security-policy']).toBe('sandbox');
  });

  it('ombor sozlanmagan bo\'lsa fayl qabul qilinmaydi', async () => {
    tg.enabled = false;
    try {
      expect((await L.get('/api/chat/config')).body.attachments).toBe(false);
      const r = await upload(tO, team.leader, { kind: 'IMAGE' }, { buf: PNG, name: 'a.png', type: 'image/png' });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('FILE_STORAGE_DISABLED');
    } finally {
      tg.enabled = true;
    }
  });
});
