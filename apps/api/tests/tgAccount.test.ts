import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { api, createUser, pool, q, resetDb, seedTeam, token } from './helpers';

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

  it('chat id va xabar tekshiruvi', async () => {
    expect((await A.get('/api/tg/dialogs/abc/messages')).status).toBe(400);
    expect((await A.post('/api/tg/dialogs/123/messages', { text: '   ' })).status).toBe(400);
  });
});
