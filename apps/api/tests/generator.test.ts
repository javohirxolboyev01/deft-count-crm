import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tx } from '../src/db';
import { createClient } from '../src/modules/clients';
import { generatePeriod, reassignOpenTasks, reconcileClient } from '../src/modules/generator';
import { loadGrid } from '../src/modules/grid';
import { one, pool, q, reportCodes, resetDb, seedTeam } from './helpers';

let team: Awaited<ReturnType<typeof seedTeam>>;

async function client(stir: string, taxType: 'AOS' | 'QQS', status = 'ACTIVE', accountantId?: number) {
  return tx((db) =>
    createClient(db, { stir, name: `Mijoz ${stir}`, taxType, status: status as any, accountantId: accountantId ?? team.acc1 }, team.leader),
  );
}
const gen = (period: string) => tx((db) => generatePeriod(db, period));

describe('vazifa generatori', () => {
  beforeEach(async () => {
    await resetDb();
    team = await seedTeam();
  });

  it('oktyabr matritsasi: AOS da QQS/Foyda yo\'q, QQS da AOS yo\'q (CLAUDE.md jadvali)', async () => {
    const aos = await client('305123456', 'AOS');
    const qqs = await client('306234567', 'QQS');
    await gen('2026-10-01');
    // Yillik hisobotlar faqat dekabr davrida (V38)
    expect(await reportCodes(aos, '2026-10-01')).toEqual(['JSHDS', 'TOLOV_MANBAI', 'AOS', 'INPS', 'PORUCHENYA_JSHDS']);
    expect(await reportCodes(qqs, '2026-10-01')).toEqual(['JSHDS', 'TOLOV_MANBAI', 'QQS', 'FOYDA', 'INPS', 'PORUCHENYA_JSHDS']);
  });

  it('muddatlar keyingi oyda (V36): oktyabr INPS 25.11, QQS 20.11, Foyda 20.11, Poruchenya NULL (TODO)', async () => {
    const qqs = await client('306234567', 'QQS');
    await gen('2026-10-01');
    const rows = await q(
      pool,
      `SELECT rt.code, to_char(t.due_at, 'DD.MM.YYYY HH24:MI') AS due FROM task t JOIN report_type rt ON rt.id = t.report_type_id
       WHERE t.client_id = $1 AND t.period = '2026-10-01'`,
      [qqs],
    );
    const due = Object.fromEntries(rows.map((r) => [r.code, r.due]));
    expect(due.INPS).toBe('25.11.2026 18:00');
    expect(due.QQS).toBe('20.11.2026 18:00');
    expect(due.FOYDA).toBe('20.11.2026 18:00');
    expect(due.PORUCHENYA_JSHDS).toBeNull();
  });

  it("doimiy ish muddati (V34): ish oyidan keyingi oyda (Ish haqi 5, Bank 10, Kirim 15, Chiqim 10, Debitor 20, Oyni yopish 20)", async () => {
    const id = await client('305123460', 'AOS');
    await gen('2026-10-01');
    const rows = await q(
      pool,
      `SELECT w.name, to_char(t.due_at, 'DD.MM.YYYY') AS due FROM task t JOIN routine_work_type w ON w.id = t.routine_type_id
       WHERE t.client_id = $1 AND t.period = '2026-10-01' AND t.kind = 'ROUTINE'`,
      [id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.due]))).toMatchObject({
      'Ish haqi hisoblash': '05.11.2026',
      'Bank aylanmalarini kiritish': '10.11.2026',
      'Kirim hisobvaraq-fakturalarini kiritish': '15.11.2026',
      'Chiqim hisobvaraq-fakturalarini kiritish': '10.11.2026',
      'Debitor-kreditorlar bilan ishlash': '20.11.2026',
      'Oyni yopish': '20.11.2026',
      'Boshqa ishlar': '30.11.2026',
    });
  });

  it('ACTIVE: 7 ta doimiy ish (INPS bitta vazifa), ZERO_REPORT: faqat hisobot, LIQUIDATING: hech narsa', async () => {
    const active = await client('305123456', 'AOS');
    const zero = await client('306234567', 'QQS', 'ZERO_REPORT');
    const liq = await client('307345678', 'AOS', 'LIQUIDATING');
    await gen('2026-11-01');
    const count = async (id: number, kind: string) =>
      (await one(pool, `SELECT count(*)::int AS n FROM task WHERE client_id = $1 AND period = '2026-11-01' AND kind = $2`, [id, kind])).n;
    expect(await count(active, 'ROUTINE')).toBe(7);
    expect(await count(zero, 'ROUTINE')).toBe(0);
    expect(await count(zero, 'REPORT')).toBe(5); // QQS: JShDS, To'lov manbai, QQS, INPS, Poruchenya (dividend belgisiz, Foyda chorak oyi emas V32, yillik faqat dekabr V38)
    expect(await count(liq, 'ROUTINE') + (await count(liq, 'REPORT'))).toBe(0);
    const inps = await one(
      pool,
      `SELECT count(*)::int AS n FROM task t LEFT JOIN report_type rt ON rt.id = t.report_type_id
       LEFT JOIN routine_work_type rw ON rw.id = t.routine_type_id
       WHERE t.client_id = $1 AND t.period = '2026-11-01' AND (rt.code = 'INPS' OR rw.name ILIKE 'INPS%')`,
      [active],
    );
    expect(inps.n).toBe(1);
  });

  it('INPS buxgalterga biriktiriladi, creates_accountant_task=false hisobotlar biriktirilmaydi', async () => {
    const c = await client('305123456', 'AOS');
    await gen('2026-11-01');
    const rows = await q(
      pool,
      `SELECT rt.code, t.assignee_id FROM task t JOIN report_type rt ON rt.id = t.report_type_id WHERE t.client_id = $1 AND t.period = '2026-11-01'`,
      [c],
    );
    for (const r of rows) expect(r.assignee_id).toBe(r.code === 'INPS' ? team.acc1 : null);
  });

  it('yillik hisobotlar yiliga bir marta: dekabr katagi, muddat bir yil orqada 1-mart (V38); Foyda faqat chorak oyida (V32)', async () => {
    const c = await client('306234567', 'QQS');
    await gen('2026-10-01');
    await gen('2026-11-01');
    await gen('2026-12-01');
    expect(await reportCodes(c, '2026-11-01')).not.toContain('MOLIYAVIY_NATIJA');
    expect(await reportCodes(c, '2026-11-01')).not.toContain('FOYDA');
    expect(await reportCodes(c, '2026-10-01')).toContain('FOYDA');
    expect(await reportCodes(c, '2026-12-01')).toEqual(expect.arrayContaining(['MOLIYAVIY_NATIJA', 'BALANS', 'STATISTIKA']));
    const due = async (period: string) =>
      (await one<any>(
        pool,
        `SELECT to_char(t.due_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM.YYYY') AS due, rt.frequency FROM task t
         JOIN report_type rt ON rt.id = t.report_type_id WHERE t.client_id = $1 AND rt.code = 'BALANS' AND t.period = $2`,
        [c, period],
      ));
    // 2026 yil hisoboti — 01.03.2028; tizimgacha bo'lgan 2025 yil hisoboti (oktyabr jadvali ustuni) — 01.03.2027
    expect(await due('2026-12-01')).toMatchObject({ due: '01.03.2028', frequency: 'YEARLY' });
    expect((await due('2025-12-01'))!.due).toBe('01.03.2027');
    const g = await loadGrid(pool, '2026-11-01', {});
    expect((g.columns.find((x: any) => x.code === 'BALANS') as any).dueDate).toBe('2027-03-01');
  });

  it('jadvalda choraklik/yillik ustunlar har oy: katak oxirgi generatsiya davri vazifasidan', async () => {
    // Foyda seed'da choraklik (V32); yillik hisobotlar har oy (V16), mexanizm yillik tur uchun ham tekshiriladi
    await pool.query(`UPDATE report_type SET frequency = 'YEARLY', generation_months = '{2}', due_day = 15, due_month_offset = 1 WHERE code = 'BALANS'`);
    const c = await client('306234567', 'QQS');
    await gen('2026-10-01');
    await gen('2026-11-01');
    const g = await loadGrid(pool, '2026-11-01', {});
    const col = (code: string) => g.columns.find((x: any) => x.code === code) as any;
    const cell = (code: string) => g.rows[0].cells[col(code).reportTypeId];
    expect(col('FOYDA').dueDate).toBe('2026-11-20'); // oktyabr choragi, muddat keyingi oyda (V36)
    expect(col('BALANS').dueDate).toBe('2026-03-15'); // fevral davri, muddat keyingi oyda (offset 1)
    const src = async (taskId: number | null) =>
      one<any>(pool, `SELECT to_char(period, 'YYYY-MM-DD') AS period, overdue_notified_at FROM task WHERE id = $1`, [taskId]);
    expect((await src(cell('FOYDA').taskId))!.period).toBe('2026-10-01');
    // Fevral vazifasi tizim keyin ishga tushgani uchun yaratiladi; muddati o'tgan, lekin xabar yuborilmaydi
    const bal = await src(cell('BALANS').taskId);
    expect(bal).toMatchObject({ period: '2026-02-01' });
    expect(bal!.overdue_notified_at).not.toBeNull();
    expect(cell('BALANS').state).toBe('!');
  });

  it('holat bo\'yicha hisobot: holat oyi katagida, muddat keyingi oyda (V36)', async () => {
    const c = await client('306234567', 'QQS');
    // Oktyabrda norezidentga daromad to'landi -> oktyabr vazifasi, muddat noyabrda
    await pool.query(
      `INSERT INTO client_report_event (client_id, report_type_id, month)
       SELECT $1, id, '2026-10' FROM report_type WHERE code IN ('NOREZIDENT_FOYDA', 'DIVIDEND')`,
      [c],
    );
    await gen('2026-10-01');
    await gen('2026-11-01');
    await gen('2026-12-01');
    expect(await reportCodes(c, '2026-10-01')).toEqual(expect.arrayContaining(['NOREZIDENT_FOYDA', 'DIVIDEND']));
    expect(await reportCodes(c, '2026-10-01')).not.toContain('NOREZIDENT_QQS'); // alohida belgi
    expect(await reportCodes(c, '2026-11-01')).not.toContain('NOREZIDENT_FOYDA');
    const t = await one<any>(
      pool,
      `SELECT to_char(t.due_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM.YYYY') AS due FROM task t
       JOIN report_type rt ON rt.id = t.report_type_id WHERE t.client_id = $1 AND rt.code = 'NOREZIDENT_FOYDA'`,
      [c],
    );
    expect(t.due).toBe('20.11.2026');
  });

  it('dividend va norezident hisobotlari faqat QQS to\'lovchilarga (V38), dividend muddati 20-sana', async () => {
    const aos = await client('305123456', 'AOS');
    const qqs = await client('306234567', 'QQS');
    await pool.query(
      `INSERT INTO client_report_event (client_id, report_type_id, month)
       SELECT c, id, '2026-10' FROM report_type, unnest($1::bigint[]) c WHERE code IN ('DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS')`,
      [[aos, qqs]],
    );
    await gen('2026-10-01');
    const codes = await reportCodes(aos, '2026-10-01');
    expect(codes).not.toContain('DIVIDEND');
    expect(codes).not.toContain('NOREZIDENT_FOYDA');
    expect(codes).not.toContain('NOREZIDENT_QQS');
    expect(await reportCodes(qqs, '2026-10-01')).toEqual(expect.arrayContaining(['DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS']));
    const d = await one<any>(
      pool,
      `SELECT to_char(t.due_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM.YYYY') AS due FROM task t
       JOIN report_type rt ON rt.id = t.report_type_id WHERE t.client_id = $1 AND rt.code = 'DIVIDEND'`,
      [qqs],
    );
    expect(d.due).toBe('20.11.2026');
  });

  it('idempotent: ikkinchi ishga tushirish dublikat yaratmaydi', async () => {
    await client('305123456', 'AOS');
    await client('306234567', 'QQS');
    const first = await gen('2026-12-01');
    const total1 = (await one(pool, `SELECT count(*)::int AS n FROM task WHERE period = '2026-12-01'`)).n;
    const second = await gen('2026-12-01');
    const total2 = (await one(pool, `SELECT count(*)::int AS n FROM task WHERE period = '2026-12-01'`)).n;
    expect(first.created.length).toBeGreaterThan(0);
    expect(second.created.length).toBe(0);
    expect(total2).toBe(total1);
  });

  it('yangi oylik ish keyingi oydan chiqadi', async () => {
    const c = await client('305123456', 'AOS');
    await pool.query(`INSERT INTO routine_work_type (name, name_ru, effective_from) VALUES ('Yangi ish', 'Новая', '2026-12-01')`);
    await gen('2026-11-01');
    await gen('2026-12-01');
    const n = async (p: string) =>
      (await one(pool, `SELECT count(*)::int AS n FROM task WHERE client_id = $1 AND period = $2 AND title = 'Yangi ish'`, [c, p])).n;
    expect(await n('2026-11-01')).toBe(0);
    expect(await n('2026-12-01')).toBe(1);
  });

  it('reconcile: soliq turi AOS -> QQS: ochiq AOS bekor, QQS/Foyda yaratiladi, DONE tegilmaydi', async () => {
    const c = await client('305123456', 'AOS');
    await gen('2026-10-01');
    // JShDS ni bajarilgan qilamiz
    await pool.query(
      `UPDATE task SET status = 'DONE', done_at = now() WHERE client_id = $1 AND period = '2026-10-01'
         AND report_type_id = (SELECT id FROM report_type WHERE code = 'JSHDS')`,
      [c],
    );
    await pool.query(`INSERT INTO client_tax_type_history (client_id, tax_type, effective_from) VALUES ($1, 'QQS', '2026-10-01')`, [c]);
    await pool.query(`UPDATE client SET tax_type = 'QQS' WHERE id = $1`, [c]);
    const r = await tx((db) => reconcileClient(db, c, team.leader, '2026-10-01'));
    expect(r.cancelled.map((t: any) => t.title)).toEqual(['AOS']);
    expect(await reportCodes(c, '2026-10-01')).toEqual(['JSHDS', 'TOLOV_MANBAI', 'QQS', 'FOYDA', 'INPS', 'PORUCHENYA_JSHDS']);
    const jshds = await one(
      pool,
      `SELECT status FROM task WHERE client_id = $1 AND period = '2026-10-01' AND report_type_id = (SELECT id FROM report_type WHERE code = 'JSHDS')`,
      [c],
    );
    expect(jshds.status).toBe('DONE');
    const auditCancel = await one(pool, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'CANCEL_NOT_APPLICABLE' AND client_id = $1`, [c]);
    expect(auditCancel.n).toBe(1);
    // Qaytarsa: bekor qilingan AOS qayta ochiladi (yangi dublikat emas)
    await pool.query(`INSERT INTO client_tax_type_history (client_id, tax_type, effective_from) VALUES ($1, 'AOS', '2026-10-02')`, [c]);
    const back = await tx((db) => reconcileClient(db, c, team.leader, '2026-10-01'));
    expect(back.reopened.map((t: any) => t.title)).toEqual(['AOS']);
  });

  it('o\'tgan davrlar soliq turi o\'zgarishidan ta\'sirlanmaydi', async () => {
    const c = await client('305123456', 'AOS');
    await gen('2026-11-01');
    await pool.query(`INSERT INTO client_tax_type_history (client_id, tax_type, effective_from) VALUES ($1, 'QQS', '2026-12-01')`, [c]);
    await gen('2026-12-01');
    expect(await reportCodes(c, '2026-11-01')).toContain('AOS');
    expect(await reportCodes(c, '2026-12-01')).toContain('QQS');
    expect(await reportCodes(c, '2026-12-01')).not.toContain('AOS');
  });

  it('buxgalter almashsa ochiq vazifalar yangisiga o\'tadi, DONE eskisida qoladi', async () => {
    const c = await client('305123456', 'AOS', 'ACTIVE', team.acc1);
    await gen('2026-11-01');
    const done = await one(pool, `SELECT id FROM task WHERE client_id = $1 AND kind = 'ROUTINE' AND period = '2026-11-01' LIMIT 1`, [c]);
    await pool.query(`UPDATE task SET status = 'DONE', done_at = now() WHERE id = $1`, [done.id]);
    await pool.query('UPDATE client SET accountant_id = $2 WHERE id = $1', [c, team.acc2]);
    const moved = await tx((db) => reassignOpenTasks(db, c, team.acc2, team.leader));
    expect(moved).toBeGreaterThan(0);
    expect((await one(pool, 'SELECT assignee_id FROM task WHERE id = $1', [done.id])).assignee_id).toBe(team.acc1);
    const left = await one(
      pool,
      `SELECT count(*)::int AS n FROM task WHERE client_id = $1 AND assignee_id = $2 AND status <> 'DONE'`,
      [c, team.acc1],
    );
    expect(left.n).toBe(0);
  });
});

describe('oylik jadval viewi', () => {
  beforeAll(async () => {
    await resetDb();
    team = await seedTeam();
  });
  it('AOS: QQS va Foyda X; QQS: AOS X; LIQUIDATING: hammasi X', async () => {
    const aos = await client('305123456', 'AOS');
    const qqs = await client('306234567', 'QQS');
    const liq = await client('307345678', 'QQS', 'LIQUIDATING');
    await gen('2026-10-01');
    const cells = await q(
      pool,
      `SELECT g.client_id, rt.code, g.cell FROM v_monthly_grid g JOIN report_type rt ON rt.id = g.report_type_id
       WHERE g.period = '2026-10-01'`,
    );
    const cell = (id: number, code: string) => cells.find((c) => c.client_id === id && c.code === code)?.cell;
    expect(cell(aos, 'QQS')).toBe('X');
    expect(cell(aos, 'FOYDA')).toBe('X');
    expect(cell(aos, 'AOS')).not.toBe('X');
    expect(cell(qqs, 'AOS')).toBe('X');
    expect(cell(qqs, 'FOYDA')).not.toBe('X');
    for (const code of ['JSHDS', 'QQS', 'INPS']) expect(cell(liq, code)).toBe('X');
  });
});
