// Kirill -> lotin (o'zbek imlosi), qidiruv va sarlavha tanish uchun
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: "g'", д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y',
  к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ў: "o'",
  ф: 'f', х: 'x', ҳ: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu',
  я: 'ya', і: 'i', ї: 'i', є: 'e',
};

export function transliterate(input: string): string {
  let out = '';
  for (const ch of input) {
    const lower = ch.toLowerCase();
    const t = CYR[lower];
    if (t === undefined) out += ch;
    else out += ch === lower ? t : t.toUpperCase();
  }
  return out;
}

/**
 * Korxona nomini qidiruv uchun normallashtirish:
 * kirill -> lotin, kichik harf, tirnoq/apostroflar olib tashlanadi, MChJ/МЧЖ/ООО bir xil shaklga.
 */
export function normalizeName(name: string): string {
  let s = transliterate(name).toLowerCase();
  s = s.replace(/[‘’ʻʼ`´'"«»“”„]/g, '');
  s = s.replace(/[.,;:()\[\]{}!?/\\|+-]/g, ' ');
  s = s.replace(/\b(m\s*ch\s*j|mchj|ooo|o\s*o\s*o|llc)\b/g, 'mchj');
  return s.replace(/\s+/g, ' ').trim();
}

/** Sarlavha/kalit so'z taqqoslash uchun: lotin, KATTA harf, faqat harf va raqam */
export function headerKey(s: string): string {
  return transliterate(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** AOC/AOS/АОС/ҚҚС/QQS/НДС/ЯТТ/YaTT -> 'AOS' | 'QQS' | 'YATT' | null */
export function normalizeTaxType(raw: string | null | undefined): 'AOS' | 'QQS' | 'YATT' | null {
  if (!raw) return null;
  const k = headerKey(raw);
  if (['AOS', 'AOC', 'AOSTOLOVCHI', 'AOCTOLOVCHI'].includes(k) || k.startsWith('AOS') || k.startsWith('AOC')) return 'AOS';
  if (['QQS', 'KKS', 'NDS'].includes(k) || k.startsWith('QQS') || k.startsWith('KKS')) return 'QQS';
  if (['YATT', 'IP'].includes(k)) return 'YATT';
  return null;
}

/** STIR: faqat raqamlar */
export function normalizeStir(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}
