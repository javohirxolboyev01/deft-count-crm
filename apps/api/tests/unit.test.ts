import { describe, expect, it } from 'vitest';
import { normalizeName, normalizeStir, normalizeTaxType } from '../src/common/normalize';
import { cellText, detectColumns, hasSecret, parseCell, parseDate, parseNote, sameCompany } from '../src/modules/sheets/parse';

describe('normalizatsiya', () => {
  it('kirill/lotin va MChJ/МЧЖ bir xil shaklga keladi', () => {
    expect(normalizeName('"Navro\'z Agro" МЧЖ')).toBe(normalizeName('NAVROZ AGRO MChJ'));
    expect(normalizeName('ООО Ромашка')).toBe('mchj romashka');
    expect(normalizeName('SHERPROM  STROY MCHJ')).toBe('sherprom stroy mchj');
  });

  it('soliq turi: AOC/AOS/АОС/ҚҚС/QQS', () => {
    expect(normalizeTaxType('AOC')).toBe('AOS');
    expect(normalizeTaxType('АОС')).toBe('AOS');
    expect(normalizeTaxType('aos')).toBe('AOS');
    expect(normalizeTaxType('ҚҚС')).toBe('QQS');
    expect(normalizeTaxType('QQS')).toBe('QQS');
    expect(normalizeTaxType('ЯТТ')).toBe('YATT');
    expect(normalizeTaxType('YaTT')).toBe('YATT');
    expect(normalizeTaxType('Қ АОС')).toBeNull();
    expect(normalizeTaxType('boshqa')).toBeNull();
  });

  it('STIR faqat raqam', () => {
    expect(normalizeStir(' 305 123 456 ')).toBe('305123456');
  });
});

describe('izohni ajratish', () => {
  it('"Tugatishga bergan" -> LIQUIDATING, izoh bo\'sh', () => {
    expect(parseNote('Tugatishga bergan')).toMatchObject({ status: 'LIQUIDATING', note: null, review: null });
  });
  it('"01.01.2026 dan AOS to\'lovchisi" -> effective_from', () => {
    expect(parseNote("01.01.2026 dan AOS to'lovchisi")).toMatchObject({
      taxType: 'AOS',
      effectiveFrom: '2026-01-01',
      note: null,
      review: null,
    });
  });
  it('kirillcha izoh ham tushuniladi', () => {
    expect(parseNote('01.07.2026 дан ҚҚС тўловчиси')).toMatchObject({ taxType: 'QQS', effectiveFrom: '2026-07-01' });
  });
  it('oddiy matn -> note', () => {
    expect(parseNote('Direktor bilan gaplashish kerak')).toMatchObject({ note: 'Direktor bilan gaplashish kerak', review: null });
  });
  it('soliq turi tilga olingan, lekin naqshga mos emas -> qo\'lda tekshirish', () => {
    const r = parseNote("QQS ga o'tishi mumkin");
    expect(r.review).not.toBeNull();
    expect(r.effectiveFrom).toBeNull();
  });
  it('oddiy sana ("da ochilgan") -> izoh, tekshirish shart emas', () => {
    expect(parseNote('05.03.2026 da ochilgan')).toMatchObject({ note: '05.03.2026 da ochilgan', review: null, status: null });
  });
  it('Ketgan / Керак эмас -> Arxiv, bankrot -> Tugatilmoqda', () => {
    expect(parseNote('Ketgan')).toMatchObject({ status: 'ARCHIVED', note: null });
    expect(parseNote('Керак эмас')).toMatchObject({ status: 'ARCHIVED' });
    expect(parseNote('ketgan  ferma')).toMatchObject({ status: 'ARCHIVED', note: 'ketgan  ferma' });
    expect(parseNote('bankrot')).toMatchObject({ status: 'LIQUIDATING' });
    expect(parseNote('Нол')).toMatchObject({ status: 'ZERO_REPORT' });
  });
});

describe('fayl qiymatlari (V24)', () => {
  it('sana: vergulli, Excel raqami; Excel "0" (1899) va izohli matn sana emas', () => {
    expect(parseDate('13,02,2026')).toBe('2026-02-13');
    expect(parseDate('45900')).toBe('2025-08-31');
    expect(parseDate('1899-12-30')).toBeNull();
    expect(parseDate('28,02,2025(14)')).toBeNull();
    expect(parseDate('eri')).toBeNull();
  });
  it('formula xatosi matn bo\'lib chiqadi', () => {
    expect(cellText({ formula: 'A1', result: { error: '#REF!' } })).toBe('#REF!');
  });
  it('nom bir mijozga tegishlimi', () => {
    expect(sameCompany('"LABIN" МЧЖ', '"KIMYO EXPRESS" МЧЖ (LABIN)')).toBe(true);
    expect(sameCompany('"GIPER GROUP" МЧЖ', '"FREE WAY TRADE" MCHJ')).toBe(false);
  });
  it('izohdagi login/parol aniqlanadi', () => {
    expect(hasSecret('Login: abc Parol: xyz')).toBe(true);
    expect(hasSecret('Логин: sales пароль: 1')).toBe(true);
    expect(hasSecret('Ishchilarni olish kerak')).toBe(false);
  });
});

describe('sarlavha bo\'yicha ustun aniqlash', () => {
  const types = [
    { id: 1, code: 'JSHDS', sheetAliases: ['JSHDS'] },
    { id: 2, code: 'TOLOV_MANBAI', sheetAliases: ['TOLOVMANBA'] },
    { id: 3, code: 'AOS', sheetAliases: ['AOS', 'AOC'] },
    { id: 4, code: 'QQS', sheetAliases: ['QQS', 'KKS'] },
    { id: 5, code: 'INPS', sheetAliases: ['INPS'] },
    { id: 6, code: 'PORUCHENYA_JSHDS', sheetAliases: ['PORUCH'] },
    { id: 7, code: 'FOYDA', sheetAliases: ['FOYDA'] },
  ];
  it('haqiqiy jadval sarlavhasi (ustunlar tartibi aralash)', () => {
    const rows = [
      ['Hisobotlar 2026'],
      ['№', 'СТИР', 'Korxona nomi', 'Солиқ тури', 'QQS 20.10.2026', 'JSHDS 15.10.2026', "To'lov manbai 15.10.2026",
        'AOC 15.10.2026', 'FOYDA 20.10.2026', 'INPS', 'Poruchenya JSHDS', 'Қилиниши лозим бўлган ишлар'],
      ['1', '305123456', 'SHERPROM STROY', 'AOS', 'X', '1', '0', '1', 'X', '0', '', ''],
    ];
    const m = detectColumns(rows, types)!;
    expect(m.headerRow).toBe(1);
    expect(m.stir).toBe(1);
    expect(m.name).toBe(2);
    expect(m.taxType).toBe(3);
    expect(m.note).toBe(11);
    expect(m.period).toBe('2026-10-01');
    const byCode = Object.fromEntries(m.reports.map((r) => [r.code, r.col]));
    expect(byCode).toEqual({ QQS: 4, JSHDS: 5, TOLOV_MANBAI: 6, AOS: 7, FOYDA: 8, INPS: 9, PORUCHENYA_JSHDS: 10 });
  });

  it('katak qiymatlari', () => {
    expect(parseCell('1')).toBe('1');
    expect(parseCell(1)).toBe('1');
    expect(parseCell('✓')).toBe('1');
    expect(parseCell('0')).toBe('0');
    expect(parseCell('Х')).toBe('X'); // kirillcha Х
    expect(parseCell('—')).toBe('X');
    expect(parseCell('')).toBe('');
    expect(parseCell('ha')).toBeNull();
  });
});
