import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { dryTx, tx } from '../src/db';
import { importTable } from '../src/modules/sheets/importer';
import { detectWorksFile, importWorks, matchAccountant, toAccountant } from '../src/modules/sheets/worksImporter';
import { generatePeriod } from '../src/modules/generator';
import { app, one, pool, q, reportCodes, resetDb, seedTeam, token } from './helpers';

const HEADER = ['№', 'STIR', 'Korxona nomi', 'Soliq turi', 'JSHDS 15.10.2026', "To'lov manbai 15.10.2026", 'AOS 15.10.2026',
  'QQS 20.10.2026', 'FOYDA 20.10.2026', 'INPS', 'Poruchenya JSHDS', 'Қилиниши лозим бўлган ишлар'];

function sheet(): unknown[][] {
  return [
    HEADER,
    ['1', '305123456', 'SHERPROM STROY', 'AOC', '1', '0', '0', 'X', 'X', '0', '0', ''],
    ['2', '306234567', 'INSAR MIX TRADE', 'ҚҚС', '0', '0', 'X', '1', '0', '0', '0', ''],
    ['3', '307345678', 'ESKI QURILISH', 'AOS', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'Tugatishga bergan'],
    ['4', '308456789', 'YANGI TUR', 'AOS', '0', '0', '0', 'X', 'X', '0', '0', "01.01.2026 dan AOS to'lovchisi"],
    ['5', '309567890', 'NOANIQ', 'AOS', '0', '0', 'X', 'X', 'X', '0', 'ha', "QQS ga o'tishi mumkin"],
  ];
}

let leader: number;

describe('Sheets import', () => {
  beforeAll(async () => {
    await resetDb();
    leader = (await seedTeam()).leader;
  });

  it('dry-run bazaga yozmaydi, hisobot beradi', async () => {
    const r = await dryTx((db) => importTable(db, sheet(), { actorId: leader, dryRun: true }));
    expect(r.period).toBe('2026-10');
    expect(r.summary.created).toBe(5);
    expect(r.csv).toContain('stir');
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client')).n).toBe(0);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM sheet_sync_error')).n).toBe(0);
  });

  it('import: normalizatsiya, izoh bo\'linishi, 1 -> DONE, ziddiyatlar review ro\'yxatiga', async () => {
    const r = await tx((db) => importTable(db, sheet(), { actorId: leader, dryRun: false }));
    const c = await q(pool, `SELECT stir, tax_type, status, tax_type_effective_from AS eff, note FROM client ORDER BY stir`);
    expect(c[0]).toMatchObject({ stir: '305123456', tax_type: 'AOS', status: 'ACTIVE' });
    expect(c[1]).toMatchObject({ stir: '306234567', tax_type: 'QQS' });
    expect(c[2]).toMatchObject({ status: 'LIQUIDATING', note: null });
    expect(c[3]).toMatchObject({ eff: '2026-01-01', note: null });
    const jshds = await one(
      pool,
      `SELECT t.status FROM task t JOIN client c ON c.id = t.client_id JOIN report_type rt ON rt.id = t.report_type_id
       WHERE c.stir = '305123456' AND rt.code = 'JSHDS' AND t.period = '2026-10-01'`,
    );
    expect(jshds.status).toBe('DONE');
    const noaniq = r.rows.find((x) => x.stir === '309567890')!;
    expect(noaniq.review.some((m) => m.includes('PORUCHENYA'))).toBe(true); // "ha"
    // AOS mijozda AOS X: review emas, doimiy "topshirmaydi" belgisi (V17), vazifa bekor, jadvalda X
    expect(noaniq.changes).toContain('AOS=X');
    const aosCell = await one(
      pool,
      `SELECT g.cell FROM fn_monthly_grid('2026-10-01') g JOIN client c ON c.id = g.client_id JOIN report_type rt ON rt.id = g.report_type_id
       WHERE c.stir = '309567890' AND rt.code = 'AOS'`,
    );
    expect(aosCell.cell).toBe('X');
    expect(noaniq.review.some((m) => m.includes('naqsh'))).toBe(true); // noaniq izoh
    // Import paytida rahbarlarga xabar yuborilmaydi
    expect((await one(pool, 'SELECT count(*)::int AS n FROM notification')).n).toBe(0);
    const review = await one(pool, `SELECT count(*)::int AS n FROM sheet_sync_error WHERE kind = 'IMPORT_REVIEW'`);
    expect(review.n).toBeGreaterThan(0);
  });

  it('qayta import: o\'zgarmaganlar UNCHANGED', async () => {
    const r = await dryTx((db) => importTable(db, sheet(), { actorId: leader, dryRun: true }));
    expect(r.summary.created).toBe(0);
    expect(r.rows.find((x) => x.stir === '305123456')!.action).toBe('UNCHANGED');
  });

  it('X belgisi keyingi oylarda ham saqlanadi; faylda 1 kelsa olib tashlanadi', async () => {
    const c = (await one(pool, `SELECT id FROM client WHERE stir = '309567890'`)).id;
    await tx((db) => generatePeriod(db, '2026-11-01'));
    expect(await reportCodes(c, '2026-11-01')).not.toContain('AOS');
    const rows = sheet();
    rows[5][6] = '1';
    await tx((db) => importTable(db, rows, { actorId: leader, dryRun: false }));
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client_report_exclusion WHERE client_id = $1', [c])).n).toBe(0);
    expect(await reportCodes(c, '2026-10-01')).toContain('AOS');
  });
});

describe('Sheets import: bir xil faylni qayta yuklash', () => {
  let tok: string;
  let xlsx: Buffer;
  beforeAll(async () => {
    await resetDb();
    await seedTeam();
    tok = await token('leader');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Oktyabr').addRows(sheet());
    xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  });
  const upload = (dryRun: boolean, name = 'hisobot.xlsx') =>
    request(app).post(`/api/sheets/import?dryRun=${dryRun}`).set('Authorization', `Bearer ${tok}`).attach('file', xlsx, name);

  it('birinchi import yoziladi; qayta yuklash (boshqa nom bilan ham) 409, dry-run ogohlantiradi', async () => {
    const first = await upload(false);
    expect(first.status).toBe(200);
    expect(first.body.summary.created).toBe(5);
    expect(first.body.alreadyImported).toBeNull();

    const again = await upload(false, 'nusxa.xlsx');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('FILE_ALREADY_IMPORTED');
    expect(again.body.details).toMatchObject({ fileName: 'hisobot.xlsx', importedBy: 'Rahbar' });

    const dry = await upload(true);
    expect(dry.status).toBe(200);
    expect(dry.body.alreadyImported).toMatchObject({ fileName: 'hisobot.xlsx' });
    expect((await one(pool, 'SELECT count(*)::int AS n FROM sheet_import_file')).n).toBe(1);
  });

  it('sahifaga mos kelmagan fayl rad etiladi: hisobot fayli Buxgalter ishlari sahifasiga yuklanmaydi', async () => {
    const r = await request(app).post('/api/sheets/import?dryRun=true&kind=WORKS').set('Authorization', `Bearer ${tok}`).attach('file', xlsx, 'hisobot.xlsx');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'WRONG_FILE_KIND', details: { detected: 'REPORTS', expected: 'WORKS' } });
    const ok = await request(app).post('/api/sheets/import?dryRun=true&kind=REPORTS').set('Authorization', `Bearer ${tok}`).attach('file', xlsx, 'hisobot.xlsx');
    expect(ok.status).toBe(200);
    expect(ok.body.kind).toBe('REPORTS');
  });
});

// "Бухгалтер ишлари" fayli: ikki qatorli sarlavha, birlashtirilgan guruhlar
const WORKS_TOP = ['', 'СТИР', 'Номи', 'Солиқ тури', 'ойлик тулов', '30% (Бухгалтерлар улуши)', 'Жавобгар', 'Банк-ключ',
  'my.mehnat.uz', 'my.mehnat.uz', 'my.mehnat.uz', 'my.mehnat.uz', 'ИНПС ҳисобот', 'Иш  ҳақи', 'Банк виписка',
  'Счёт-фактура', 'Счёт-фактура', 'Дебетор-Кредитор', 'Ойлар ёпилиши', 'Бошқа ишлар', 'Изоҳ'];
const WORKS_SUB = [...WORKS_TOP];
WORKS_SUB.splice(8, 4, 'ходим сони', 'сана', 'логин', 'парол');
WORKS_SUB.splice(15, 2, 'кирим', 'Чиқим');

describe('Buxgalterni ism bo\'yicha topish', () => {
  const list = [
    toAccountant(1, 'Madaminov Sanjar'),
    toAccountant(2, "Uralov G'ulomjon"),
    toAccountant(3, 'Mustofaqulov Hoshim'),
    toAccountant(4, 'Mustofaqulov Abbos'),
    toAccountant(5, 'Ерқинов Ali'),
  ];
  const id = (raw: string) => {
    const a = matchAccountant(raw, list);
    return a && a !== 'AMBIGUOUS' ? a.id : a;
  };

  it('ism yoki familiya, kirill/lotin farqisiz', () => {
    expect(id('Санжар')).toBe(1);
    expect(id('Madaminov')).toBe(1);
    expect(id('Мадаминов Санжар')).toBe(1);
    expect(id('Sanjar Madaminov')).toBe(1);
    expect(id('Ғуломжон')).toBe(2);
    expect(id('Gʻulomjon')).toBe(2);
    expect(id('Хошим')).toBe(3);
    expect(id('Xoshim')).toBe(3);
    expect(id('Yerqinov')).toBe(5);
  });

  it('bir nechtasiga mos kelsa: ko\'proq so\'zi mos kelgani, teng bo\'lsa AMBIGUOUS', () => {
    expect(id('Mustofaqulov')).toBe('AMBIGUOUS');
    expect(id('Mustofaqulov Abbos')).toBe(4);
    expect(id('Номаълум')).toBeNull();
    expect(id('')).toBeNull();
  });
});

describe('"Бухгалтер ишлари" fayli importi', () => {
  let team: Awaited<ReturnType<typeof seedTeam>>;
  beforeAll(async () => {
    await resetDb();
    team = await seedTeam();
  });
  const works = () => [
    WORKS_TOP,
    WORKS_SUB,
    ['1', '2', '3', '4', '', '5', '', '6', '7', '8', '', '', '9', '10', '11', '12', '13', '19', '20', '', ''],
    ['11', '310309859', '"ALICOM" MCHJ', 'АОС', '1000000', '300000', 'Азиза', 'Бор', '3', '31.07.2025', 'jdev', 'Pa$$1',
      '2026-09-30', '2026-08-31', '', '2025-12-31', '2025-09-30', '', '', '', 'Эски даври бор'],
    ['', '', '"MIX" МЧЖ', '', '', '', 'Номаълум', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '63003046290049', 'OLIMOVA', 'YaTT', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];

  it('fayl turi aniqlanadi, mijoz maydonlari va "qaysi oygacha" yoziladi', async () => {
    const map = await detectWorksFile(pool, works());
    expect(map).not.toBeNull();
    expect(map!.headerRow).toBe(1);
    // Hisobot importi uni o'zi tanimaydi, yo'naltirish routes.ts'da
    const r = await tx((db) => importWorks(db, works(), map!, { actorId: team.leader, dryRun: false }));
    expect(r.kind).toBe('WORKS');
    // V24: YaTT ham mijoz bo'ladi (soliq turi aniqlanmagan), faqat STIRsiz qator o'tkaziladi
    expect(r.summary).toMatchObject({ total: 3, created: 2, skipped: 1 });
    expect(await one(pool, `SELECT tax_type, tax_type_raw FROM client WHERE stir = '63003046290049'`)).toEqual({ tax_type: null, tax_type_raw: 'YaTT' });
    const c = await one(
      pool,
      `SELECT id, accountant_id, monthly_fee::int AS fee, bank_key, employee_count, to_char(mehnat_checked_at, 'YYYY-MM-DD') AS checked,
              mehnat_login, mehnat_password_enc IS NOT NULL AS has_pw, note
       FROM client WHERE stir = '310309859'`,
    );
    expect(c).toMatchObject({ accountant_id: team.acc1, fee: 1000000, bank_key: true, employee_count: 3, checked: '2025-07-31', mehnat_login: 'jdev', has_pw: true, note: 'Эски даври бор' });
    const base = await q(
      pool,
      `SELECT w.name, to_char(b.done_through, 'YYYY-MM') AS m FROM client_routine_baseline b JOIN routine_work_type w ON w.id = b.routine_type_id
       WHERE b.client_id = $1`,
      [c.id],
    );
    const by = Object.fromEntries(base.map((b) => [b.name, b.m]));
    expect(by['Ish haqi hisoblash']).toBe('2026-08');
    expect(by['Kirim hisobvaraq-fakturalarini kiritish']).toBe('2025-12');
    expect(by['Bank aylanmalarini kiritish']).toBeUndefined(); // bo'sh katak
    expect(r.rows.find((x) => x.name.includes('MIX'))!.review).toContain("STIR yo'q");
    expect(r.rows.find((x) => x.stir === '63003046290049')!.review[0]).toContain('YaTT');
  });

  it('hisobot fayli Бухгалтер ишлари deb aniqlanmaydi', async () => {
    expect(await detectWorksFile(pool, sheet())).toBeNull();
  });
});

describe('Import: holat bo\'yicha hisobot ustunlari (Norezident foyda / QQS, V20)', () => {
  beforeAll(async () => {
    await resetDb();
    await seedTeam();
  });
  const H = ['№', 'STIR', 'Korxona nomi', 'Soliq turi', 'JSHDS 15.10.2026', 'Norezident foyda', 'Norezident QQS'];

  it('1 -> holat oyi (sentabr) belgisi qo\'yiladi va oktyabr vazifasi Bajarildi; X -> belgi yo\'q', async () => {
    const rows = [H, ['1', '306234567', 'INSAR MIX TRADE', 'ҚҚС', '1', '1', 'X']];
    const r = await tx((db) => importTable(db, rows, { actorId: null, dryRun: false }));
    expect(r.columns.map((c) => c.code)).toEqual(['JSHDS', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS']);
    expect(r.rows[0].review).toEqual([]);
    const ev = await q(
      pool,
      `SELECT rt.code, ev.month FROM client_report_event ev JOIN report_type rt ON rt.id = ev.report_type_id`,
    );
    expect(ev).toEqual([{ code: 'NOREZIDENT_FOYDA', month: '2026-09' }]);
    const t = await one(
      pool,
      `SELECT t.status FROM task t JOIN report_type rt ON rt.id = t.report_type_id
       WHERE rt.code = 'NOREZIDENT_FOYDA' AND t.period = '2026-10-01'`,
    );
    expect(t.status).toBe('DONE');
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client_report_exclusion')).n).toBe(0);
  });
});

describe('Import "boricha" (V24)', () => {
  let tok: string;
  beforeAll(async () => {
    await resetDb();
    await seedTeam();
    tok = await token('leader');
  });
  const H = ['№', 'STIR', 'Korxona nomi', 'Soliq turi', 'JSHDS 15.10.2026', 'AOS 15.10.2026', 'QQS 20.10.2026', 'FOYDA 20.10.2026', 'INPS', 'Қилиниши лозим бўлган ишлар'];
  const rows = () => [
    H,
    ['1', '51506076290041', 'ESHMURODOV BEKZOD YATT', 'ЯТТ', 'X', '1', 'X', 'X', 'X', ''],
    ['2', '310286184', '"FREE WAY TRADE" MCHJ', 'ҚҚС', '1', 'X', '1', '1', 'X', ''],
    ['3', '310286184', '"GIPER GROUP" МЧЖ', 'ҚҚС', '1', 'X', '1', '1', '0', ''],
    ['4', '313255030', '"SIBAUTO PARTS" MCHJ', 'АОС', '1', '1', 'X', 'X', '0', "01.11.2026 dan QQS to'lovchisi"],
    ['5', '310263388', '"MEGA LINK" МЧЖ', 'АОС', 'X', 'X', 'X', 'X', 'X', 'Login: emitent Parol: secret1'],
    ['6', '311463375', 'AMRULLO TOWN XK', 'АОС', 'X', 'X', 'X', 'X', 'X', 'Ketgan'],
    ['7', '#REF!', '"QIBRAY FARM" MCHJ', 'ҚҚС', '', '', '', '', '', ''],
  ];
  const cid = async (stir: string) => (await one(pool, 'SELECT id FROM client WHERE stir = $1', [stir])).id as number;

  it('tanilmagan tur: mijoz qo\'shiladi, vazifa yo\'q, kataklar jadvalda fayldagidek', async () => {
    const r = await tx((db) => importTable(db, rows(), { actorId: null, dryRun: false }));
    const yatt = r.rows.find((x) => x.stir === '51506076290041')!;
    expect(yatt.action).toBe('NEW');
    const c = await cid('51506076290041');
    expect(await one(pool, 'SELECT tax_type, tax_type_raw FROM client WHERE id = $1', [c])).toEqual({ tax_type: null, tax_type_raw: 'ЯТТ' });
    expect((await one(pool, 'SELECT count(*)::int AS n FROM task WHERE client_id = $1', [c])).n).toBe(0);
    const g = await request(app).get('/api/monthly-grid?month=2026-10').set('Authorization', `Bearer ${tok}`);
    const row = g.body.rows.find((x: any) => x.clientId === c);
    expect(row.taxType).toBeNull();
    expect(row.taxTypeRaw).toBe('ЯТТ');
    const byCode = Object.fromEntries(g.body.columns.map((col: any) => [col.code, row.cells[col.reportTypeId]?.raw]));
    expect(byCode).toMatchObject({ JSHDS: 'X', AOS: '1', QQS: 'X', INPS: 'X' });
  });

  it('takroriy STIR va #REF! qatorlari yozilmaydi, sababi ko\'rsatiladi', async () => {
    const r = await dryTx((db) => importTable(db, rows(), { actorId: null, dryRun: true }));
    expect(r.rows.find((x) => x.name.includes('GIPER'))!.review[0]).toContain('3-qatorda ham bor');
    expect(r.rows.find((x) => x.name.includes('QIBRAY'))!.review[0]).toContain('#REF!');
    // Boshqa nomli qator mavjud STIRga yozilmaydi
    const other = rows().slice(0, 1).concat([['1', '310286184', '"GIPER GROUP" МЧЖ', 'ҚҚС', '1', 'X', '1', '1', '0', '']]);
    const r2 = await dryTx((db) => importTable(db, other, { actorId: null, dryRun: true }));
    expect(r2.rows[0]).toMatchObject({ action: 'SKIPPED' });
    expect(r2.rows[0].review[0]).toContain('FREE WAY TRADE');
  });

  it('X istisnolari joriy oy vazifalariga ham qo\'llanadi', async () => {
    const c = await cid('310286184');
    const now = (await one(pool, `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent'), 'YYYY-MM-DD') AS p`)).p;
    expect(await reportCodes(c, now)).not.toContain('AOS');
    expect(await reportCodes(c, now)).not.toContain('INPS');
  });

  it('izohdagi kelajak sana bilan soliq turi rejalashtiriladi; parol izohga yozilmaydi; Ketgan -> Arxiv', async () => {
    const sib = await cid('313255030');
    const hist = await q(pool, `SELECT tax_type, to_char(effective_from, 'YYYY-MM-DD') AS f FROM client_tax_type_history WHERE client_id = $1 ORDER BY effective_from`, [sib]);
    expect(hist).toEqual([{ tax_type: 'AOS', f: '2000-01-01' }, { tax_type: 'QQS', f: '2026-11-01' }]);
    expect((await one(pool, `SELECT fn_client_tax_type($1, '2026-10-31') AS t`, [sib])).t).toBe('AOS');
    expect((await one(pool, `SELECT fn_client_tax_type($1, '2026-11-30') AS t`, [sib])).t).toBe('QQS');
    expect((await one(pool, 'SELECT note FROM client WHERE id = $1', [await cid('310263388')])).note).toBeNull();
    const amr = await cid('311463375');
    expect((await one(pool, 'SELECT status FROM client WHERE id = $1', [amr])).status).toBe('ARCHIVED');
    expect((await one(pool, `SELECT count(*)::int AS n FROM task WHERE client_id = $1 AND status IN ('TODO','IN_PROGRESS','WAITING_CLIENT')`, [amr])).n).toBe(0);
    // Arxiv standart ro'yxatda ko'rinmaydi
    const list = await request(app).get('/api/clients?pageSize=100').set('Authorization', `Bearer ${tok}`);
    expect(list.body.items.some((x: any) => x.id === amr)).toBe(false);
  });

  it('kartada soliq turi tanlanganda fayldagi kataklar o\'zi qo\'llanadi', async () => {
    const c = await cid('51506076290041');
    const r = await request(app).patch(`/api/clients/${c}`).set('Authorization', `Bearer ${tok}`).send({ taxType: 'AOS' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ taxType: 'AOS', taxTypeRaw: null, taxTypeEffectiveFrom: null });
    // Oktyabr: AOS = 1 -> Bajarildi; JSHDS/INPS = X -> istisno, vazifa yo'q
    const oct = await q(
      pool,
      `SELECT rt.code, t.status FROM task t JOIN report_type rt ON rt.id = t.report_type_id
       WHERE t.client_id = $1 AND t.period = '2026-10-01' AND t.kind = 'REPORT' AND t.status <> 'CANCELLED'`,
      [c],
    );
    expect(oct.find((x) => x.code === 'AOS')?.status).toBe('DONE');
    expect(oct.map((x) => x.code)).not.toContain('JSHDS');
    expect(oct.map((x) => x.code)).not.toContain('INPS');
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client_report_raw WHERE client_id = $1', [c])).n).toBe(0);
  });

  it('"Бухгалтер ишлари": tanilmagan ish katagi saqlanadi va oy kiritilganda o\'chadi', async () => {
    const c = await cid('310286184');
    const rows = [
      WORKS_TOP,
      WORKS_SUB,
      ['1', '310286184', '"FREE WAY TRADE" MCHJ', 'ҚҚС', '', '', '', '', '', '', '', '', 'eri', '1899-12-30', '', '28,02,2025(14)', '', '', '', '', ''],
    ];
    const map = await detectWorksFile(pool, rows);
    await tx((db) => importWorks(db, rows, map!, { actorId: null, dryRun: false }));
    const raw = await q(pool, `SELECT w.name, r.raw FROM client_routine_raw r JOIN routine_work_type w ON w.id = r.routine_type_id WHERE r.client_id = $1 ORDER BY w.sort_order`, [c]);
    expect(raw.map((x) => x.raw)).toEqual(['eri', '1899-12-30', '28,02,2025(14)']);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client_routine_baseline WHERE client_id = $1', [c])).n).toBe(0);
    const works = await request(app).get('/api/works?search=FREE').set('Authorization', `Bearer ${tok}`);
    const ishHaqi = works.body.columns.find((x: any) => x.name === 'Ish haqi hisoblash');
    expect(works.body.items[0].cells[ishHaqi.routineTypeId].raw).toBe('1899-12-30');
    const put = await request(app).put(`/api/works/${c}/${ishHaqi.routineTypeId}/baseline`).set('Authorization', `Bearer ${tok}`).send({ month: '2025-06' });
    expect(put.status).toBe(200);
    expect(put.body.raw).toBeNull();
  });
});
