/**
 * "Mening kunim" doirasi (rahbar qarori): bo'limdagi mijozning doimiy ishlari va ish ustuni bor hisobot (INPS,
 * routine_work_type.report_type_id) + rahbar bergan shoshilinch/qo'lda vazifalar. Hisobot topshirish vazifalari
 * kirmaydi. `t` = task, `c` = client. Telegram bot ham shu doiradan foydalanadi (ilova bilan bir xil son).
 */
export const WORKS_SCOPE = `(t.kind IN ('URGENT','MANUAL') OR (c.in_works AND (t.kind = 'ROUTINE' OR (t.kind = 'REPORT' AND t.report_type_id IN (
  SELECT report_type_id FROM routine_work_type WHERE active AND report_type_id IS NOT NULL)))))`;
