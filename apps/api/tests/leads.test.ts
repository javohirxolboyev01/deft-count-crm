import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { TZ } from '../src/common/time';
import { normalizePhone } from '../src/modules/leads';
import { api, app, createUser, one, pool, q, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let O: ReturnType<typeof api>;
let opToken: string;
let leaderToken: string;

const tomorrow = () => DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate()!;

/** "Baza operator uchun.xlsx" ko'rinishidagi fayl (ruscha sarlavhalar, 3 ta telefon ustuni) */
async function leadsXlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('21-10-2026');
  ws.addRow(['N', 'ИНН', 'Название', 'Дата регистрации', 'Директор', 'Рабочий телефон', 'Домашний телефон', 'Телефон', 'Адрес']);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const upload = (tok: string, buf: Buffer, dryRun: boolean) =>
  request(app).post(`/api/leads/import?dryRun=${dryRun}`).set('Authorization', `Bearer ${tok}`).attach('file', buf, 'Baza operator uchun.xlsx');

const leadId = async (stir: string) => (await one<{ id: number }>(pool, 'SELECT id FROM lead WHERE stir = $1', [stir]))!.id;

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  await createUser('op', 'OPERATOR', 'Operator');
  leaderToken = await token('leader');
  opToken = await token('op');
  L = api(leaderToken);
  A1 = api(await token('acc1'));
  O = api(opToken);
  // Allaqachon mijozimiz bo'lgan firma: importda o'tkazib yuborilishi kerak
  await L.post('/api/clients', { stir: '300000001', name: 'ESKI MIJOZ', taxType: 'AOS', accountantId: team.acc1, inWorks: true });
});

describe('operator ruxsatlari (serverda)', () => {
  it('operator buxgalteriya bo\'limlariga kira olmaydi, buxgalter lead\'larga kira olmaydi', async () => {
    for (const url of ['/api/clients', '/api/tasks', '/api/monthly-grid', '/api/users/accountants', '/api/dashboard/clients', '/api/settings/report-types']) {
      expect((await O.get(url)).status, url).toBe(403);
    }
    expect((await O.get('/api/leads')).status).toBe(200);
    expect((await O.get('/api/notifications/unread-count')).status).toBe(200);
    expect((await A1.get('/api/leads')).status).toBe(403);
  });

  it('/api/me: operatorga bildirishnoma turlari yo\'q, rahbarda LEAD_WON bor', async () => {
    expect((await O.get('/api/me')).body.notificationKinds).toEqual([]);
    expect((await L.get('/api/me')).body.notificationKinds).toContain('LEAD_WON');
  });

  it('rahbar operator xodim yaratadi', async () => {
    const r = await L.post('/api/users', { fullName: 'Operator 2', login: 'op2', password: '123456', role: 'OPERATOR' });
    expect(r.status).toBe(201);
    expect(r.body.role).toBe('OPERATOR');
  });
});

describe('Excel import', () => {
  let file: Buffer;
  beforeAll(async () => {
    file = await leadsXlsx([
      ['1', '313389236', '"SULTAN CERAMIC" MCHJ', '07.10.2026', 'ZUBENKO ALEKSANDR', null, null, null, 'Oq uy MFY'],
      ['2', '313389308', '"BAKER TILLY" MCHJ', '07.10.2026', 'SHAROPOV AKMAL', null, null, '998901855999', 'Chimkent ko\'chasi'],
      ['3', '313389710', '"STARS STATION" MCHJ', '08.10.2026', 'YUNUSOV OBIDJON', '998452711', null, '998452711', null],
      ['4', '300000001', 'ESKI MIJOZ', '01.01.2020', null, null, null, null, null],
      ['5', '313389236', '"SULTAN CERAMIC" MCHJ', '07.10.2026', null, null, null, null, null],
      ['6', '12345', 'XATO STIR', null, null, null, null, null, null],
    ]);
  });

  it('faqat rahbar yuklaydi', async () => {
    expect((await upload(opToken, file, true)).status).toBe(403);
  });

  it('dry-run bazaga yozmaydi va natijani ko\'rsatadi', async () => {
    const r = await upload(leaderToken, file, true);
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ created: 3, existingClient: 1, duplicateRow: 1, invalid: 1, withoutPhone: 1 });
    expect((await one(pool, 'SELECT count(*)::int AS n FROM lead')).n).toBe(0);
  });

  it('haqiqiy import: telefonlar normallashadi, sana o\'qiladi; qayta yuklash yangi qo\'shmaydi', async () => {
    const r = await upload(leaderToken, file, false);
    expect(r.body.summary.created).toBe(3);
    const stars = await one(pool, `SELECT phone, registered_at FROM lead WHERE stir = '313389710'`);
    expect(stars.phone).toBe('+998998452711'); // ikki ustunda bir xil raqam — bitta
    expect(stars.registered_at).toBe('2026-10-08');
    const again = await upload(leaderToken, file, false);
    expect(again.body.summary).toMatchObject({ created: 0, existingLead: 3 });
  });
});

describe('qo\'ng\'iroqlar', () => {
  it('yangi firmalar "bugun" ro\'yxatida', async () => {
    const r = await O.get('/api/leads?view=today');
    expect(r.body.total).toBe(3);
  });

  it('javob bermadi (kunsiz) — bugun ro\'yxatida qoladi, izoh ko\'rinadi', async () => {
    const id = await leadId('313389236');
    const r = await O.post(`/api/leads/${id}/calls`, { result: 'NO_ANSWER', comment: 'Telefon o\'chiq' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'NO_ANSWER', callCount: 1, lastComment: 'Telefon o\'chiq' });
    expect((await O.get('/api/leads?view=today')).body.items.map((l: any) => l.id)).toContain(id);
  });

  it('keyinroq qiling: kun majburiy; ertaga bo\'lsa bugungi ro\'yxatdan chiqadi', async () => {
    const id = await leadId('313389236');
    expect((await O.post(`/api/leads/${id}/calls`, { result: 'CALL_LATER' })).body.code).toBe('NEXT_CALL_REQUIRED');
    expect((await O.post(`/api/leads/${id}/calls`, { result: 'CALL_LATER', nextCallDate: '2020-01-01' })).body.code).toBe('NEXT_CALL_PAST');
    const r = await O.post(`/api/leads/${id}/calls`, { result: 'CALL_LATER', comment: 'Dushanba qiling', nextCallDate: tomorrow() });
    expect(r.body.nextCallDate).toBe(tomorrow());
    expect((await O.get('/api/leads?view=today')).body.items.map((l: any) => l.id)).not.toContain(id);
    expect((await O.get('/api/leads?view=open')).body.items.map((l: any) => l.id)).toContain(id);
    const card = await O.get(`/api/leads/${id}`);
    expect(card.body.calls).toHaveLength(2);
    expect(card.body.calls[0]).toMatchObject({ result: 'CALL_LATER', userName: 'Operator' });
  });

  it('buxgalteri bor — yopiladi (keyingi kun saqlanmaydi)', async () => {
    const id = await leadId('313389308');
    const r = await O.post(`/api/leads/${id}/calls`, { result: 'HAS_ACCOUNTANT', nextCallDate: tomorrow() });
    expect(r.body).toMatchObject({ status: 'HAS_ACCOUNTANT', nextCallDate: null });
    expect((await O.get('/api/leads?view=closed')).body.items.map((l: any) => l.id)).toContain(id);
  });

  it('operator telefon kiritadi', async () => {
    const id = await leadId('313389236');
    const r = await O.patch(`/api/leads/${id}`, { phone: '+998901112233' });
    expect(r.body.phone).toBe('+998901112233');
    expect((await O.get('/api/leads?view=all&search=1112233')).body.items.map((l: any) => l.id)).toEqual([id]);
  });
});

describe('mijoz bo\'ldi -> rahbar', () => {
  let id: number;
  beforeAll(async () => {
    id = await leadId('313389710');
  });

  it('WON: rahbarga bildirishnoma, operatordan yopiladi', async () => {
    const r = await O.post(`/api/leads/${id}/calls`, { result: 'WON', comment: 'Shartnomaga rozi' });
    expect(r.body.status).toBe('WON');
    const n = await q(pool, `SELECT user_id, payload FROM notification WHERE kind = 'LEAD_WON' AND channel = 'APP'`);
    expect(n.map((x) => x.user_id)).toEqual([team.leader]);
    expect(n[0].payload).toMatchObject({ leadId: id, actorName: 'Operator', comment: 'Shartnomaga rozi' });
    expect((await O.get(`/api/leads/${id}`)).status).toBe(404);
    expect((await O.post(`/api/leads/${id}/calls`, { result: 'NO_ANSWER' })).status).toBe(404);
    expect((await O.get('/api/leads?view=all')).body.items.map((l: any) => l.id)).not.toContain(id);
    expect((await O.get('/api/leads?view=won')).status).toBe(403);
    expect((await L.get('/api/leads?view=won')).body.items.map((l: any) => l.id)).toEqual([id]);
  });

  it('rahbar mijozga aylantiradi: buxgalter biriktiriladi, vazifalar chiqadi; ikkinchi marta 409', async () => {
    expect((await O.post(`/api/leads/${id}/convert`, { stir: '313389710', name: 'X', taxType: 'AOS' })).status).toBe(403);
    const r = await L.post(`/api/leads/${id}/convert`, { stir: '313389710', name: '"STARS STATION" MCHJ', taxType: 'QQS', accountantId: team.acc2, phone: '+998998452711' });
    expect(r.status).toBe(201);
    const c = await one(pool, 'SELECT accountant_id, tax_type FROM client WHERE id = $1', [r.body.clientId]);
    expect(c).toMatchObject({ accountant_id: team.acc2, tax_type: 'QQS' });
    expect((await one(pool, 'SELECT count(*)::int AS n FROM task WHERE client_id = $1', [r.body.clientId])).n).toBeGreaterThan(0);
    expect((await one(pool, 'SELECT status, converted_client_id FROM lead WHERE id = $1', [id]))).toEqual({ status: 'CONVERTED', converted_client_id: r.body.clientId });
    expect((await L.post(`/api/leads/${id}/convert`, { stir: '313389710', name: 'X', taxType: 'AOS' })).body.code).toBe('LEAD_CONVERTED');
  });

  it('statistika: qo\'ng\'iroqlar soni va natijalar', async () => {
    const s = (await L.get('/api/leads/stats')).body;
    expect(s.calls.day).toBe(4); // kunsiz/o'tgan kunli urinishlar yozilmagan
    expect(s.calls.dayFirms).toBe(3);
    expect(s.byResult).toMatchObject({ NO_ANSWER: 1, CALL_LATER: 1, HAS_ACCOUNTANT: 1, WON: 1 });
    expect(s.byStatus).toMatchObject({ CALL_LATER: 1, HAS_ACCOUNTANT: 1, CONVERTED: 1 });
  });
});

describe('nomzodni qo\'lda qo\'shish', () => {
  it('operator STIRsiz qo\'shadi: «bugun» ro\'yxatida ko\'rinadi, takror raqam/STIR 409', async () => {
    const r = await O.post('/api/leads', { name: '"YANGI FIRMA" MCHJ', director: 'Aliyev Vali', phone: '90 777 66 55' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: '"YANGI FIRMA" MCHJ', director: 'Aliyev Vali', phone: '+998907776655', stir: null, status: 'NEW', source: 'MANUAL' });
    expect((await O.get('/api/leads?view=today&pageSize=200')).body.items.map((l: any) => l.id)).toContain(r.body.id);
    expect((await L.get('/api/leads?search=yangi firma')).body.items.map((l: any) => l.id)).toEqual([r.body.id]);
    // Shu raqam (boshqa yozilishda) — takror
    expect((await O.post('/api/leads', { name: 'BOSHQA', phone: '+998 (90) 777-66-55' })).body.code).toBe('EXISTING_LEAD');
    // STIR bilan: mijozimiz bo'lsa — rad etiladi
    expect((await O.post('/api/leads', { name: 'ESKI', phone: '901112299', stir: '300000001' })).body.code).toBe('EXISTING_CLIENT');
    expect((await O.post('/api/leads', { name: 'X', phone: '12345' })).body.code).toBe('BAD_PHONE');
    expect((await O.post('/api/leads', { name: '', phone: '901112299' })).status).toBe(400);
    expect((await A1.post('/api/leads', { name: 'X', phone: '901112299' })).status).toBe(403);
  });
});

describe('normalizePhone', () => {
  it('998..., 9 xonali va bo\'sh', () => {
    expect(normalizePhone('998901855999')).toBe('+998901855999');
    expect(normalizePhone('931677700')).toBe('+998931677700');
    expect(normalizePhone('+998 (90) 185-59-99')).toBe('+998901855999');
    expect(normalizePhone('')).toBeNull();
  });
});
