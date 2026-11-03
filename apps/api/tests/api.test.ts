import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatchDue, remindOverdue } from '../src/modules/notifications';
import { api, app, createUser, one, pool, q, resetDb, seedTeam, token } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;
let L: ReturnType<typeof api>;
let A1: ReturnType<typeof api>;
let A2: ReturnType<typeof api>;
let aosClient: number;
let qqsClient: number;

beforeAll(async () => {
  await resetDb();
  team = await seedTeam();
  L = api(await token('leader'));
  A1 = api(await token('acc1'));
  A2 = api(await token('acc2'));
});

describe('auth', () => {
  it('noto\'g\'ri parol 401, 5 marta xato -> bloklash 423', async () => {
    await createUser('victim', 'ACCOUNTANT');
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/login').send({ login: 'victim', password: 'xato-parol' });
      expect(r.status).toBe(401);
    }
    const r = await request(app).post('/api/auth/login').send({ login: 'victim', password: 'Parol123!' });
    expect(r.status).toBe(423);
  });

  it('refresh token aylanadi, eskisi qayta ishlatilsa sessiyalar yopiladi', async () => {
    const login = await request(app).post('/api/auth/login').send({ login: 'acc2', password: 'Parol123!' });
    const cookie = login.headers['set-cookie'];
    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(r1.status).toBe(200);
    // 30 soniya ichida: parallel tablar poygasi deb hisoblanadi
    const race = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(race.body.code).toBe('REFRESH_RACE');
    await pool.query(`UPDATE refresh_token SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL`);
    const reuse = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    const r2 = await request(app).post('/api/auth/refresh').set('Cookie', r1.headers['set-cookie']);
    expect(r2.status).toBe(401); // butun zanjir yopilgan
  });

  it('buxgalter /api/users ga kira olmaydi (403), rahbar kiradi', async () => {
    expect((await A1.get('/api/users')).status).toBe(403);
    expect((await L.get('/api/users')).status).toBe(200);
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('yangi parol faqat 6–12 ta raqam', async () => {
    const base = { fullName: 'Pin Test', role: 'ACCOUNTANT' };
    for (const password of ['12345', '1234567890123', 'abc123', '12 456', 'Parol123!']) {
      expect((await L.post('/api/users', { ...base, login: 'pintest', password })).status).toBe(400);
    }
    const r = await L.post('/api/users', { ...base, login: 'pintest', password: '135792468' });
    expect(r.status).toBe(201);
    expect((await request(app).post('/api/auth/login').send({ login: 'pintest', password: '135792468' })).status).toBe(200);
    expect((await L.post(`/api/users/${r.body.id}/reset-password`, { password: 'abcdef' })).status).toBe(400);
    await L.patch(`/api/users/${r.body.id}`, { active: false });
  });

  it('rahbar tarixsiz xodimni o\'chiradi; tarixi bor xodim va o\'zi o\'chirilmaydi', async () => {
    const fresh = await createUser('fresh', 'ACCOUNTANT');
    await token('fresh'); // refresh_token yozuvi o'chirishga xalaqit bermaydi
    expect((await A1.del(`/api/users/${fresh}`)).status).toBe(403);
    expect((await L.del(`/api/users/${fresh}`)).status).toBe(200);
    expect(await one(pool, 'SELECT id FROM app_user WHERE id = $1', [fresh])).toBeFalsy();
    expect(await one(pool, `SELECT id FROM audit_log WHERE entity = 'app_user' AND entity_id = $1 AND action = 'DELETE'`, [fresh])).toBeTruthy();

    // Tarixi bor xodim (audit_log'da actor, mijozi bor): bazada qoladi, lekin ro'yxatdan yo'qoladi, kira olmaydi, login bo'shaydi
    const other = await createUser('leader2', 'LEADER');
    const L2 = api(await token('leader2'));
    await L2.patch(`/api/users/${team.acc2}`, { fullName: 'Bobur Aliyev' });
    expect((await L.del(`/api/users/${other}`)).status).toBe(200);
    expect(await one(pool, 'SELECT login, active, deleted_at FROM app_user WHERE id = $1', [other])).toMatchObject({ login: `leader2~${other}`, active: false });
    expect((await L.get('/api/users')).body.some((u: { id: number }) => u.id === other)).toBe(false);
    expect((await request(app).post('/api/auth/login').send({ login: 'leader2', password: 'Parol123!' })).status).toBe(401);
    expect((await L.del(`/api/users/${other}`)).status).toBe(404);
    expect((await L.patch(`/api/users/${other}`, { active: true })).status).toBe(404);
    expect((await L.post('/api/users', { fullName: 'Yangi', login: 'leader2', password: '135792468', role: 'LEADER' })).status).toBe(201);
    await L.patch(`/api/users/${(await one(pool, `SELECT id FROM app_user WHERE login = 'leader2'`)).id}`, { active: false });

    // Buxgalter o'chirilsa mijozlari buxgalterisiz qoladi
    const acc = await createUser('acc-del', 'ACCOUNTANT');
    const c = await L.post('/api/clients', { stir: '309111222', name: 'DEL TEST', taxType: 'AOS', accountantId: acc });
    expect(c.status).toBe(201);
    expect((await L.del(`/api/users/${acc}`)).status).toBe(200);
    expect((await one(pool, 'SELECT accountant_id FROM client WHERE id = $1', [c.body.id])).accountant_id).toBeNull();
    expect(await one(pool, `SELECT id FROM task WHERE assignee_id = $1 AND status <> 'DONE'`, [acc])).toBeFalsy();

    expect((await L.del(`/api/users/${team.leader}`)).body.code).toBe('SELF_DELETE');
    expect((await L.del('/api/users/999999')).status).toBe(404);
  });
});

describe('mijozlar', () => {
  it('rahbar yaratadi, soliq turi tarixi saqlanadi; buxgalter yarata olmaydi', async () => {
    const r = await L.post('/api/clients', { stir: '305123456', name: 'SHERPROM STROY', taxType: 'AOS', accountantId: team.acc1 });
    expect(r.status).toBe(201);
    aosClient = r.body.id;
    const r2 = await L.post('/api/clients', { stir: '306234567', name: 'INSAR MIX TRADE', taxType: 'QQS', accountantId: team.acc2 });
    qqsClient = r2.body.id;
    expect((await A1.post('/api/clients', { stir: '307345678', name: 'X', taxType: 'AOS' })).status).toBe(403);
    expect((await L.post('/api/clients', { stir: '305123456', name: 'dup', taxType: 'AOS' })).status).toBe(409);
    expect((await L.post('/api/clients', { stir: '307345678', name: 'X', taxType: 'NDS' })).status).toBe(400);
    const card = await L.get(`/api/clients/${aosClient}`);
    expect(card.body.taxHistory).toHaveLength(1);
    expect(card.body.taxHistory[0].taxType).toBe('AOS');
  });

  it('buxgalter faqat o\'z mijozini ko\'radi (serverda)', async () => {
    const list = await A1.get('/api/clients');
    expect(list.body.items.map((c: any) => c.id)).toEqual([aosClient]);
    expect((await A1.get(`/api/clients/${qqsClient}`)).status).toBe(404);
    expect((await A1.patch(`/api/clients/${aosClient}`, { taxType: 'QQS' })).status).toBe(403);
    expect((await A1.patch(`/api/clients/${aosClient}`, { phone: '+998901112233' })).status).toBe(200);
  });

  it('qidiruv: kirillcha so\'rov lotin nomni topadi', async () => {
    const r = await L.get('/api/clients?search=' + encodeURIComponent('шерпром'));
    expect(r.body.items.map((c: any) => c.id)).toContain(aosClient);
  });

  it('soliq turi o\'zgarishi tarixga yoziladi va oylik jadval yangilanadi', async () => {
    const r = await L.patch(`/api/clients/${qqsClient}`, { taxType: 'AOS' });
    expect(r.status).toBe(200);
    const card = await L.get(`/api/clients/${qqsClient}`);
    expect(card.body.taxHistory.map((h: any) => h.taxType)).toEqual(['AOS', 'QQS']);
    const grid = await L.get('/api/monthly-grid');
    const cols = Object.fromEntries(grid.body.columns.map((c: any) => [c.code, c.reportTypeId]));
    const row = grid.body.rows.find((x: any) => x.clientId === qqsClient);
    expect(row.cells[cols.QQS].state).toBe('X');
    expect(row.cells[cols.AOS].state).not.toBe('X');
    await L.patch(`/api/clients/${qqsClient}`, { taxType: 'QQS' });
  });

  it('buxgalter almashtirish: ochiq vazifalar yangisiga o\'tadi', async () => {
    await L.patch(`/api/clients/${qqsClient}`, { accountantId: team.acc1 });
    const open = await one(
      pool,
      `SELECT count(*)::int AS n FROM task WHERE client_id = $1 AND assignee_id = $2 AND status <> 'DONE'`,
      [qqsClient, team.acc2],
    );
    expect(open.n).toBe(0);
    await L.patch(`/api/clients/${qqsClient}`, { accountantId: team.acc2 });
  });

  it('buxgalter keyin tayinlansa biriktirilmagan vazifalar unga o\'tadi (buxgalter vazifasi bo\'lmagan hisobot bo\'sh qoladi)', async () => {
    const c = await L.post('/api/clients', { stir: '309333444', name: 'ORPHAN TEST', taxType: 'AOS' });
    expect(c.status).toBe(201);
    const count = (where: string) =>
      one(pool, `SELECT count(*)::int AS n FROM task t LEFT JOIN report_type rt ON rt.id = t.report_type_id WHERE t.client_id = $1 AND ${where}`, [c.body.id]);
    expect((await count('t.assignee_id IS NOT NULL')).n).toBe(0);
    expect((await count("t.kind = 'ROUTINE'")).n).toBeGreaterThan(0);

    await L.patch(`/api/clients/${c.body.id}`, { accountantId: team.acc1 });
    expect((await count(`t.kind = 'ROUTINE' AND t.assignee_id IS DISTINCT FROM ${team.acc1}`)).n).toBe(0);
    expect((await count(`rt.code = 'INPS' AND t.assignee_id = ${team.acc1}`)).n).toBe(1);
    expect((await count(`rt.code = 'JSHDS' AND t.assignee_id IS NULL`)).n).toBe(1);
    await L.patch(`/api/clients/${c.body.id}`, { accountantId: null });
  });
});

describe('sozlamalar', () => {
  it('11-chi faol ish qo\'shilmaydi (409 ROUTINE_LIMIT); buxgalter o\'zgartira olmaydi', async () => {
    expect((await A1.post('/api/settings/routine-works', { name: 'x' })).status).toBe(403);
    expect((await L.post('/api/settings/routine-works', { name: '9-ish' })).status).toBe(201);
    expect((await L.post('/api/settings/routine-works', { name: '10-ish' })).status).toBe(201);
    const r = await L.post('/api/settings/routine-works', { name: '11-ish' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ROUTINE_LIMIT');
    expect((await A1.patch('/api/settings/report-types/1', { dueDay: 10 })).status).toBe(403);
    expect((await A1.get('/api/settings/report-types')).status).toBe(200);
  });

  it('muddat kuni o\'zgarsa joriy oyning ochiq vazifalari ko\'chadi, bajarilgani tegilmaydi', async () => {
    const tasks = await q(
      pool,
      `SELECT t.id FROM task t JOIN report_type rt ON rt.id = t.report_type_id
       WHERE rt.code = 'JSHDS' AND t.status = 'TODO' ORDER BY t.id LIMIT 2`,
    );
    expect(tasks.length).toBe(2);
    await pool.query(`UPDATE task SET status = 'DONE', done_at = now() WHERE id = $1`, [tasks[1].id]);
    const due = async (id: number) =>
      (await one(pool, `SELECT to_char(due_at AT TIME ZONE 'Asia/Tashkent', 'DD') AS d FROM task WHERE id = $1`, [id])).d;
    const doneBefore = await due(tasks[1].id);
    expect((await L.patch('/api/settings/report-types/1', { dueDay: 25 })).status).toBe(200);
    expect(await due(tasks[0].id)).toBe('25');
    expect(await due(tasks[1].id)).toBe(doneBefore);
    await L.patch('/api/settings/report-types/1', { dueDay: 15 });
    expect(await due(tasks[0].id)).toBe('15');
    await pool.query(`UPDATE task SET status = 'TODO', done_at = NULL WHERE id = $1`, [tasks[1].id]);
  });
});

describe('vazifalar: holat, taymer, Bajarildi va undo', () => {
  let inps: number;
  beforeAll(async () => {
    inps = (
      await one(
        pool,
        `SELECT t.id FROM task t JOIN report_type rt ON rt.id = t.report_type_id WHERE t.client_id = $1 AND rt.code = 'INPS' AND t.status <> 'CANCELLED'`,
        [aosClient],
      )
    ).id;
  });

  it('boshqa buxgalter vazifasiga ruxsat yo\'q', async () => {
    expect((await A2.patch(`/api/tasks/${inps}/status`, { status: 'IN_PROGRESS' })).status).toBe(403);
  });

  it('Jarayonda -> taymer yoqiladi; boshqa vazifada yangi taymer eskisini to\'xtatadi', async () => {
    const r = await A1.patch(`/api/tasks/${inps}/status`, { status: 'IN_PROGRESS' });
    expect(r.status).toBe(200);
    expect(r.body.timerStartedAt).not.toBeNull();
    const other = (await one(pool, `SELECT id FROM task WHERE client_id = $1 AND kind = 'ROUTINE' LIMIT 1`, [aosClient])).id;
    await A1.patch(`/api/tasks/${other}/status`, { status: 'IN_PROGRESS' });
    const open = await q(pool, 'SELECT task_id FROM time_entry WHERE user_id = $1 AND ended_at IS NULL', [team.acc1]);
    expect(open.map((o) => o.task_id)).toEqual([other]);
    await A1.patch(`/api/tasks/${other}/status`, { status: 'WAITING_CLIENT' });
    expect((await q(pool, 'SELECT 1 FROM time_entry WHERE task_id = $1 AND ended_at IS NULL', [other])).length).toBe(0);
  });

  it('Bajarildi -> rahbarga xabar 5s+ keyin; undo 5s ichida -> xabar bekor, yuborilmaydi', async () => {
    const done = await A1.post(`/api/tasks/${inps}/done`);
    expect(done.body.status).toBe('DONE');
    const n = await one(pool, `SELECT id, deliver_at - now() > interval '4 seconds' AS delayed FROM notification WHERE task_id = $1 AND kind = 'TASK_DONE'`, [inps]);
    expect(n.delayed).toBe(true);
    const undo = await A1.post(`/api/tasks/${inps}/undo-done`);
    expect(undo.status).toBe(200);
    expect(undo.body.status).toBe('IN_PROGRESS');
    // Vaqtni "oldinga suramiz": dispatcher baribir bekor qilinganni yubormaydi
    await pool.query(`UPDATE notification SET deliver_at = now() - interval '1 second' WHERE task_id = $1`, [inps]);
    await dispatchDue(async () => undefined);
    const after = await one(pool, 'SELECT delivered_at, cancelled_at FROM notification WHERE id = $1', [n.id]);
    expect(after.delivered_at).toBeNull();
    expect(after.cancelled_at).not.toBeNull();
  });

  it('5 soniyadan keyin undo 409; xabar yetkaziladi', async () => {
    await A1.post(`/api/tasks/${inps}/done`);
    await pool.query(`UPDATE task SET done_at = now() - interval '6 seconds' WHERE id = $1`, [inps]);
    const undo = await A1.post(`/api/tasks/${inps}/undo-done`);
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe('UNDO_EXPIRED');
    await pool.query(`UPDATE notification SET deliver_at = now() WHERE task_id = $1 AND cancelled_at IS NULL`, [inps]);
    await dispatchDue(async () => undefined);
    const list = await L.get('/api/notifications');
    expect(list.body.items.some((x: any) => x.taskId === inps && x.kind === 'TASK_DONE')).toBe(true);
    expect((await L.get('/api/notifications/unread-count')).body.count).toBeGreaterThan(0);
  });

  it('DONE -> TODO faqat rahbar', async () => {
    expect((await A1.patch(`/api/tasks/${inps}/status`, { status: 'TODO' })).status).toBe(403);
    expect((await L.patch(`/api/tasks/${inps}/status`, { status: 'TODO' })).status).toBe(200);
  });

  it('Telegram: chat_id bo\'lmasa faqat ilova ichida; bog\'langan bo\'lsa TELEGRAM ham (bot sozlanmagan -> yo\'q)', async () => {
    const rows = await q(pool, `SELECT DISTINCT channel FROM notification`);
    expect(rows.map((r) => r.channel)).toEqual(['APP']);
  });

  it('checklist qo\'shish/belgilash/o\'chirish', async () => {
    const it1 = await A1.post(`/api/tasks/${inps}/checklist`, { text: 'Hujjatlarni tekshirish' });
    expect(it1.status).toBe(201);
    expect((await A1.patch(`/api/tasks/${inps}/checklist/${it1.body.id}`, { done: true })).body.done).toBe(true);
    expect((await A1.del(`/api/tasks/${inps}/checklist/${it1.body.id}`)).status).toBe(204);
  });
});

describe('eslatma: muddat o\'tdi', () => {
  it('buxgalter va rahbarga bir marta', async () => {
    const t = (await one(pool, `SELECT id FROM task WHERE assignee_id = $1 AND status = 'TODO' LIMIT 1`, [team.acc1])).id;
    await pool.query(`UPDATE task SET due_at = now() - interval '1 hour', overdue_notified_at = NULL WHERE id = $1`, [t]);
    await pool.query(`UPDATE task SET overdue_notified_at = now() WHERE id <> $1`, [t]);
    await remindOverdue();
    await remindOverdue();
    const rows = await q(pool, `SELECT user_id FROM notification WHERE task_id = $1 AND kind = 'TASK_OVERDUE' ORDER BY user_id`, [t]);
    expect(rows.map((r) => r.user_id)).toEqual([team.leader, team.acc1]);
  });
});

describe('oylik jadval', () => {
  it('buxgalter faqat o\'z mijozlarini ko\'radi; katak bosish DONE qiladi', async () => {
    const g = await A1.get('/api/monthly-grid');
    expect(g.body.rows.map((r: any) => r.clientId)).toEqual([aosClient]);
    const cols = Object.fromEntries(g.body.columns.map((c: any) => [c.code, c.reportTypeId]));
    const row = g.body.rows[0];
    expect(row.cells[cols.QQS].state).toBe('X');
    expect(row.cells[cols.FOYDA].state).toBe('X');
    const jshds = row.cells[cols.JSHDS];
    const r = await A1.post(`/api/monthly-grid/cell/${jshds.taskId}/done`);
    expect(r.status).toBe(200);
    const g2 = await A1.get('/api/monthly-grid');
    expect(g2.body.rows[0].cells[cols.JSHDS].state).toBe('1');
  });

  it('Excel yuklab olish: buxgalterga faqat o\'z mijozlari, katak 1/0/X', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const read = async (r: request.Response) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body);
      const ws = wb.worksheets[0];
      const head = (ws.getRow(1).values as any[]).slice(1).map(String);
      const rows = [] as any[][];
      ws.eachRow((row, n) => n > 1 && rows.push((row.values as any[]).slice(1)));
      return { head, rows };
    };
    const bin = (req: request.Test) => req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const r = await bin(A1.get('/api/monthly-grid/export.xlsx'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const { head, rows } = await read(r);
    expect(rows).toHaveLength(1);
    const col = (prefix: string) => head.findIndex((x) => x.toUpperCase().startsWith(prefix));
    expect(rows[0][col('QQS')]).toBe('X');
    expect(rows[0][col('JSHDS')]).toBe('1');
    expect(['0', '1']).toContain(rows[0][col('INPS')]);
    // Holat ustuni ekranda "0", Excel'da esa import formatidagidek X (holat yo'q)
    expect(rows[0][col('DIVIDEND')]).toBe('X');
    const all = await read(await bin(L.get('/api/monthly-grid/export.xlsx')));
    expect(all.rows.length).toBeGreaterThan(1);
  });
  it('Dividend: holat belgilanmagan katak "0" (qat\'iy "—" emas), bosilsa belgilanadi va vazifa chiqadi; bekor qilsa qaytadi', async () => {
    const g = await A1.get('/api/monthly-grid');
    const cols = Object.fromEntries(g.body.columns.map((c: any) => [c.code, c.reportTypeId]));
    const cell = () => A1.get('/api/monthly-grid').then((r) => r.body.rows[0].cells[cols.DIVIDEND]);
    expect(g.body.rows[0].cells[cols.DIVIDEND]).toMatchObject({ state: '0', taskId: null, noEvent: true, markable: true });
    // AOS mijozga Norezident foyda soliq turi bo'yicha topshirilmaydi: qat'iy "—", bosib bo'lmaydi
    expect(g.body.rows[0].cells[cols.NOREZIDENT_FOYDA]).toMatchObject({ state: 'X' });
    expect(g.body.rows[0].cells[cols.NOREZIDENT_FOYDA].markable).toBeUndefined();

    const url = `/api/clients/${aosClient}/events/${cols.DIVIDEND}/${g.body.eventMonth}`;
    expect((await A1.put(url)).status).toBe(200);
    const marked = await cell();
    expect(marked.state).toBe('0');
    expect(marked.taskId).toBeTruthy();
    expect(marked.markable).toBeUndefined();
    expect(marked.noEvent).toBeUndefined();

    expect((await A1.del(url)).status).toBe(200);
    expect(await cell()).toMatchObject({ state: '0', taskId: null, noEvent: true, markable: true });

    // Ikki oy keyingi jadvalda belgilab bo'lmaydi (server faqat joriy va o'tgan holat oyini qabul qiladi)
    const [y, m] = g.body.period.split('-').map(Number);
    const later = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 7);
    const g3 = await A1.get(`/api/monthly-grid?month=${later}`);
    expect(g3.body.eventMonth).toBeNull();
    expect(g3.body.rows[0].cells[cols.DIVIDEND]).toMatchObject({ state: '0', noEvent: true });
    expect(g3.body.rows[0].cells[cols.DIVIDEND].markable).toBeUndefined();
  });
});

describe('shoshilinch vazifa va dashboard', () => {
  it('taklif: eng kam ochiq vazifali birinchi', async () => {
    const r = await L.get('/api/tasks/urgent/suggest-assignee');
    const counts = r.body.map((x: any) => x.openCount);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it('shoshilinch: default muddat bugun 18:00, buxgalterga darhol xabar', async () => {
    const r = await L.post('/api/tasks/urgent', { clientId: aosClient, text: 'Bank ko\'chirmasi', assigneeId: team.acc1 });
    expect(r.status).toBe(201);
    const due = await one(pool, `SELECT to_char(due_at, 'HH24:MI') AS t, due_at::date = current_date AS today FROM task WHERE id = $1`, [r.body.id]);
    expect(due).toEqual({ t: '18:00', today: true });
    await dispatchDue(async () => undefined);
    const n = await A1.get('/api/notifications');
    expect(n.body.items[0].kind).toBe('URGENT_TASK');
    expect((await A1.post('/api/tasks/urgent', { clientId: aosClient, text: 'x', assigneeId: team.acc1 })).status).toBe(403);
  });

  it('dashboard raqamlari bazaga mos', async () => {
    const d = await L.get('/api/dashboard/clients');
    const db = await one(pool, `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE')::int AS done FROM task WHERE period = date_trunc('month', now())::date AND status <> 'CANCELLED'`);
    expect(d.body.summary.tasksTotal).toBe(db.total);
    expect(d.body.summary.tasksDone).toBe(db.done);
    const a = await L.get('/api/dashboard/accountants');
    const acc1 = a.body.accountants.find((x: any) => x.id === team.acc1);
    const open = await one(pool, `SELECT count(*)::int AS n FROM task WHERE assignee_id = $1 AND status IN ('TODO','IN_PROGRESS','WAITING_CLIENT')`, [team.acc1]);
    expect(acc1.openTasks).toBe(open.n);
    expect((await A1.get('/api/dashboard/clients')).status).toBe(403);
  });

  it('audit: rahbar ko\'radi, mijoz bo\'yicha filtr', async () => {
    const r = await L.get(`/api/audit?clientId=${aosClient}`);
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.items.every((x: any) => x.clientId === aosClient)).toBe(true);
  });
});
