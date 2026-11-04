import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { currentPeriod } from '../src/common/time';
import { tx } from '../src/db';
import { createClient } from '../src/modules/clients';
import { generatePeriod } from '../src/modules/generator';
import { api, one, pool, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let A2: ReturnType<typeof api>;
let aos: number;
let zero: number;
const ids: Record<string, number> = {};

const P = currentPeriod();
const month = (n: number) => DateTime.fromISO(P).plus({ months: n }).toFormat('yyyy-MM');
// O'tgan oy ishining muddati joriy oyning 5–20-sanasida (V34): test sanaga bog'liq bo'lmasin — muddat o'tgan deb olinadi
const pastDue = () => pool.query(`UPDATE task SET due_at = now() - interval '1 hour' WHERE kind = 'ROUTINE' AND period = $1`, [`${month(-1)}-01`]);
const cell = async (who: ReturnType<typeof api>, clientId: number, work: string) => {
  const r = await who.get('/api/works?pageSize=100');
  return r.body.items.find((i: any) => i.clientId === clientId).cells[ids[work]];
};

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  L = api(await token('leader'));
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
  aos = await tx((db) => createClient(db, { stir: '305123456', name: 'SHERPROM STROY', taxType: 'AOS', status: 'ACTIVE', accountantId: team.acc1 }, team.leader));
  await tx((db) => createClient(db, { stir: '306234567', name: 'INSAR MIX TRADE', taxType: 'QQS', status: 'ACTIVE', accountantId: team.acc2 }, team.leader));
  zero = await tx((db) => createClient(db, { stir: '307345678', name: 'NOL MCHJ', taxType: 'AOS', status: 'ZERO_REPORT', accountantId: team.acc1 }, team.leader));
  // O'tgan oy vazifalari ham bor (muddati o'tgan), joriy oy createClient'da yaratilgan
  await tx((db) => generatePeriod(db, `${month(-1)}-01`));
  await pastDue();
  for (const [k, name] of [['inps', 'INPS hisoboti'], ['salary', 'Ish haqi hisoblash'], ['bank', 'Bank aylanmalarini kiritish']]) {
    ids[k] = (await one(pool, 'SELECT id FROM routine_work_type WHERE name = $1', [name])).id;
  }
});

describe('oylik ishlar (/api/works)', () => {
  it('ustunlar faol ishlar tartibida; buxgalter faqat o\'z mijozlarini ko\'radi', async () => {
    const r = await L.get('/api/works');
    expect(r.status).toBe(200);
    expect(r.body.columns).toHaveLength(8);
    expect(r.body.columns[0].routineTypeId).toBe(ids.inps);
    expect(r.body.month).toBe(month(0));
    expect(r.body.total).toBe(3);
    const a = await A1.get('/api/works');
    expect(a.body.items.map((i: any) => i.clientId).sort()).toEqual([aos, zero].sort());
  });

  it('o\'tgan oy ochiq: orqada 1 oy, qizil; INPS ustuni hisobot vazifasidan (ish oyi = davr, V36)', async () => {
    const salary = await cell(A1, aos, 'salary');
    expect(salary).toMatchObject({ na: false, doneThrough: null, lag: 1, tone: 'overdue' });
    expect(salary.next).toMatchObject({ kind: 'TASK', month: month(-1) });
    const inps = await cell(A1, aos, 'inps');
    const t = await one(pool, `SELECT kind, to_char(period, 'YYYY-MM') AS period FROM task WHERE id = $1`, [inps.next.taskId]);
    expect(t).toEqual({ kind: 'REPORT', period: month(-1) });
    expect(inps.next.month).toBe(month(-1));
  });

  it('nol hisobot mijozda doimiy ishlar chiqmaydi (—), INPS hisoboti esa bor', async () => {
    expect((await cell(A1, zero, 'salary')).na).toBe(true);
    expect((await cell(A1, zero, 'inps')).na).toBe(false);
  });

  it('katakni bosish o\'tgan oy vazifasini "Bajarildi" qiladi', async () => {
    const r = await A1.post(`/api/works/${aos}/${ids.salary}/advance`);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('TASK');
    expect(r.body.task.status).toBe('DONE');
    const c = await cell(A1, aos, 'salary');
    expect(c).toMatchObject({ doneThrough: month(-1), lag: 0 });
    expect(c.next).toMatchObject({ kind: 'TASK', month: month(0) });
    const log = await one(pool, `SELECT after->>'source' AS source FROM audit_log WHERE entity = 'task' AND entity_id = $1 AND action = 'DONE'`, [String(r.body.task.id)]);
    expect(log.source).toBe('WORKS');
  });

  it('tizimgacha nuqta: faqat rahbar, faqat tizimdan oldingi o\'tgan oy', async () => {
    const url = `/api/works/${aos}/${ids.bank}/baseline`;
    expect((await A1.put(url, { month: month(-4) })).status).toBe(403);
    const inSystem = await L.put(url, { month: month(-1) });
    expect(inSystem.status).toBe(409);
    expect(inSystem.body.code).toBe('BASELINE_IN_SYSTEM');
    expect((await L.put(url, { month: month(0) })).body.code).toBe('BASELINE_FUTURE');
    const ok = await L.put(url, { month: month(-4) });
    expect(ok.status).toBe(200);
    // -3, -2 tizimgacha (bo'shliq) + -1 vazifasi muddati o'tgan = 3 oy
    expect(ok.body).toMatchObject({ doneThrough: month(-4), baseline: month(-4), lag: 3, tone: 'overdue' });
    expect(ok.body.next).toEqual({ kind: 'BASELINE', month: month(-3) });
  });

  it('tizimgacha oyni buxgalter yopadi, 5 soniya ichida bekor qiladi', async () => {
    const adv = await A1.post(`/api/works/${aos}/${ids.bank}/advance`);
    expect(adv.body).toMatchObject({ kind: 'BASELINE', month: month(-3), clientName: 'SHERPROM STROY' });
    expect((await A2.post(`/api/works/${aos}/${ids.bank}/undo-advance`)).status).toBe(404); // boshqaning mijozi "yo'q"
    expect((await A1.post(`/api/works/${aos}/${ids.bank}/undo-advance`)).status).toBe(200);
    expect((await cell(A1, aos, 'bank')).doneThrough).toBe(month(-4));
    expect((await A1.post(`/api/works/${aos}/${ids.bank}/undo-advance`)).body.code).toBe('NOT_UNDOABLE');
    await A1.post(`/api/works/${aos}/${ids.bank}/advance`);
    // set_updated_at trigger updated_at'ni qayta now() qilmasin
    await pool.query(`ALTER TABLE client_routine_baseline DISABLE TRIGGER trg_client_routine_baseline_updated;
      UPDATE client_routine_baseline SET updated_at = now() - interval '1 minute';
      ALTER TABLE client_routine_baseline ENABLE TRIGGER trg_client_routine_baseline_updated;`);
    expect((await A1.post(`/api/works/${aos}/${ids.bank}/undo-advance`)).body.code).toBe('UNDO_EXPIRED');
  });

  it('bo\'shliq yopilgach keyingi bosish tizimdagi vazifaga o\'tadi', async () => {
    const adv = await A1.post(`/api/works/${aos}/${ids.bank}/advance`); // -2
    expect(adv.body.month).toBe(month(-2));
    const c = await cell(A1, aos, 'bank');
    expect(c).toMatchObject({ doneThrough: month(-2), lag: 1 });
    expect(c.next).toMatchObject({ kind: 'TASK', month: month(-1) });
    const audits = await one(pool, `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'client_routine_baseline'`);
    expect(audits.n).toBeGreaterThanOrEqual(5);
  });

  it('boshqa buxgalter mijozining katagiga tegolmaydi', async () => {
    expect((await A2.post(`/api/works/${aos}/${ids.salary}/advance`)).status).toBe(404);
  });

  it('/api/clients avvalgidek ishlaydi (umumiy filtr)', async () => {
    const r = await A1.get('/api/clients?search=sherprom');
    expect(r.body.items.map((c: any) => c.id)).toEqual([aos]);
    expect(r.body.items[0].openTasks).toBeGreaterThan(0);
  });
});

describe('fayl ustunlari: to\'lov, bank-kalit, my.mehnat.uz', () => {
  it('oylik to\'lovni faqat rahbar ko\'radi va o\'zgartiradi; buxgalter faqat 30% ulushini', async () => {
    expect((await A1.patch(`/api/clients/${aos}`, { monthlyFee: 1000000 })).status).toBe(403);
    expect((await L.patch(`/api/clients/${aos}`, { monthlyFee: 1000000 })).status).toBe(200);
    const lead = (await L.get('/api/works?pageSize=100')).body;
    expect(lead.sharePercent).toBe(30);
    expect(lead.items.find((i: any) => i.clientId === aos)).toMatchObject({ monthlyFee: 1000000, accountantShare: 300000 });
    const acc = (await A1.get('/api/works?pageSize=100')).body.items.find((i: any) => i.clientId === aos);
    expect(acc.accountantShare).toBe(300000);
    expect(acc).not.toHaveProperty('monthlyFee');
    expect((await A1.get(`/api/clients/${aos}`)).body).not.toHaveProperty('monthlyFee');
    const hist = (await A1.get(`/api/clients/${aos}/history`)).body;
    expect(JSON.stringify(hist)).not.toContain('1000000');
    // Foiz sozlamadan
    await L.put('/api/settings/general', { accountantSharePercent: 25 });
    expect((await A1.get(`/api/clients/${aos}`)).body.accountantShare).toBe(250000);
    await L.put('/api/settings/general', { accountantSharePercent: 30 });
  });

  it('buxgalter bank-kalit va my.mehnat.uz ma\'lumotlarini yozadi', async () => {
    const r = await A1.patch(`/api/clients/${aos}`, { bankKey: true, employeeCount: 3, mehnatCheckedAt: '2026-07-31', mehnatLogin: 'jdevomed' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bankKey: true, employeeCount: 3, mehnatCheckedAt: '2026-07-31', mehnatLogin: 'jdevomed', hasMehnatPassword: false });
  });

  it('parol shifrlangan saqlanadi, audit\'da ochiq yo\'q, ochish audit\'ga yoziladi', async () => {
    const secret = 'fbM86zG2nxEaanQ1';
    expect((await A1.patch(`/api/clients/${aos}`, { mehnatPassword: secret })).body.hasMehnatPassword).toBe(true);
    const row = await one(pool, 'SELECT mehnat_password_enc AS enc FROM client WHERE id = $1', [aos]);
    expect(row.enc).not.toContain(secret);
    const logs = await one(pool, `SELECT count(*)::int AS n FROM audit_log WHERE before::text LIKE $1 OR after::text LIKE $1`, [`%${secret}%`]);
    expect(logs.n).toBe(0);
    expect(JSON.stringify((await A1.get('/api/works')).body)).not.toContain(secret);
    const rev = await A1.post(`/api/clients/${aos}/mehnat-password/reveal`);
    expect(rev.body.password).toBe(secret);
    expect((await A2.post(`/api/clients/${aos}/mehnat-password/reveal`)).status).toBe(404);
    const reveals = await one(pool, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'REVEAL_MEHNAT_PASSWORD' AND client_id = $1`, [aos]);
    expect(reveals.n).toBe(1);
    // Bo'sh satr = o'chirish
    expect((await A1.patch(`/api/clients/${aos}`, { mehnatPassword: '' })).body.hasMehnatPassword).toBe(false);
  });
});

describe("tanlangan oy ko'rinishi (/api/works?month=)", () => {
  let c: number;
  const at = async (m: string, work: string) => {
    const r = await L.get(`/api/works?pageSize=100&month=${m}`);
    expect(r.status).toBe(200);
    expect(r.body.month).toBe(m);
    return r.body.items.find((i: any) => i.clientId === c).cells[ids[work]];
  };

  beforeAll(async () => {
    c = await tx((db) => createClient(db, { stir: '309111222', name: 'OY MCHJ', taxType: 'AOS', status: 'ACTIVE', accountantId: team.acc1 }, team.leader));
    await tx((db) => generatePeriod(db, `${month(-1)}-01`));
    await pastDue();
  });

  it("katakda shu oy vazifasi: o'tgan oy muddati o'tgan, joriy oy ochiq; bajarilsa done", async () => {
    const prev = await at(month(-1), 'salary');
    expect(prev).toMatchObject({ state: 'overdue', beforeSystem: false });
    expect(prev.next).toMatchObject({ kind: 'TASK', taskId: prev.taskId, month: month(-1) });
    expect(['open', 'soon']).toContain((await at(month(0), 'salary')).state);
    expect((await L.post(`/api/tasks/${prev.taskId}/done`)).status).toBe(200);
    expect(await at(month(-1), 'salary')).toMatchObject({ state: 'done', taskId: prev.taskId, next: null });
    // Kelajak oyda vazifa yo'q
    expect((await at(month(1), 'salary')).state).toBe('na');
  });

  it("INPS ish oyi bo'yicha (V36): oy ishi = shu oy vazifasi, muddat keyingi oyning 25-kuni", async () => {
    const prev = await at(month(-1), 'inps');
    const task = await one(pool, `SELECT to_char(period, 'YYYY-MM') AS p, to_char(due_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS due FROM task WHERE id = $1`, [prev.taskId]);
    expect(task).toEqual({ p: month(-1), due: `${month(0)}-25` });
    expect((await at(month(0), 'inps')).taskId).toBeTruthy();
  });

  it("tizimgacha bo'lgan oylar boshlang'ich nuqtadan: faqat navbatdagi oy bosiladi", async () => {
    expect((await L.put(`/api/works/${c}/${ids.bank}/baseline`, { month: month(-4) })).status).toBe(200);
    expect(await at(month(-5), 'bank')).toMatchObject({ state: 'done', beforeSystem: true, taskId: null });
    expect(await at(month(-4), 'bank')).toMatchObject({ state: 'done', beforeSystem: true });
    expect(await at(month(-3), 'bank')).toMatchObject({ state: 'overdue', beforeSystem: true, next: { kind: 'BASELINE', month: month(-3) } });
    expect(await at(month(-2), 'bank')).toMatchObject({ state: 'overdue', next: null });
    // Boshlang'ich nuqtasi yo'q ish: tizimgacha "—"
    expect((await at(month(-3), 'salary')).state).toBe('na');
  });

  it("noto'g'ri oy formati rad etiladi", async () => {
    expect((await L.get('/api/works?month=2026-13')).status).toBe(400);
  });
});

describe("Excel kabi ish katagi: PUT /api/works/cell (V31)", () => {
  let c: number;
  const at = async (m: string, work: string) =>
    (await L.get(`/api/works?pageSize=100&month=${m}`)).body.items.find((i: any) => i.clientId === c).cells[ids[work]];
  const put = (who: ReturnType<typeof api>, work: string, m: string, value: string) =>
    who.put('/api/works/cell', { clientId: c, routineTypeId: ids[work], month: m, value });

  beforeAll(async () => {
    // Nol hisobot: qoida bo'yicha doimiy ish chiqmaydi; faqat Buxgalter ishlarida (INPS doimiy ish)
    c = await tx((db) => createClient(db, { stir: '309333444', name: 'NOL ISH MCHJ', taxType: 'AOS', status: 'ZERO_REPORT', accountantId: team.acc1, inReports: false, inWorks: true }, team.leader));
  });

  it("holat to'smaydi: Nol hisobot mijozga ish 0 qilinadi, keyin 1, 0, X", async () => {
    expect((await at(month(0), 'salary')).state).toBe('na');
    expect((await put(L, 'salary', month(0), '0')).status).toBe(200);
    const open = await at(month(0), 'salary');
    expect(['open', 'soon']).toContain(open.state);
    const done = await put(L, 'salary', month(0), '1');
    expect(done.body.task).toMatchObject({ id: open.taskId, status: 'DONE' });
    expect((await at(month(0), 'salary')).state).toBe('done');
    await put(L, 'salary', month(0), '0');
    expect((await at(month(0), 'salary')).taskId).toBe(open.taskId);
    await put(L, 'salary', month(0), 'X');
    expect((await at(month(0), 'salary')).state).toBe('na');
    expect((await one(pool, 'SELECT status FROM task WHERE id = $1', [open.taskId])).status).toBe('CANCELLED');
  });

  it("tanlov keyingi oyga o'tadi; INPS ish oyi bo'yicha (joriy oy ishi = joriy oy vazifasi, V36)", async () => {
    await put(L, 'bank', month(-1), '0');
    expect(['overdue', 'open']).toContain((await at(month(-1), 'bank')).state);
    expect(['open', 'soon']).toContain((await at(month(0), 'bank')).state);
    const r = await put(L, 'inps', month(0), '1');
    expect(r.status).toBe(200);
    const task = await one(pool, `SELECT to_char(period, 'YYYY-MM') AS p, status FROM task WHERE id = $1`, [r.body.task.id]);
    expect(task).toMatchObject({ p: month(0), status: 'DONE' });
    expect((await at(month(0), 'inps')).state).toBe('done');
  });

  it('faqat rahbar', async () => {
    expect((await put(A1, 'salary', month(0), '1')).status).toBe(403);
  });
});
