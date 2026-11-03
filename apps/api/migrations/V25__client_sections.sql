-- Har bo'lim o'z mijozlarini alohida yuklaydi (rahbar qarori): hisobot jadvali yuklansa mijoz faqat
-- "Hisobot topshirish"da, «Бухгалтер ишлари» fayli yuklansa faqat "Buxgalter ishlari"da paydo bo'ladi.
-- Bir xil STIR ikkala faylda bo'lsa — bitta mijoz, ikkala belgi qo'yiladi va ma'lumotlar bog'liq.
--   in_reports: hisobot vazifalari chiqadi va Hisobot topshirish jadvalida ko'rinadi
--   in_works:   oylik doimiy ishlar chiqadi va Buxgalter ishlari jadvalida ko'rinadi
-- Qo'lda (forma, lead) qo'shilgan mijoz ikkala bo'limda (DEFAULT true). TODO(tasdiqlash)
ALTER TABLE client ADD COLUMN in_reports boolean NOT NULL DEFAULT true;
ALTER TABLE client ADD COLUMN in_works boolean NOT NULL DEFAULT true;

-- Mavjud mijozlar: qaysi import yaratgan/o'zgartirgan bo'lsa, o'sha bo'limda. Import bitta tranzaksiya,
-- shuning uchun uning audit yozuvlari (mijoz, vazifa) sheet_import yozuvi bilan bir xil `at` vaqtida.
-- Hech qaysi importga tegmagan (qo'lda qo'shilgan) mijoz ikkala bo'limda qoladi.
WITH touched AS (
  SELECT a.client_id,
         bool_or(i.action = 'IMPORT') AS by_reports,
         bool_or(i.action = 'IMPORT_WORKS') AS by_works
  FROM audit_log a
  JOIN audit_log i ON i.at = a.at AND i.entity = 'sheet_import'
  WHERE a.client_id IS NOT NULL
  GROUP BY a.client_id
)
UPDATE client c SET in_reports = t.by_reports, in_works = t.by_works
FROM touched t
WHERE t.client_id = c.id AND (t.by_reports OR t.by_works);

-- Qo'llanish: hisobot bo'limida bo'lmagan mijozga hisobot yo'q (V24 funksiyasi + bitta shart)
CREATE OR REPLACE FUNCTION fn_report_applicability(p_period date)
RETURNS TABLE (client_id bigint, report_type_id bigint, tax_type text, applicable boolean, reason text)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT cl.id, cl.status, cl.in_reports, fn_client_tax_type(cl.id, fn_period_end(p_period)) AS tax_type
    FROM client cl
  )
  SELECT c.id, rt.id, c.tax_type,
         r.reason IS NULL AS applicable,
         r.reason
  FROM c
  CROSS JOIN fn_report_columns(p_period) rt
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN NOT c.in_reports THEN 'NOT_IN_REPORTS'
      WHEN c.status IN ('LIQUIDATING', 'ARCHIVED') THEN c.status
      WHEN c.tax_type IS NULL THEN 'NO_TAX_TYPE'
      WHEN c.tax_type = 'AOS' AND NOT rt.applies_to_aos THEN 'TAX_TYPE'
      WHEN c.tax_type = 'QQS' AND NOT rt.applies_to_qqs THEN 'TAX_TYPE'
      WHEN EXISTS (
        SELECT 1 FROM client_report_exclusion e
        WHERE e.client_id = c.id AND e.report_type_id = rt.id AND e.effective_from <= p_period) THEN 'CLIENT_EXCLUDED'
      WHEN rt.requires_event_flag AND NOT EXISTS (
        SELECT 1 FROM client_report_event ev
        WHERE ev.client_id = c.id AND ev.report_type_id = rt.id
          AND ev.month = to_char(p_period - interval '1 month', 'YYYY-MM')) THEN 'NO_EVENT'
      ELSE NULL
    END AS reason
  ) r;
$$;

-- Bo'limida bo'lmagan mijozning OCHIQ vazifalari bekor qilinadi (o'chirilmaydi, DONE tegilmaydi, audit):
-- hisobot vazifasi — hisobot bo'limida yo'q; doimiy ish — Buxgalter ishlarida yo'q.
-- INPS: hisobot bo'limida yo'q, Buxgalter ishlarida bor mijozga keyingi generatsiyada doimiy ish bo'lib chiqadi.
WITH cancelled AS (
  UPDATE task t SET prev_status = t.status, status = 'CANCELLED', cancel_reason = 'NOT_APPLICABLE'
  FROM client c
  WHERE c.id = t.client_id AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
    AND ((t.kind = 'REPORT' AND NOT c.in_reports) OR (t.kind = 'ROUTINE' AND NOT c.in_works))
  RETURNING t.id, t.client_id, t.title, t.prev_status
), timers AS (
  UPDATE time_entry SET ended_at = now() WHERE ended_at IS NULL AND task_id IN (SELECT id FROM cancelled)
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'CANCEL_NOT_APPLICABLE',
       jsonb_build_object('status', prev_status),
       jsonb_build_object('status', 'CANCELLED', 'title', title, 'source', 'V25')
FROM cancelled;
