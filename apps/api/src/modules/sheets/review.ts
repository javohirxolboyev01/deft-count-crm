import { type Db } from '../../db';

// "Qo'lda tekshirish" yozuvlari. Har yozuv mijoz kartasining qaysi maydoni bilan tuzatilishini biladi (V28):
// rahbar kartada shu maydonni o'zgartirib saqlasa, yozuv o'zi yopiladi — "Hal qilindi"ni alohida bosish shart emas.
// Maydoni yo'q yozuv (faqat "tekshiring" xabari) rahbar kartani to'liq saqlaganda yopiladi (`reviewed`): ko'rib chiqdi.
// Jadvaldagi bitta katak tahriri (izoh, maydon) uni yopmaydi.

export type ReviewSection = 'REPORTS' | 'WORKS';

const FIELD_RULES: [RegExp, string[]][] = [
  [/^STIR tizimda boshqa mijozga/, ['name', 'stir']],
  [/^Nomi bo'yicha/, []],
  [/^STIR/, ['stir']],
  [/^Soliq turi/, ['taxType']],
  [/^Izoh(dagi|da) soliq turi/, ['taxType', 'taxTypeEffectiveFrom', 'note']],
  [/^Barcha hisobotlar X/, ['status']],
  [/^Buxgalter /, ['accountantId']],
  [/^Oylik to'lov/, ['monthlyFee']],
  [/^Bank-kalit/, ['bankKey']],
  [/^Xodim soni/, ['employeeCount']],
  [/^my\.mehnat\.uz sanasi/, ['mehnatCheckedAt']],
  [/X bo'lishi kerak\)$|fayldagidek qo'yildi\)$/, ['taxType']],
];

/** Doimiy ish katagi (Buxgalter ishlari jadvalida oy kiritilganda yopiladi) */
export const routineField = (workName: string) => `routine:${workName}`;

/** Xabar matnidan kartadagi maydon(lar) — migratsiya V28 dagi backfill bilan bir xil qoidalar */
export function reviewFields(message: string): string[] {
  const work = /^([^:]+): sana tanilmadi "/.exec(message);
  if (work) return [routineField(work[1])];
  return FIELD_RULES.find(([re]) => re.test(message))?.[1] ?? [];
}

export async function insertReview(
  db: Db,
  r: { ref: string; stir: string | null; name: string; message: string; clientId: number | null; section: ReviewSection },
) {
  await db.query(
    `INSERT INTO sheet_sync_error (kind, ref, stir, message, client_id, section, fields) VALUES ('IMPORT_REVIEW', $1, $2, $3, $4, $5, $6)`,
    [r.ref, r.stir, `${r.name}: ${r.message}`, r.clientId, r.section, reviewFields(r.message)],
  );
}

/**
 * Mijoz saqlandi (yoki ish katagida oy kiritildi): o'zgargan maydonlarga tegishli yozuvlar, reviewed bo'lsa
 * maydonsiz ("tekshiring") ham yopiladi
 */
export async function resolveReviewOnSave(db: Db, clientId: number, changed: string[], reviewed: boolean, actorId: number | null) {
  await db.query(
    `UPDATE sheet_sync_error e SET resolved = true, resolved_by = $3, resolved_at = now()
     WHERE e.kind = 'IMPORT_REVIEW' AND NOT e.resolved
       AND (e.client_id = $1 OR (e.client_id IS NULL AND e.stir = (SELECT stir FROM client WHERE id = $1)))
       AND (($4 AND e.fields = '{}') OR e.fields && $2::text[])`,
    [clientId, changed, actorId, reviewed],
  );
}
