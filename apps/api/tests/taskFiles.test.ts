import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app, one, pool, resetDb, seedTeam, token, api } from './helpers';
import { dispatchDue } from '../src/modules/notifications';

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

type F = { buf: Buffer; name: string; type: string; meta: Record<string, unknown> };
const createUrgent = (tok: string, fields: Record<string, string | number>, files: F[]) => {
  let r = request(app).post('/api/tasks/urgent').set('Authorization', `Bearer ${tok}`);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
  r = r.field('filesMeta', JSON.stringify(files.map((f) => f.meta)));
  for (const f of files) r = r.attach('files', f.buf, { filename: f.name, contentType: f.type });
  return r;
};

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  const c = await one(pool, `INSERT INTO client (stir, name, name_normalized, accountant_id) VALUES ('123456789', 'Fayl MCHJ', 'fayl mchj', $1) RETURNING id`, [team.acc1]);
  clientId = c.id;
  await pool.query('UPDATE app_user SET telegram_chat_id = 777 WHERE id = $1', [team.acc1]);
  tL = await token('leader');
  L = api(tL);
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
});

describe('yangi vazifa fayllari (V54/V55, Telegram ombori)', () => {
  it('fayllar faqat yuborishda yuklanadi, vazifaga tegishli, mas\'ul ko\'radi, begona ko\'rmaydi', async () => {
    expect(tg.files.size).toBe(0);
    const r = await createUrgent(tL, { clientId, text: 'Chekni tekshiring', assigneeId: team.acc1 }, [
      { buf: PNG, name: 'chek.png', type: 'image/png', meta: { kind: 'IMAGE', width: 800, height: 600 } },
      { buf: MP3, name: 'izoh.mp3', type: 'audio/mpeg', meta: { kind: 'VOICE', durationSec: 5, waveform: [1, 20, 31] } },
      { buf: Buffer.from('<b>x</b>'), name: 'Akt.html', type: 'text/html', meta: { kind: 'FILE' } },
    ]);
    expect(r.status).toBe(201);
    expect(tg.files.size).toBe(3);
    // Kanalga vazifa matni emas, faqat texnik belgi
    expect(tg.captions.at(-1)).toBe(`crm-task FILE u${team.leader}`);

    const detail = (await A1.get(`/api/tasks/${r.body.id}`)).body;
    expect(detail.title).toBe('Chekni tekshiring');
    expect(detail.attachments).toMatchObject([
      { kind: 'IMAGE', mime: 'image/png', fileName: 'chek.png', width: 800 },
      { kind: 'VOICE', mime: 'audio/mpeg', durationSec: 5, waveform: [1, 20, 31] },
      { kind: 'FILE', fileName: 'Akt.html' },
    ]);
    const [img, , doc] = detail.attachments;
    const f = await A1.get(`/api/tasks/files/${img.id}`);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('image/png');
    const d = await A1.get(`/api/tasks/files/${doc.id}`);
    expect(d.headers['content-type']).toBe('application/octet-stream');
    expect(d.headers['content-disposition']).toContain('attachment');
    expect((await A2.get(`/api/tasks/files/${img.id}`)).status).toBe(404);

    // Bot: avval vazifa xabari (fayllar soni bilan), keyin fayllarning o'zi
    const texts: string[] = [];
    const sent: [number | string, number][] = [];
    await dispatchDue(async (_c, text) => void texts.push(text), async (chatId, taskId) => void sent.push([chatId, taskId]));
    expect(texts.some((t) => t.includes('📎'))).toBe(true);
    expect(sent).toEqual([[777, r.body.id]]);
  });

  it('xato bo\'lsa hech narsa yuklanmaydi; noto\'g\'ri tur rad etiladi; buxgalter yarata olmaydi', async () => {
    const before = tg.files.size;
    // Mijoz topilmasa — fayl kanalga ketmaydi
    const bad = await createUrgent(tL, { clientId: 999999, text: 'x', assigneeId: team.acc1 }, [
      { buf: PNG, name: 'a.png', type: 'image/png', meta: { kind: 'IMAGE' } },
    ]);
    expect(bad.status).toBe(404);
    const svg = await createUrgent(tL, { clientId, text: 'x', assigneeId: team.acc1 }, [
      { buf: Buffer.from('<svg/>'), name: 'a.svg', type: 'image/svg+xml', meta: { kind: 'IMAGE' } },
    ]);
    expect(svg.status).toBe(415);
    // Ikkinchi fayl noto'g'ri — birinchisi ham yuklanmaydi
    const mixed = await createUrgent(tL, { clientId, text: 'x', assigneeId: team.acc1 }, [
      { buf: PNG, name: 'a.png', type: 'image/png', meta: { kind: 'IMAGE' } },
      { buf: PNG, name: 'b.png', type: 'image/png', meta: { kind: 'VOICE' } },
    ]);
    expect(mixed.status).toBe(415);
    expect(tg.files.size).toBe(before);

    const tA1 = await token('acc1');
    expect((await createUrgent(tA1, { clientId, text: 'x', assigneeId: team.acc1 }, [])).status).toBe(403);
  });

  it('faylsiz vazifa (JSON) avvalgidek ishlaydi', async () => {
    const t = await L.post('/api/tasks/urgent', { clientId, text: 'Oddiy', assigneeId: team.acc1 });
    expect(t.status).toBe(201);
    expect((await L.get(`/api/tasks/${t.body.id}`)).body.attachments).toEqual([]);
  });
});
