import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { dryTx, tx } from '../src/db';
import { adoptRecognizedTaxTypes } from '../src/modules/clients';
import { importTable } from '../src/modules/sheets/importer';
import { detectWorksFile, importWorks, matchAccountant, toAccountant } from '../src/modules/sheets/worksImporter';
import { generatePeriod } from '../src/modules/generator';
import { api, app, one, pool, q, reportCodes, resetDb, seedTeam, token } from './helpers';

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

  it("force: rahbar ataylab qayta yuklaydi; shu korxonalarning eski \"Qo'lda tekshirish\" yozuvlari yopiladi", async () => {
    await pool.query(
      `INSERT INTO sheet_sync_error (kind, ref, stir, message, occurred_at, section) VALUES
         ('IMPORT_REVIEW', 'qator 2', '305123456', 'eski: mijoz qo''shilmadi', now() - interval '1 day', 'REPORTS'),
         ('IMPORT_REVIEW', 'qator 99', '999999999', 'boshqa fayl', now() - interval '1 day', 'REPORTS'),
         ('IMPORT_REVIEW', 'qator 5', '305123456', 'ishlar fayli', now() - interval '1 day', 'WORKS')`,
    );
    const r = await request(app).post('/api/sheets/import?dryRun=false&force=true').set('Authorization', `Bearer ${tok}`).attach('file', xlsx, 'hisobot.xlsx');
    expect(r.status).toBe(200);
    expect(r.body.summary.created).toBe(0);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM sheet_import_file')).n).toBe(1);
    const open = await q(pool, `SELECT stir, message FROM sheet_sync_error WHERE NOT resolved`);
    expect(open.some((x) => x.message.startsWith('eski'))).toBe(false);
    expect(open.some((x) => x.stir === '999999999')).toBe(true); // fayldagi korxona emas — tegilmaydi
    expect(open.some((x) => x.message === 'ishlar fayli')).toBe(true); // Buxgalter ishlari kamchiligi — hisobot importi yopmaydi
    // Ro'yxatda korxona kartasiga havola uchun clientId
    const list = await request(app).get('/api/sheets/review').set('Authorization', `Bearer ${tok}`);
    expect(list.body.find((x: any) => x.stir === '309567890')?.clientId).toBeTruthy();
    // Har sahifa faqat o'z jadvali kamchiliklarini oladi (V27)
    const reports = await request(app).get('/api/sheets/review?kind=REPORTS').set('Authorization', `Bearer ${tok}`);
    const works = await request(app).get('/api/sheets/review?kind=WORKS').set('Authorization', `Bearer ${tok}`);
    expect(reports.body.some((x: any) => x.message === 'ishlar fayli')).toBe(false);
    expect(works.body.map((x: any) => x.message)).toEqual(['ishlar fayli']);
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
    // V33: YaTT soliq turi sifatida taniladi; V26: STIRsiz qator ham mijoz bo'ladi (STIR'siz mijoz)
    expect(r.summary).toMatchObject({ total: 3, created: 3, skipped: 0 });
    expect(await one(pool, `SELECT stir, stir_raw FROM client WHERE name LIKE '%MIX%'`)).toEqual({ stir: null, stir_raw: null });
    expect(await one(pool, `SELECT tax_type, tax_type_raw FROM client WHERE stir = '63003046290049'`)).toEqual({ tax_type: 'YATT', tax_type_raw: null }); // YaTT — uchinchi soliq turi (V33)
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
    expect(r.rows.find((x) => x.name.includes('MIX'))!.review[0]).toContain("STIR yo'q");
    expect(r.rows.find((x) => x.stir === '63003046290049')!.review.some((m) => m.includes('Soliq turi'))).toBe(false); // YaTT tanildi (V33)
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

  it('1 -> holat oyi (oktyabr, V36: katak oyi) belgisi qo\'yiladi va oktyabr vazifasi Bajarildi; X -> belgi yo\'q', async () => {
    const rows = [H, ['1', '306234567', 'INSAR MIX TRADE', 'ҚҚС', '1', '1', 'X']];
    const r = await tx((db) => importTable(db, rows, { actorId: null, dryRun: false }));
    expect(r.columns.map((c) => c.code)).toEqual(['JSHDS', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS']);
    expect(r.rows[0].review).toEqual([]);
    const ev = await q(
      pool,
      `SELECT rt.code, ev.month FROM client_report_event ev JOIN report_type rt ON rt.id = ev.report_type_id`,
    );
    expect(ev).toEqual([{ code: 'NOREZIDENT_FOYDA', month: '2026-10' }]);
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
    ['1', '51506076290041', 'ESHMURODOV BEKZOD YATT', 'Қ АОС', 'X', '1', 'X', 'X', 'X', ''],
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
    expect(await one(pool, 'SELECT tax_type, tax_type_raw FROM client WHERE id = $1', [c])).toEqual({ tax_type: null, tax_type_raw: 'Қ АОС' });
    expect((await one(pool, 'SELECT count(*)::int AS n FROM task WHERE client_id = $1', [c])).n).toBe(0);
    const g = await request(app).get('/api/monthly-grid?month=2026-10').set('Authorization', `Bearer ${tok}`);
    const row = g.body.rows.find((x: any) => x.clientId === c);
    expect(row.taxType).toBeNull();
    expect(row.taxTypeRaw).toBe('Қ АОС');
    const byCode = Object.fromEntries(g.body.columns.map((col: any) => [col.code, row.cells[col.reportTypeId]?.raw]));
    expect(byCode).toMatchObject({ JSHDS: 'X', AOS: '1', QQS: 'X', INPS: 'X' });
  });

  it("V33'gacha yuklangan \"ЯТТ\" (tanilmagan) ishga tushishda o'zi YaTT bo'ladi, fayl kataklari qo'llanadi", async () => {
    // V33'gacha holat: tur bo'sh, fayldagi matn kirillda (endi import ЯТТ'ni taniydi — shuning uchun qo'lda)
    await tx((db) => importTable(db, [rows()[0], ['1', '51506076290042', 'ESKI YATT', 'Қ АОС', 'X', '1', 'X', 'X', 'X', '']], { actorId: null, dryRun: false }));
    const c = await cid('51506076290042');
    await pool.query("UPDATE client SET tax_type_raw = 'ЯТТ' WHERE id = $1", [c]);
    expect(await adoptRecognizedTaxTypes()).toBeGreaterThanOrEqual(1);
    expect(await one(pool, 'SELECT tax_type, tax_type_raw FROM client WHERE id = $1', [c])).toEqual({ tax_type: 'YATT', tax_type_raw: null });
    const g = await request(app).get('/api/monthly-grid?month=2026-10').set('Authorization', `Bearer ${tok}`);
    const row = g.body.rows.find((x: any) => x.clientId === c);
    const byCode = Object.fromEntries(g.body.columns.map((col: any) => [col.code, row.cells[col.reportTypeId]?.state]));
    expect(byCode).toMatchObject({ AOS: '1', JSHDS: 'X', QQS: 'X', INPS: 'X' });
    // Takror chaqirilsa hech narsa qilmaydi
    expect(await adoptRecognizedTaxTypes()).toBe(0);
  });

  it('takroriy STIR va #REF! qatorlari STIR\'siz mijoz bo\'lib yoziladi (V26), sababi ko\'rsatiladi, kamchilik mijozga bog\'lanadi', async () => {
    const giper = await one(pool, `SELECT id, stir, stir_raw FROM client WHERE name LIKE '%GIPER%'`);
    expect(giper).toMatchObject({ stir: null, stir_raw: '310286184' });
    const qibray = await one(pool, `SELECT id, stir, stir_raw FROM client WHERE name LIKE '%QIBRAY%'`);
    expect(qibray).toMatchObject({ stir: null, stir_raw: '#REF!' });
    // STIR birinchi qatorda qoladi, mavjud mijoz ustidan yozilmaydi
    expect((await one(pool, `SELECT name FROM client WHERE stir = '310286184'`)).name).toContain('FREE WAY TRADE');
    const rev = await q(pool, `SELECT client_id, message FROM sheet_sync_error WHERE client_id = ANY ($1::bigint[])`, [[giper.id, qibray.id]]);
    expect(rev.some((x) => x.client_id === giper.id && x.message.includes('3-qatorda ham bor'))).toBe(true);
    expect(rev.some((x) => x.client_id === giper.id && x.message.includes("STIR'siz qo'shildi"))).toBe(true);
    expect(rev.some((x) => x.client_id === qibray.id && x.message.includes('#REF!'))).toBe(true);
    // Jadvalda ham ko'rinadi (boricha)
    const g = await request(app).get('/api/monthly-grid').set('Authorization', `Bearer ${tok}`);
    expect(g.body.rows.find((x: any) => x.clientId === qibray.id)).toMatchObject({ stir: null, stirRaw: '#REF!' });

    // Qayta import dublikat yaratmaydi: STIR'siz mijoz nomi bo'yicha topiladi
    const n = (await one(pool, 'SELECT count(*)::int AS n FROM client')).n;
    const r = await dryTx((db) => importTable(db, rows(), { actorId: null, dryRun: true }));
    expect(r.summary.created).toBe(0);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client')).n).toBe(n);

    // Boshqa nomli qator mavjud STIRga yozilmaydi, STIR'siz alohida mijoz bo'ladi
    const other = rows().slice(0, 1).concat([['1', '310286184', '"YANGI NOM" МЧЖ', 'ҚҚС', '1', 'X', '1', '1', '0', '']]);
    const r2 = await dryTx((db) => importTable(db, other, { actorId: null, dryRun: true }));
    expect(r2.rows[0]).toMatchObject({ action: 'NEW' });
    expect(r2.rows[0].review[0]).toContain('FREE WAY TRADE');
    // Faylda boshqa firmaning STIRi, firma esa tizimda bor (GIPER): nomi bo'yicha o'shanga bog'lanadi, dublikat yo'q
    const giperAgain = rows().slice(0, 1).concat([['1', '310286184', '"GIPER GROUP" МЧЖ', 'ҚҚС', '1', 'X', '1', '1', '0', '']]);
    const r3 = await dryTx((db) => importTable(db, giperAgain, { actorId: null, dryRun: true }));
    expect(r3.rows[0].action).not.toBe('NEW');
    expect(r3.rows[0].clientId).toBe(giper.id);

    // Kartada STIR kiritilsa stir_raw tozalanadi
    const p = await request(app).patch(`/api/clients/${qibray.id}`).set('Authorization', `Bearer ${tok}`).send({ stir: '309999999' });
    expect(p.status).toBe(200);
    expect(await one(pool, 'SELECT stir, stir_raw FROM client WHERE id = $1', [qibray.id])).toEqual({ stir: '309999999', stir_raw: null });
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

describe("Bo'limlar alohida yuklanadi (V25)", () => {
  let L: ReturnType<typeof api>;
  let leader: number;
  beforeAll(async () => {
    await resetDb();
    leader = (await seedTeam()).leader;
    L = api(await token('leader'));
  });
  const reportRow = (n: string, stir: string, name: string) => [n, stir, name, 'AOC', '0', '0', '0', 'X', 'X', '0', '0', ''];
  const worksRow = (stir: string, name: string) =>
    ['1', stir, name, 'АОС', '1000000', '300000', 'Азиза', 'Бор', '3', '', '', '', '', '', '', '', '', '', '', '', ''];
  const worksFile = (...rows: unknown[][]) => [WORKS_TOP, WORKS_SUB, ...rows];
  const importWorksFile = async (rows: unknown[][]) => {
    const map = (await detectWorksFile(pool, rows))!;
    return tx((db) => importWorks(db, rows, map, { actorId: leader, dryRun: false }));
  };
  const flags = (stir: string) => one(pool, 'SELECT in_reports, in_works FROM client WHERE stir = $1', [stir]);
  const openKinds = async (stir: string) =>
    (await q<{ kind: string }>(
      pool,
      `SELECT DISTINCT t.kind FROM task t JOIN client c ON c.id = t.client_id WHERE c.stir = $1 AND t.status <> 'CANCELLED' ORDER BY 1`,
      [stir],
    )).map((r) => r.kind);
  const worksNames = async () => (await L.get('/api/works?pageSize=500')).body.items.map((r: any) => r.name);
  const gridNames = async () => (await L.get('/api/monthly-grid')).body.rows.map((r: any) => r.name);

  it("hisobot jadvalidan yuklangan mijoz Buxgalter ishlarida ko'rinmaydi va oylik ish chiqmaydi", async () => {
    await tx((db) => importTable(db, [HEADER, reportRow('1', '305123456', 'SHERPROM STROY')], { actorId: leader, dryRun: false }));
    expect(await flags('305123456')).toEqual({ in_reports: true, in_works: false });
    expect(await gridNames()).toContain('SHERPROM STROY');
    expect(await worksNames()).not.toContain('SHERPROM STROY');
    expect(await openKinds('305123456')).toEqual(['REPORT']);
  });

  it("«Бухгалтер ишлари» faylidan yuklangan mijoz Hisobot topshirishda ko'rinmaydi, hisobot chiqmaydi, INPS doimiy ish", async () => {
    await importWorksFile(worksFile(worksRow('310309859', '"ALICOM" MCHJ')));
    expect(await flags('310309859')).toEqual({ in_reports: false, in_works: true });
    expect(await worksNames()).toContain('"ALICOM" MCHJ');
    expect(await gridNames()).not.toContain('"ALICOM" MCHJ');
    expect(await openKinds('310309859')).toEqual(['ROUTINE']);
    const inps = await one(
      pool,
      `SELECT count(*)::int AS n FROM task t JOIN client c ON c.id = t.client_id JOIN routine_work_type w ON w.id = t.routine_type_id
       WHERE c.stir = '310309859' AND w.report_type_id IS NOT NULL AND t.status <> 'CANCELLED'`,
    );
    expect(inps.n).toBe(1);
  });

  it('bir xil STIR ikkinchi bo\'lim faylida kelsa — bitta mijoz, ikkala bo\'limda, ma\'lumot bog\'liq', async () => {
    await importWorksFile(worksFile(worksRow('305123456', 'SHERPROM STROY')));
    expect(await flags('305123456')).toEqual({ in_reports: true, in_works: true });
    expect(await worksNames()).toContain('SHERPROM STROY');
    expect(await openKinds('305123456')).toEqual(['REPORT', 'ROUTINE']);

    await tx((db) => importTable(db, [HEADER, reportRow('1', '310309859', '"ALICOM" MCHJ')], { actorId: leader, dryRun: false }));
    expect(await flags('310309859')).toEqual({ in_reports: true, in_works: true });
    expect(await gridNames()).toContain('"ALICOM" MCHJ');
    // INPS endi hisobot vazifasi: ikki marta yaratilmaydi
    const inps = await q(
      pool,
      `SELECT t.kind FROM task t JOIN client c ON c.id = t.client_id
       LEFT JOIN routine_work_type w ON w.id = t.routine_type_id LEFT JOIN report_type rt ON rt.id = t.report_type_id
       WHERE c.stir = '310309859' AND t.period = date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent')::date
         AND t.status <> 'CANCELLED' AND (rt.code = 'INPS' OR w.report_type_id IS NOT NULL)`,
    );
    expect(inps).toHaveLength(1);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM client')).n).toBe(2);
  });
});

describe("Qo'lda tekshirish: kartada tuzatilsa o'zi yopiladi (V28)", () => {
  let tok: string;
  let clientId: number;
  const open = async () => (await q(pool, `SELECT message FROM sheet_sync_error WHERE client_id = $1 AND NOT resolved ORDER BY id`, [clientId])).map((x) => x.message);

  beforeAll(async () => {
    await resetDb();
    const { leader } = await seedTeam();
    tok = await token('leader');
    // Soliq turi tanilmagan mijoz: importdan kamchiliklar yoziladi
    await tx((db) => importTable(db, [HEADER, ['1', '305123456', 'TEST MCHJ', 'Қ АОС', '0', '0', '0', '0', '0', '0', '0', '']], { actorId: leader, dryRun: false }));
    clientId = (await one(pool, `SELECT id FROM client WHERE stir = '305123456'`)).id;
    await pool.query(
      `INSERT INTO sheet_sync_error (kind, ref, stir, message, client_id, section, fields) VALUES
         ('IMPORT_REVIEW', 'qator 2', '305123456', 'TEST MCHJ: Oylik to''lov tanilmadi: "ko''p"', $1, 'WORKS', '{monthlyFee}'),
         ('IMPORT_REVIEW', 'qator 2', '305123456', 'TEST MCHJ: Nomi bo''yicha tizimdagi mijozga bog''landi — tekshiring', $1, 'WORKS', '{}')`,
      [clientId],
    );
  });

  it('xabar matnidan maydon aniqlanadi', async () => {
    const { reviewFields } = await import('../src/modules/sheets/review');
    expect(reviewFields('Soliq turi hali aniqlanmagan — kartada tanlang')).toEqual(['taxType']);
    expect(reviewFields("STIR tizimda boshqa mijozga tegishli (\"X\")")).toEqual(['name', 'stir']);
    expect(reviewFields('Izohda login/parol bor')).toEqual([]);
    expect(reviewFields('INPS hisoboti: sana tanilmadi "eri"')).toEqual(['routine:INPS hisoboti']);
    const tax = await one(pool, `SELECT fields FROM sheet_sync_error WHERE client_id = $1 AND message LIKE '%Soliq turi%'`, [clientId]);
    expect(tax.fields).toEqual(['taxType']);
  });

  it("jadval katagidagi tahrir faqat o'z maydonini yopadi, \"tekshiring\" qoladi", async () => {
    const before = await open();
    expect(before.some((m) => m.includes('Soliq turi'))).toBe(true);
    expect((await api(tok).patch(`/api/clients/${clientId}`, { note: 'yangi izoh' })).status).toBe(200);
    expect(await open()).toEqual(before);
    expect((await api(tok).patch(`/api/clients/${clientId}`, { monthlyFee: 500000 })).status).toBe(200);
    const after = await open();
    expect(after.some((m) => m.includes("Oylik to'lov"))).toBe(false);
    expect(after.some((m) => m.includes('tekshiring'))).toBe(true);
  });

  it("karta to'liq saqlansa: tuzatilgan maydon va \"tekshiring\" yopiladi, tuzatilmagani qoladi", async () => {
    expect((await api(tok).patch(`/api/clients/${clientId}`, { name: 'TEST MCHJ', reviewed: true })).status).toBe(200);
    const left = await open();
    expect(left.some((m) => m.includes('tekshiring'))).toBe(false);
    expect(left.some((m) => m.includes('Soliq turi'))).toBe(true); // tur hali tanlanmagan
    expect((await api(tok).patch(`/api/clients/${clientId}`, { taxType: 'AOS', reviewed: true })).status).toBe(200);
    const now = await open();
    expect(now.some((m) => m.includes('Soliq turi'))).toBe(false);
    // Tur tanlangach fayldagi kataklar qo'llandi: AOS'da topshirilmaydigan katakda 0 — fayldagidek qo'yiladi, ⚠ bilan
    expect(now.length).toBeGreaterThan(0);
    expect(now.every((m) => m.includes("fayldagidek qo'yildi"))).toBe(true);
  });
});

describe('Hisobot jadvali fayl boricha: CRM jadvalida fayldagi qiymat', () => {
  let L: ReturnType<typeof api>;
  beforeAll(async () => {
    await resetDb();
    await seedTeam();
    L = api(await token('leader'));
  });
  // AOS: QQS va FOYDA qoida bo'yicha X, lekin faylda 0 / 1; JSHDS katagida tanilmagan matn
  const row = (tolov: string) => ['1', '305999999', 'BORICHA MCHJ', 'AOC', 'abc', tolov, '0', '0', '1', '0', '0', ''];
  const cells = async () => {
    const g = (await L.get('/api/monthly-grid?month=2026-10')).body;
    const r = g.rows.find((x: any) => x.stir === '305999999');
    return Object.fromEntries(g.columns.map((c: any) => [c.code, r.cells[c.reportTypeId]]));
  };

  it("soliq turiga zid 0/1 fayldagidek, tanilmagan matn katakda boricha", async () => {
    await tx((db) => importTable(db, [HEADER, row('1')], { actorId: null, dryRun: false }));
    const c = await cells();
    expect(['0', '!']).toContain(c.QQS.state); // ochiq (oktyabr o'tgan: muddati o'tgan)
    expect(c.FOYDA.state).toBe('1');
    expect(c.JSHDS.raw).toBe('abc');
    expect(c.TOLOV_MANBAI.state).toBe('1');
  });

  it('bajarilgan katakda faylda 0 — qayta ochiladi', async () => {
    await tx((db) => importTable(db, [HEADER, row('0')], { actorId: null, dryRun: false }));
    expect((await cells()).TOLOV_MANBAI.state).not.toBe('1');
  });

  it('rahbar tanilmagan katakka 1/0/X tanlasa matn o\'chadi', async () => {
    const g = (await L.get('/api/monthly-grid?month=2026-10')).body;
    const r = g.rows.find((x: any) => x.stir === '305999999');
    const col = g.columns.find((c: any) => c.code === 'JSHDS');
    expect((await L.put('/api/monthly-grid/cell').send({ clientId: r.clientId, reportTypeId: col.reportTypeId, month: '2026-10', value: '0' })).status).toBe(200);
    expect((await cells()).JSHDS.raw).toBeUndefined();
  });
});
