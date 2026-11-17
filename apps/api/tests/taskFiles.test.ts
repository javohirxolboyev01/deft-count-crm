import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { api, app, one, pool, resetDb, seedTeam, token } from './helpers';

// Telegram ombori o'rniga xotira: testlar tashqi tarmoqqa chiqmaydi
const tg = vi.hoisted(() => ({ files: new Map<string, Buffer>(), captions: [] as string[] }));
vi.mock('../src/modules/telegramStorage', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    storageEnabled: () => true,
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
const MP3 = Buffer.from('494433030000000000', 'hex');

let team: Awaited<ReturnType<typeof seedTeam>>;
let clientId: number;
let tL: string;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let A2: ReturnType<typeof api>;

const upload = (tok: string, fields: Record<string, string>, file: { buf: Buffer; name: string; type: string }) => {
  let r = request(app).post('/api/tasks/attachments').set('Authorization', `Bearer ${tok}`);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', file.buf, { filename: file.name, contentType: file.type });
};

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  const c = await one(pool, `INSERT INTO client (stir, name, name_normalized, accountant_id) VALUES ('123456789', 'Fayl MCHJ', 'fayl mchj', $1) RETURNING id`, [team.acc1]);
  clientId = c.id;
  tL = await token('leader');
  L = api(tL);
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
});

describe('yangi vazifa fayllari (V54, Telegram ombori)', () => {
  it('rahbar yuklaydi, vazifaga bog\'lanadi, mas\'ul ko\'radi, begona ko\'rmaydi', async () => {
    const img = await upload(tL, { kind: 'IMAGE', width: '800', height: '600' }, { buf: PNG, name: 'chek.png', type: 'image/png' });
    expect(img.status).toBe(201);
    expect(img.body).toMatchObject({ kind: 'IMAGE', mime: 'image/png', fileName: 'chek.png', sizeBytes: PNG.length, width: 800 });
    const voice = await upload(tL, { kind: 'VOICE', durationSec: '5', waveform: '1,20,31' }, { buf: MP3, name: 'izoh.mp3', type: 'audio/mpeg' });
    expect(voice.body).toMatchObject({ kind: 'VOICE', mime: 'audio/mpeg', durationSec: 5, waveform: [1, 20, 31] });
    const doc = await upload(tL, { kind: 'FILE' }, { buf: Buffer.from('<b>x</b>'), name: 'Akt.html', type: 'text/html' });
    expect(doc.status).toBe(201);
    // Kanalga vazifa matni emas, faqat texnik belgi
    expect(tg.captions.at(-1)).toBe(`crm-task FILE u${team.leader}`);

    // Bog'lanmagan fayl faqat yuklagan rahbarga
    expect((await L.get(`/api/tasks/files/${img.body.id}`)).status).toBe(200);
    expect((await A1.get(`/api/tasks/files/${img.body.id}`)).status).toBe(404);

    const ids = [img.body.id, voice.body.id, doc.body.id];
    const t = await L.post('/api/tasks/urgent', { clientId, text: 'Chekni tekshiring', assigneeId: team.acc1, attachmentIds: ids });
    expect(t.status).toBe(201);
    const detail = (await A1.get(`/api/tasks/${t.body.id}`)).body;
    expect(detail.attachments.map((a: any) => a.id)).toEqual(ids);

    const f = await A1.get(`/api/tasks/files/${img.body.id}`);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('image/png');
    const d = await A1.get(`/api/tasks/files/${doc.body.id}`);
    expect(d.headers['content-type']).toBe('application/octet-stream');
    expect(d.headers['content-disposition']).toContain('attachment');
    expect((await A2.get(`/api/tasks/files/${img.body.id}`)).status).toBe(404);

    // Bildirishnomada fayllar soni
    const n = await one(pool, `SELECT payload FROM notification WHERE kind = 'URGENT_TASK' ORDER BY id DESC LIMIT 1`);
    expect(n.payload.files).toBe(3);

    // Bir fayl ikki vazifaga bog'lanmaydi
    const again = await L.post('/api/tasks/urgent', { clientId, text: 'Yana', assigneeId: team.acc1, attachmentIds: [img.body.id] });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('buxgalter yuklay olmaydi, noto\'g\'ri tur rad etiladi', async () => {
    const tA1 = await token('acc1');
    expect((await upload(tA1, { kind: 'IMAGE' }, { buf: PNG, name: 'a.png', type: 'image/png' })).status).toBe(403);
    expect((await upload(tL, { kind: 'IMAGE' }, { buf: Buffer.from('<svg/>'), name: 'a.svg', type: 'image/svg+xml' })).status).toBe(415);
    expect((await upload(tL, { kind: 'VOICE' }, { buf: PNG, name: 'a.png', type: 'image/png' })).status).toBe(415);
  });

  it('faylsiz vazifa avvalgidek ishlaydi', async () => {
    const t = await L.post('/api/tasks/urgent', { clientId, text: 'Oddiy', assigneeId: team.acc1 });
    expect(t.status).toBe(201);
    expect((await L.get(`/api/tasks/${t.body.id}`)).body.attachments).toEqual([]);
  });
});
