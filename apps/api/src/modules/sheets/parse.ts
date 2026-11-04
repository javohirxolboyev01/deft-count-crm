import { headerKey, normalizeName, transliterate } from '../../common/normalize';

// Sarlavha MATNI bo'yicha ustun aniqlash (indeks bo'yicha emas): sanalar har oy o'zgaradi,
// kirill/lotin aralash bo'lishi mumkin. Hisobot kalit so'zlari report_type.sheet_aliases'dan.

export interface ReportTypeLite {
  id: number;
  code: string;
  sheetAliases: string[];
}

export interface ReportColumn {
  col: number;
  reportTypeId: number;
  code: string;
  header: string;
  dueDate: string | null;
}

export interface ColumnMap {
  headerRow: number;
  stir: number;
  name: number | null;
  taxType: number | null;
  note: number | null;
  reports: ReportColumn[];
  /** Sarlavhadagi sanadan aniqlangan davr ('YYYY-MM-01') */
  period: string | null;
  /** Tanilmagan sarlavhalar: ma'lumoti yuklanmaydi, import hisobotida ko'rsatiladi (jim yo'qolmasin) */
  ignored: string[];
}

const has = (k: string, ...parts: string[]) => parts.some((p) => k.includes(p));

function classify(header: string, types: ReportTypeLite[]) {
  const k = headerKey(header);
  if (!k) return null;
  if (k === 'STIR' || k === 'INN' || k.startsWith('STIR') || k.startsWith('INN')) return { kind: 'STIR' as const };
  if (has(k, 'KORXONANOMI', 'NOMI', 'NAZVANIE', 'NAIMENOVANIE')) return { kind: 'NAME' as const };
  if (has(k, 'SOLIQTURI', 'VIDNALOG', 'TIPNALOG')) return { kind: 'TAX' as const };
  if (has(k, 'QILINISHI', 'LOZIM', 'IZOH', 'PRIMECHAN')) return { kind: 'NOTE' as const };
  // Eng uzun mos kalit so'z yutadi: "Poruchenya JSHDS" -> PORUCH, "JSHDS" emas
  let best: { t: ReportTypeLite; len: number } | null = null;
  for (const t of types) {
    for (const a of t.sheetAliases) {
      const ak = headerKey(a);
      if (ak && k.includes(ak) && (!best || ak.length > best.len)) best = { t, len: ak.length };
    }
  }
  return best ? { kind: 'REPORT' as const, type: best.t } : null;
}

function headerDate(header: string): string | null {
  const m = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(header);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    // Formula xatosi (#REF!, #N/A): natija { error: '#REF!' }
    if (o.result !== undefined) return o.result && typeof o.result === 'object' && 'error' in o.result ? String(o.result.error) : String(o.result);
    if (o.error !== undefined) return String(o.error);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

export function detectColumns(rows: unknown[][], types: ReportTypeLite[]): ColumnMap | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r] ?? [];
    const map: ColumnMap = { headerRow: r, stir: -1, name: null, taxType: null, note: null, reports: [], period: null, ignored: [] };
    row.forEach((raw, col) => {
      const header = cellText(raw).trim();
      const c = classify(header, types);
      if (!c) {
        // "№", "," va raqamli ustun sarlavhalari ma'lumot ustuni emas
        if (/[A-Z]/.test(headerKey(header))) map.ignored.push(header);
        return;
      }
      if (c.kind === 'STIR' && map.stir < 0) map.stir = col;
      else if (c.kind === 'NAME' && map.name === null) map.name = col;
      else if (c.kind === 'TAX' && map.taxType === null) map.taxType = col;
      else if (c.kind === 'NOTE' && map.note === null) map.note = col;
      else if (c.kind === 'REPORT' && !map.reports.some((x) => x.reportTypeId === c.type.id)) {
        map.reports.push({ col, reportTypeId: c.type.id, code: c.type.code, header, dueDate: headerDate(header) });
      }
    });
    if (map.stir >= 0 && map.reports.length >= 1) {
      // TODO(tasdiqlash): davr = sarlavhadagi muddat sanasi oyi (15.10 -> oktyabr), CLAUDE.md 10.4
      const d = map.reports.find((x) => x.dueDate)?.dueDate;
      map.period = d ? `${d.slice(0, 7)}-01` : null;
      return map;
    }
  }
  return null;
}

export type SheetCell = '1' | '0' | 'X' | '';

/** 1/0/X (va ✓ ○ — kabi ko'rinishlar). null = tanib bo'lmaydigan qiymat */
export function parseCell(raw: unknown): SheetCell | null {
  const s = cellText(raw).trim();
  if (s === '') return '';
  if (['1', '✓', '✔', '+', '1.0'].includes(s)) return '1';
  if (['0', '○', '0.0'].includes(s)) return '0';
  if (['X', 'x', 'Х', 'х', '—', '–', '-', '×'].includes(s)) return 'X';
  return null;
}

export interface ParsedNote {
  status: 'LIQUIDATING' | 'ZERO_REPORT' | 'ARCHIVED' | null;
  taxType: 'AOS' | 'QQS' | 'YATT' | null;
  effectiveFrom: string | null;
  note: string | null;
  /** Avtomatik ajratib bo'lmadi: qo'lda tekshirish */
  review: string | null;
}

/**
 * Oxirgi ustun izohi -> status / tax_type_effective_from / note.
 * Aniq naqshga tushmagan, lekin sana yoki soliq turi tilga olingan izohlar jim taxmin qilinmaydi: review.
 */
export function parseNote(raw: unknown): ParsedNote {
  const text = cellText(raw).trim();
  const res: ParsedNote = { status: null, taxType: null, effectiveFrom: null, note: null, review: null };
  if (!text) return res;
  let rest = transliterate(text).toLowerCase().replace(/[‘’ʻʼ`´]/g, "'");
  const original = rest;

  // TODO(tasdiqlash): "bankrot" = Tugatilmoqda, "Ketgan" / "Kerak emas" = Arxiv (firma bilan ishlamaydi)
  if (/tugat|likvid|ликвид|bankrot/.test(rest)) {
    res.status = 'LIQUIDATING';
    rest = rest.replace(/tugatishga\s*(berilgan|bergan|topshirilgan|topshirgan)?|tugatil\S*|likvidats\S*|bankrot\S*/g, ' ');
  } else if (/\bketgan\b|\bkerak\s+emas\b/.test(rest)) {
    res.status = 'ARCHIVED';
    rest = rest.replace(/\bketgan\b|\bkerak\s+emas\b/g, ' ');
  } else if (/\bnol\b|\bnolga\b|nolev|nulev|nol hisobot/.test(rest)) {
    res.status = 'ZERO_REPORT';
    rest = rest.replace(/nol\s*(hisobot\S*)?|nulev\S*|nolev\S*/g, ' ');
  }

  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(?:y\.?|yil\S*)?\s*(?:dan|dən|s)?\s*(aos|aoc|qqs|kks|nds)\b/.exec(rest);
  if (m) {
    res.effectiveFrom = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    res.taxType = /^(aos|aoc)$/.test(m[4]) ? 'AOS' : 'QQS';
    rest = rest.replace(m[0], ' ').replace(/to'?lovchi\S*|tolovchi\S*|platel\S*|bo'?ldi|o'?tdi|ga\b/g, ' ');
  } else if (/\b(aos|aoc|qqs|kks)\b/.test(rest)) {
    // Oddiy sana ("05.03.2026 da ochilgan") izoh bo'lib qoladi; faqat soliq turi tilga olinsa tekshirish kerak
    res.review = 'Izohda soliq turi bor, lekin "dd.mm.yyyy dan AOS/QQS to\'lovchisi" naqshiga mos emas';
  }

  // Naqshlardan keyin mazmunli matn qolsa, izoh to'liq saqlanadi
  const leftover = rest.replace(/[^a-z]/g, '');
  if (leftover.length > 2 || (!res.status && !res.effectiveFrom)) res.note = text;
  if (original && !res.status && !res.effectiveFrom && !res.review) res.note = text;
  return res;
}

// ---------- "Бухгалтер ишлари" fayli ----------
// Ikki qatorli sarlavha: yuqorisi guruh ("my.mehnat.uz", "Счёт-фактура"), pastkisi ustun ("логин", "кирим").
// Birlashtirilgan kataklar ikkala qatorda bir xil matn bo'ladi (xlsxToRows asosiy katak qiymatini beradi).

export interface RoutineTypeLite {
  id: number;
  name: string;
  reportTypeId: number | null;
  sheetAliases: string[];
}

export type WorkField =
  | 'stir' | 'name' | 'taxType' | 'monthlyFee' | 'accountant' | 'bankKey'
  | 'employeeCount' | 'mehnatCheckedAt' | 'mehnatLogin' | 'mehnatPassword' | 'note';

export interface WorkColumnMap {
  /** Ma'lumot shu qatordan keyin boshlanadi */
  headerRow: number;
  fields: Partial<Record<WorkField, number>>;
  routines: { col: number; routineTypeId: number; name: string; header: string }[];
}

function classifyWork(top: string, sub: string): WorkField | 'skip' | null {
  const t = headerKey(top);
  const s = headerKey(sub);
  const k = s || t;
  if (!k) return null;
  if (k === 'STIR' || k === 'INN' || k.startsWith('STIR') || k.startsWith('INN')) return 'stir';
  if (has(k, 'KORXONANOMI', 'NOMI', 'NAZVANIE', 'NAIMENOVANIE')) return 'name';
  if (has(k, 'SOLIQTURI', 'VIDNALOG', 'TIPNALOG')) return 'taxType';
  // "30% (Бухгалтерлар улуши)" hisoblanadi, saqlanmaydi (V9)
  if (has(k, 'ULUSH', 'DOLYA') || top.includes('%')) return 'skip';
  if (has(k, 'OYLIKTULOV', 'OYLIKTOLOV', 'ABONENT')) return 'monthlyFee';
  if (has(k, 'JAVOBGAR', 'OTVETSTV')) return 'accountant';
  if (has(k, 'BANKKLYUCH', 'BANKKALIT', 'BANKKEY', 'KLYUCH')) return 'bankKey';
  if (has(t, 'MEHNAT')) {
    if (has(s, 'XODIMSONI', 'HODIMSONI', 'SONI')) return 'employeeCount';
    if (has(s, 'SANA', 'DATA')) return 'mehnatCheckedAt';
    if (has(s, 'LOGIN')) return 'mehnatLogin';
    if (has(s, 'PAROL')) return 'mehnatPassword';
    return 'skip';
  }
  if (has(k, 'IZOH', 'PRIMECHAN')) return 'note';
  return null;
}

function matchRoutine(top: string, sub: string, types: RoutineTypeLite[]) {
  for (const k of [headerKey(sub), headerKey(top)]) {
    if (!k) continue;
    for (const t of types) if (t.sheetAliases.some((a) => k.includes(headerKey(a)))) return t;
  }
  return null;
}

/** Kamida 3 ta doimiy ish ustuni topilsa "Бухгалтер ишлари" fayli; aks holda null (hisobot fayli deb olinadi) */
export function detectWorkColumns(rows: unknown[][], types: RoutineTypeLite[]): WorkColumnMap | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const top = rows[r] ?? [];
    const next = rows[r + 1] ?? [];
    // Pastki sarlavha qatori: STIR ustunida ham sarlavha matni turadi (raqam emas)
    const width = Math.max(top.length, next.length);
    const map: WorkColumnMap = { headerRow: r, fields: {}, routines: [] };
    const subRow = (() => {
      for (let c = 0; c < width; c++) if (classifyWork(cellText(top[c]), '') === 'stir') return headerKey(cellText(next[c])).startsWith('STIR') || headerKey(cellText(next[c])).startsWith('INN');
      return false;
    })();
    for (let c = 0; c < width; c++) {
      const t = cellText(top[c]).trim();
      const s = subRow ? cellText(next[c]).trim() : '';
      const f = classifyWork(t, s === t ? '' : s);
      if (f === 'skip') continue;
      if (f) {
        if (map.fields[f] === undefined) map.fields[f] = c;
        continue;
      }
      const rt = matchRoutine(t, s, types);
      if (rt && !map.routines.some((x) => x.routineTypeId === rt.id)) {
        map.routines.push({ col: c, routineTypeId: rt.id, name: rt.name, header: s && s !== t ? `${t} / ${s}` : t });
      }
    }
    if (map.fields.stir !== undefined && map.routines.length >= 3) {
      if (subRow) map.headerRow = r + 1;
      return map;
    }
  }
  return null;
}

/**
 * 'YYYY-MM-DD' | 'dd.mm.yyyy' | 'dd/mm/yyyy' | 'dd,mm,yyyy' | Excel sana raqami (45900) -> 'YYYY-MM-DD'; tanib bo'lmasa null.
 * 2000-yildan oldingi sana (Excel'da 0 -> 1899-12-30) sana emas: null (fayldagi matn saqlanadi, taxmin qilinmaydi).
 */
export function parseDate(raw: unknown): string | null {
  const s = cellText(raw).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[./,](\d{1,2})[./,](\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if (/^\d{5}$/.test(s) && Number(s) >= 36526 && Number(s) <= 73050) {
    // Sana formatisiz katak: Excel kun raqami (1 = 1900-01-01, 1900-02-29 xatosi bilan: asos 1899-12-30)
    return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10);
  } else return null;
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------- Qator tekshiruvlari (ikkala fayl uchun) ----------

/** Shakl so'zlari (MChJ, OK, XK...) nom solishtirishda hisobga olinmaydi */
const FORM_WORDS = new Set(['mchj', 'ok', 'xk', 'hk', 'ab', 'aj', 'qk', 'yatt', 'ooo', 'llc', 'yoki', 'group', 'groups']);
const companyWords = (s: string) => normalizeName(s).split(' ').filter((w) => w.length >= 3 && !FORM_WORDS.has(w));

/**
 * Fayldagi nom tizimdagi mijozga tegishlimi: kamida bitta mazmunli so'z umumiy bo'lsa ha
 * ("LABIN" = "KIMYO EXPRESS (LABIN)"). Umumiy so'z yo'q bo'lsa STIR noto'g'ri yozilgan bo'lishi mumkin
 * ("GIPER GROUP" qatorida FREE WAY TRADE STIRi): boshqa mijozga yozib yubormaslik uchun qator o'tkaziladi.
 */
export function sameCompany(fileName: string, dbName: string): boolean {
  const a = companyWords(fileName);
  const b = new Set(companyWords(dbName));
  if (!a.length || !b.size) return true;
  return a.some((w) => b.has(w));
}

/** Izohda kirish ma'lumoti (login/parol): ochiq matn izohga yozilmaydi */
export const hasSecret = (s: string) => /(login|логин|parol|пароль|password)\s*[:：]/i.test(s);
