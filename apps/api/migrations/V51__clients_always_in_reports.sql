-- «Mijozlar» bo'limi (rahbar qarori, 2026-11-16): barcha mijozlar bitta ro'yxatda, bo'limlarni rahbar shu yerdan tanlaydi.
--   in_reports: har doim true — hamma mijozga har oy hisobot topshiriladi. false faqat "shartnoma tugagan" (arxiv) mijozda.
--   in_works:   rahbar «Mijozlar» bo'limida yoqadi/o'chiradi (Buxgalter ishlari jadvali va oylik doimiy ishlar).
-- V25 dagi "har bo'lim o'z faylidan" qoidasi bekor: «Бухгалтер ишлари» fayli bilan kelgan mijoz ham hisobotda bo'ladi.

-- 1. Faqat Buxgalter ishlarida turgan mijozlar Hisobot topshirishga ham qo'shiladi (rahbar qarori: joriy oydan).
--    Joriy oy hisobot vazifalarini API ishga tushgandagi generator yaratadi (scheduler: generator(startup), idempotent).
WITH moved AS (
  UPDATE client SET in_reports = true
  WHERE in_works AND NOT in_reports
  RETURNING id
)
INSERT INTO audit_log (actor_id, entity, entity_id, client_id, action, before, after)
SELECT NULL, 'client', id::text, id, 'UPDATE', '{"inReports": false}', '{"inReports": true, "source": "V51"}'
FROM moved;

-- 2. Qoida bazada: Buxgalter ishlaridagi mijoz albatta Hisobot topshirishda ham (ikkalasi false = shartnoma tugagan)
ALTER TABLE client ADD CONSTRAINT ck_client_works_in_reports CHECK (NOT in_works OR in_reports);

-- «Mijozlar» ro'yxati filtri (Hammasi / Buxgalter ishlarida / Shartnoma tugagan): ~200 qatorda shart emas,
-- lekin filtrlar shu ikki ustun bo'yicha — mijozlar soni oshsa ham tez qoladi
CREATE INDEX ix_client_sections ON client (in_reports, in_works);
