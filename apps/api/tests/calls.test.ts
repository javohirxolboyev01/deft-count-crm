import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { channelPeer, resolveCall, uniqueidFromName } from '../src/modules/calls';

// Telegram kanali o'rniga: yuklangan fayllar xotirada
const tgFiles = new Map<string, Buffer>();
vi.mock('../src/modules/telegramStorage', async (orig) => ({
  ...(await orig<typeof import('../src/modules/telegramStorage')>()),
  uploadToTelegram: vi.fn(async (buf: Buffer, _name: string, _mime: string, _caption: string, _vn: unknown, chatId: string) => {
    const id = `tg-${tgFiles.size + 1}`;
    tgFiles.set(id, buf);
    return { fileId: id, fileUniqueId: `u-${id}`, chatId, messageId: tgFiles.size };
  }),
  downloadFromTelegram: vi.fn(async (id: string) => tgFiles.get(id)!),
}));
import { api, app, createUser, one, pool, resetDb, seedTeam, token } from './helpers';

const TOKEN = 'test-pbx-token-0123456789abcdef-0123456789';

let team: Awaited<ReturnType<typeof seedTeam>>;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let A2: ReturnType<typeof api>;
let O: ReturnType<typeof api>;
let clientId: number;
let leadId: number;

const ingest = (records: unknown[], tok = TOKEN) =>
  request(app).post('/api/calls/ingest').set('Authorization', `Bearer ${tok}`).send({ records });

const cdr = (over: Record<string, string>) => ({
  src: '',
  dst: '',
  channel: '',
  dstchannel: '',
  start: '2026-11-10 10:00:00',
  answer: '2026-11-10 10:00:05',
  end: '2026-11-10 10:02:05',
  duration: '125',
  billsec: '120',
  disposition: 'ANSWERED',
  ...over,
});

beforeAll(async () => {
  config.pbx.ingestToken = TOKEN;
  config.telegram.callsChatId = '-100777';
  await resetDb();
  team = await seedTeam();
  const op = await createUser('op', 'OPERATOR', 'Operator');
  L = api(await token('leader'));
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
  O = api(await token('op'));
  await pool.query(`UPDATE app_user SET phone_ext = '101' WHERE id = $1`, [team.acc1]);
  await pool.query(`UPDATE app_user SET phone_ext = '300' WHERE id = $1`, [op]);
  clientId = (await one(
    pool,
    `INSERT INTO client (stir, name, name_normalized, phone, accountant_id, status)
     VALUES ('300000001', 'ALFA MCHJ', 'alfa mchj', '+998 90 123-45-67, 93 111 22 33', $1, 'ACTIVE') RETURNING id`,
    [team.acc1],
  ))!.id;
  leadId = (await one(
    pool,
    `INSERT INTO lead (stir, name, name_normalized, phone) VALUES ('400000001', 'BETA', 'beta', '+998977778899') RETURNING id`,
  ))!.id;
});

describe('CDR tahlili', () => {
  const known = new Set(['101']);
  it('kanal nomidan ichki raqam', () => {
    expect(channelPeer('PJSIP/101-0000002a')).toBe('101');
    expect(channelPeer('SIP/trunk_uztel-00000001')).toBe('trunk_uztel');
    expect(channelPeer('Local/102@from-internal-00000001;1')).toBe('102');
    expect(channelPeer('')).toBeNull();
  });
  it('chiquvchi, kiruvchi, ichki', () => {
    expect(resolveCall({ src: '101', dst: '998901234567', channel: 'PJSIP/101-1', dstchannel: 'PJSIP/trunk-2' }, known)).toEqual({
      direction: 'OUT', ext: '101', peerExt: null, externalNumber: '901234567',
    });
    // Navbat/IVR: dst = 's', xodim dstchannel'da
    expect(resolveCall({ src: '+998931112233', dst: 's', channel: 'PJSIP/trunk-1', dstchannel: 'PJSIP/101-2' }, known)).toEqual({
      direction: 'IN', ext: '101', peerExt: null, externalNumber: '931112233',
    });
    // Hech kim javob bermagan kiruvchi
    expect(resolveCall({ src: '931112233', dst: 's', channel: 'PJSIP/trunk-1', dstchannel: '' }, known).direction).toBe('IN');
    expect(resolveCall({ src: '101', dst: '102', channel: 'PJSIP/101-1', dstchannel: 'PJSIP/102-2' }, known)).toEqual({
      direction: 'INTERNAL', ext: '101', peerExt: '102', externalNumber: null,
    });
  });
});

describe('qabul qilish (ingest)', () => {
  it('token bo\'lmasa — 401', async () => {
    expect((await ingest([], 'wrong')).status).toBe(401);
    expect((await request(app).post('/api/calls/ingest').send({ records: [] })).status).toBe(401);
  });

  it('yozadi, takrorni o\'tkazib yuboradi', async () => {
    const recs = [
      { key: 'k-out-1-aaaa', fields: cdr({ src: '101', dst: '998901234567', channel: 'PJSIP/101-1', dstchannel: 'PJSIP/trunk-2', uniqueid: '1762750800.11' }) },
      { key: 'k-in-1-aaaaa', fields: cdr({ src: '931112233', dst: 's', channel: 'PJSIP/trunk-1', dstchannel: 'PJSIP/102-2', start: '2026-11-10 11:00:00' }) },
      { key: 'k-miss-1-aaa', fields: cdr({ src: '977778899', dst: 's', channel: 'PJSIP/trunk-1', answer: '', billsec: '0', disposition: 'NO ANSWER', start: '2026-11-10 12:00:00' }) },
      { key: 'k-op-1-aaaaa', fields: cdr({ src: '300', dst: '977778899', channel: 'PJSIP/300-1', dstchannel: 'PJSIP/trunk-2', start: '2026-11-10 12:30:00' }) },
      { key: 'k-bad-1-aaaa', fields: cdr({ start: 'xx' }) },
    ];
    const r = await ingest(recs);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ inserted: 4, skipped: 1 });
    expect((await ingest(recs.slice(0, 1))).body).toEqual({ inserted: 0, skipped: 1 });
    const row = await one(pool, `SELECT user_id, started_at FROM call_log WHERE source_key = 'k-out-1-aaaa'`);
    expect(row.user_id).toBe(team.acc1);
    // CDR vaqti Asia/Tashkent: 10:00 = 05:00 UTC
    expect(new Date(row.started_at).toISOString()).toBe('2026-11-10T05:00:00.000Z');
  });

  it('ichki raqam keyin biriktirilsa — eski qo\'ng\'iroq xodimga o\'tadi', async () => {
    expect((await L.get('/api/calls/status')).body.unassignedExts).toEqual([expect.objectContaining({ ext: '102', calls: 1 })]);
    const r = await L.patch(`/api/users/${team.acc2}`, { phoneExt: '102' });
    expect(r.status).toBe(200);
    expect(r.body.phoneExt).toBe('102');
    expect((await one(pool, `SELECT user_id FROM call_log WHERE source_key = 'k-in-1-aaaaa'`)).user_id).toBe(team.acc2);
    expect((await L.patch(`/api/users/${team.leader}`, { phoneExt: '102' })).body.code).toBe('PHONE_EXT_TAKEN');
  });
});

describe('o\'qish va ruxsatlar', () => {
  it('mijoz kartasi: telefondagi ikkala raqam bo\'yicha', async () => {
    const r = await A1.get(`/api/calls/client/${clientId}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.items.map((c: any) => c.direction).sort()).toEqual(['IN', 'OUT']);
    expect((await A2.get(`/api/calls/client/${clientId}`)).status).toBe(404);
    expect((await O.get(`/api/calls/client/${clientId}`)).status).toBe(403);
  });

  it('lead: rahbar va operator', async () => {
    const r = await O.get(`/api/calls/lead/${leadId}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect((await A1.get(`/api/calls/lead/${leadId}`)).status).toBe(403);
  });

  it('jurnal: xodim faqat o\'zinikini, mos mijoz faqat ruxsat bo\'lsa', async () => {
    const all = await L.get('/api/calls?from=2026-11-01&to=2026-11-30');
    expect(all.body.total).toBe(4);
    const out = all.body.items.find((c: any) => c.direction === 'OUT' && c.userId === team.acc1);
    expect(out.client).toEqual({ id: clientId, name: 'ALFA MCHJ' });

    const a2 = await A2.get('/api/calls?from=2026-11-01&to=2026-11-30');
    expect(a2.body.total).toBe(1);
    expect(a2.body.items[0].client).toBeNull(); // acc1 mijozi
    const op = await O.get('/api/calls?from=2026-11-01&to=2026-11-30');
    expect(op.body.total).toBe(1);
    expect(op.body.items[0].lead).toEqual({ id: leadId, name: 'BETA' });

    expect((await L.get('/api/calls?from=2026-11-01&to=2026-11-30&missed=true')).body.total).toBe(1);
  });

  it('statistika faqat rahbarga', async () => {
    expect((await A1.get('/api/calls/stats')).status).toBe(403);
    const r = await L.get('/api/calls/stats?from=2026-11-01&to=2026-11-30');
    const acc1 = r.body.rows.find((x: any) => x.userId === team.acc1);
    expect(acc1).toMatchObject({ total: 1, outgoing: 1, outgoingAnswered: 1, talkSec: 120 });
    const none = r.body.rows.find((x: any) => x.userId === null);
    expect(none).toMatchObject({ incoming: 1, missed: 1 });
  });
});

describe('audio yozuvlar (V48)', () => {
  const upload = (path: string, body: Buffer, mime = 'audio/ogg', tok = TOKEN) =>
    request(app)
      .post('/api/calls/recordings')
      .set('Authorization', `Bearer ${tok}`)
      .set('Content-Type', mime)
      .set('X-Source-Path', encodeURIComponent(path))
      .send(body);
  const PATH = '2026/11/10/out-998901234567-101-20261110-100000-1762750800.11.ogg';

  it('fayl nomidan UNIQUEID', () => {
    expect(uniqueidFromName('out-998901234567-101-20261110-100000-1762750800.11.wav')).toBe('1762750800.11');
    expect(uniqueidFromName('1762750800.5.wav')).toBe('1762750800.5');
    expect(uniqueidFromName('yozuv.wav')).toBeNull();
  });

  it('qabul qiladi, kanalga yuklaydi, takrorni yozmaydi', async () => {
    expect((await upload(PATH, Buffer.from('x'), 'audio/ogg', 'wrong')).status).toBe(401);
    expect((await upload(PATH, Buffer.from('x'), 'text/html')).status).toBe(400);
    const r = await upload(PATH, Buffer.from('OggS-audio'));
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    expect((await upload(PATH, Buffer.from('OggS-audio'))).body.duplicate).toBe(true);
    const row = await one(pool, 'SELECT uniqueid, tg_chat_id, size_bytes FROM call_recording');
    expect(row).toMatchObject({ uniqueid: '1762750800.11', tg_chat_id: '-100777', size_bytes: 10 });
  });

  it('faqat rahbar ko\'radi va eshitadi', async () => {
    const all = await L.get('/api/calls?from=2026-11-01&to=2026-11-30');
    const out = all.body.items.find((c: any) => c.direction === 'OUT' && c.userId === team.acc1);
    expect(out.recordingId).toBeTruthy();
    const play = await L.get(`/api/calls/recordings/${out.recordingId}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(play.status).toBe(200);
    expect(play.headers['content-type']).toBe('audio/ogg');
    expect((play.body as Buffer).toString()).toBe('OggS-audio');

    const mine = await A1.get('/api/calls?from=2026-11-01&to=2026-11-30');
    expect(mine.body.items[0]).not.toHaveProperty('recordingId');
    const card = await A1.get(`/api/calls/client/${clientId}`);
    expect(card.body.items.every((c: any) => !('recordingId' in c))).toBe(true);
    expect((await A1.get(`/api/calls/recordings/${out.recordingId}`)).status).toBe(403);
    expect((await O.get(`/api/calls/recordings/${out.recordingId}`)).status).toBe(403);
  });
});
