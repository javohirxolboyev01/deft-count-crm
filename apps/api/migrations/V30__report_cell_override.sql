-- Hisobot topshirish jadvali Exceldagidek (rahbar qarori): rahbar istalgan katakka 1 / 0 / X qo'yadi, soliq turi
-- qoidasi ham to'smaydi (masalan AOS to'lovchiga QQS katagini 0 qilish). Qoida (report_type.applies_to, holat,
-- istisno) faqat boshlang'ich qiymat; qo'lda tanlov shu yerda saqlanadi.
--   applicable = true  -> topshiriladi (katak 0/1, vazifa bor)
--   applicable = false -> X (vazifa yo'q / bekor qilingan)
-- Exceldagidek keyingi oy oldingisidan nusxa: tanlov shu oydan keyingi oylarga ham o'tadi, yangi tanlovgacha.
-- Holat bo'yicha hisobot (dividend, norezident) faqat o'z oyi uchun — holat har oy boshqa.
CREATE TABLE client_report_cell (
  client_id      bigint NOT NULL REFERENCES client (id) ON DELETE CASCADE,
  report_type_id bigint NOT NULL REFERENCES report_type (id),
  period         date NOT NULL CHECK (extract(day FROM period) = 1),
  applicable     boolean NOT NULL,
  set_by         bigint REFERENCES app_user (id),
  set_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, report_type_id, period)
);

-- V25 funksiyasi + qo'lda tanlov (bo'limda bo'lmagan mijozdan keyin, qolgan barcha qoidalardan oldin)
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
  LEFT JOIN LATERAL (
    SELECT o.applicable FROM client_report_cell o
    WHERE o.client_id = c.id AND o.report_type_id = rt.id
      AND (o.period = p_period OR (NOT rt.requires_event_flag AND o.period < p_period))
    ORDER BY o.period DESC
    LIMIT 1
  ) o ON true
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN NOT c.in_reports THEN 'NOT_IN_REPORTS'
      WHEN o.applicable THEN NULL
      WHEN NOT o.applicable THEN 'MANUAL_X'
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
