import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { api, app, createUser, pool, q, resetDb, seedTeam, token } from './helpers';

// Firma Telegram akkaunti (V53): Telegram'ga haqiqiy ulanishsiz tekshiriladigan qismlar — ruxsatlar va holatlar
let L: ReturnType<typeof api>;
let A: ReturnType<typeof api>;
let O: ReturnType<typeof api>;
const saved = { ...config.tgAccount };

beforeAll(async () => {
  await resetDb();
  await seedTeam();
  await createUser('op', 'OPERATOR', 'Operator');
  L = api(await token('leader'));
  A = api(await token('acc1'));
  O = api(await token('op'));
});

afterAll(() => {
  Object.assign(config.tgAccount, saved);
});

describe('Telegram akkaunti', () => {
  it('jadvallar: bitta akkaunt qatori, muallif belgisi', async () => {
    const cols = await q(pool, `SELECT table_name FROM information_schema.tables WHERE table_name IN ('tg_account', 'tg_sent_message') ORDER BY 1`);
    expect(cols.map((c: any) => c.table_name)).toEqual(['tg_account', 'tg_sent_message']);
    await expect(pool.query(`INSERT INTO tg_account (id, session_enc) VALUES (2, 'x')`)).rejects.toThrow();
  });

  it('operatorga yopiq', async () => {
    expect((await O.get('/api/tg/status')).status).toBe(403);
    expect((await O.get('/api/tg/dialogs')).status).toBe(403);
  });

  it('API sozlanmagan: holat va tushunarli xato', async () => {
    Object.assign(config.tgAccount, { apiId: 0, apiHash: '' });
    const s = await A.get('/api/tg/status');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ configured: false, connected: false, account: null, login: null });
    const d = await A.get('/api/tg/dialogs');
    expect(d.status).toBe(503);
    expect(d.body.code).toBe('TG_NOT_CONFIGURED');
    expect((await L.post('/api/tg/login/start', { phone: '+998901234567' })).body.code).toBe('TG_NOT_CONFIGURED');
  });

  it('sozlangan, ulanmagan: buxgalter ko\'radi, lekin ulay olmaydi', async () => {
    Object.assign(config.tgAccount, { apiId: 12345, apiHash: 'test-hash' });
    expect((await A.get('/api/tg/status')).body).toMatchObject({ configured: true, connected: false });
    const d = await A.get('/api/tg/dialogs');
    expect(d.status).toBe(503);
    expect(d.body.code).toBe('TG_NOT_CONNECTED');
    expect((await A.post('/api/tg/dialogs/123/messages', { text: 'salom' })).body.code).toBe('TG_NOT_CONNECTED');
    expect((await A.post('/api/tg/login/start', { phone: '+998901234567' })).status).toBe(403);
    expect((await A.post('/api/tg/logout')).status).toBe(403);
  });

  it('ulash: noto\'g\'ri raqam, jarayonsiz kod/parol', async () => {
    expect((await L.post('/api/tg/login/start', { phone: '12' })).status).toBe(400);
    const c = await L.post('/api/tg/login/code', { code: '12345' });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('TG_LOGIN_EXPIRED');
    expect((await L.post('/api/tg/login/password', { password: 'x' })).body.code).toBe('TG_LOGIN_EXPIRED');
  });

  it('xabar amallari va jildlar: tekshiruv, ulanmaganda tushunarli xato, operatorga yopiq', async () => {
    Object.assign(config.tgAccount, { apiId: 12345, apiHash: 'test-hash' });
    // Noto'g'ri so'rovlar Telegram'gacha yetmaydi
    expect((await A.patch('/api/tg/dialogs/123/messages/5').send({ text: '  ' })).status).toBe(400);
    expect((await A.patch('/api/tg/dialogs/123/messages/abc').send({ text: 'x' })).status).toBe(400);
    expect((await A.post('/api/tg/dialogs/123/messages/delete', { ids: [] })).status).toBe(400);
    expect((await A.post('/api/tg/dialogs/123/forward', { ids: [1], to: ['1', '2', '3', '4', '5', '6'] })).status).toBe(400);
    expect((await A.post('/api/tg/dialogs/123/translate', { ids: [1], to: 'de' })).status).toBe(400);
    // To'g'ri so'rov, lekin akkaunt ulanmagan
    for (const r of [
      await A.get('/api/tg/folders'),
      await A.get('/api/tg/dialogs/123/pinned'),
      await A.patch('/api/tg/dialogs/123/messages/5').send({ text: 'yangi' }),
      await A.post('/api/tg/dialogs/123/messages/delete', { ids: [5, 6], revoke: true }),
      await A.post('/api/tg/dialogs/123/messages/5/pin', {}),
      await A.post('/api/tg/dialogs/123/forward', { ids: [5], to: ['456'] }),
      await A.post('/api/tg/dialogs/123/translate', { ids: [5], to: 'uz' }),
    ]) {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('TG_NOT_CONNECTED');
    }
    expect((await O.get('/api/tg/folders')).status).toBe(403);
    expect((await O.post('/api/tg/dialogs/123/messages/delete', { ids: [1] })).status).toBe(403);
  });

  it('video/ovoz oqimi: imzoli havola faqat xodimga, boshqa maqsadli token o\'tmaydi', async () => {
    Object.assign(config.tgAccount, { apiId: 12345, apiHash: 'test-hash' });
    const r = await A.get('/api/tg/dialogs/123/media/5/link');
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^\/api\/tg-stream\/[\w-]+\.[\w-]+\.[\w-]+$/);
    expect((await O.get('/api/tg/dialogs/123/media/5/link')).status).toBe(403);
    // Ulanmagan — tushunarli xato (token to'g'ri)
    const s = await request(app).get(r.body.url).set('Range', 'bytes=0-');
    expect(s.status).toBe(503);
    expect(s.body.code).toBe('TG_NOT_CONNECTED');
    // Soxta va oddiy kirish tokeni (audience boshqa) — yo'q
    expect((await request(app).get('/api/tg-stream/abc')).status).toBe(401);
    const accessLike = jwt.sign({ sub: '1', p: '123', m: 5 }, config.jwtAccessSecret, { expiresIn: 60 });
    expect((await request(app).get(`/api/tg-stream/${accessLike}`)).status).toBe(401);
    // Operator nomidan imzolangan havola — 403
    const [op] = await q<{ id: number }>(pool, `SELECT id FROM app_user WHERE role = 'OPERATOR' LIMIT 1`);
    const opTok = jwt.sign({ sub: String(op.id), p: '123', m: 5 }, config.jwtAccessSecret, { expiresIn: 60, audience: 'tg-stream' });
    expect((await request(app).get(`/api/tg-stream/${opTok}`)).status).toBe(403);
  });

  it('fayl yuborish: tekshiruv, serverda iz qolmaydi, operatorga yopiq', async () => {
    Object.assign(config.tgAccount, { apiId: 12345, apiHash: 'test-hash' });
    const L2 = await token('leader');
    const up = (query: string, type = 'application/octet-stream', body: Buffer = Buffer.from('salom')) =>
      request(app).post(`/api/tg/upload${query}`).set('Authorization', `Bearer ${L2}`).set('Content-Type', type).send(body);
    expect((await up('?kind=PHOTO&name=a.jpg', 'application/json', Buffer.from('{}'))).status).toBe(415);
    expect((await up('?kind=XYZ&name=a.jpg')).status).toBe(400);
    expect((await up('?kind=FILE')).status).toBe(400);
    const big = await request(app)
      .post('/api/tg/upload?kind=FILE&name=a.bin')
      .set('Authorization', `Bearer ${L2}`)
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Length', String(101 * 1024 * 1024))
      .send(Buffer.from('x'))
      .catch((e) => e.response);
    expect(big?.status ?? 413).toBe(413);
    // Ulanmagan: fayl qabul qilinmaydi
    const r = await up('?kind=FILE&name=hisobot.pdf&mime=application/pdf');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('TG_NOT_CONNECTED');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const dir = `${os.tmpdir()}/crm-tg-upload`;
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    // Yuklanmagan/boshqa xodimniki — eskirgan
    const s = await A.post('/api/tg/dialogs/123/send-media', { uploads: ['3f6f2a52-1c1b-4d7e-9a7c-2b1d6c1e9f00'] });
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('TG_UPLOAD_EXPIRED');
    expect((await A.post('/api/tg/dialogs/123/send-media', { uploads: ['x'] })).status).toBe(400);
    expect((await A.post('/api/tg/dialogs/123/send-media', { uploads: [] })).status).toBe(400);
    expect((await O.post('/api/tg/dialogs/123/send-media', { uploads: ['3f6f2a52-1c1b-4d7e-9a7c-2b1d6c1e9f00'] })).status).toBe(403);
  });

  it('chat id va xabar tekshiruvi', async () => {
    expect((await A.get('/api/tg/dialogs/abc/messages')).status).toBe(400);
    expect((await A.post('/api/tg/dialogs/123/messages', { text: '   ' })).status).toBe(400);
  });
});
