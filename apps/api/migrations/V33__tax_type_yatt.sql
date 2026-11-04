-- Uchinchi soliq turi: YaTT (yakka tartibdagi tadbirkor). Rahbar mijoz kartasida / jadvalda AOS, QQS yoki YATT tanlaydi.
-- Qaysi hisobot YaTT'ga tegishli — report_type.applies_to_yatt (AOS/QQS kabi ma'lumot, rahbar sozlamada o'zgartiradi).
-- Boshlang'ich qiymat haqiqiy jadvaldan: ЯТТ qatorlarida AOS = 1, JSHDS / To'lov manbai / QQS / Foyda / INPS = X.
-- TODO(tasdiqlash): jadvalda ustuni yo'q hisobotlar (Poruchenya, dividend, norezident, yillik) ham YaTT'ga X deb olindi.
ALTER TABLE client DROP CONSTRAINT client_tax_type_check;
ALTER TABLE client ADD CONSTRAINT client_tax_type_check CHECK (tax_type IN ('AOS', 'QQS', 'YATT'));
ALTER TABLE client_tax_type_history DROP CONSTRAINT client_tax_type_history_tax_type_check;
ALTER TABLE client_tax_type_history ADD CONSTRAINT client_tax_type_history_tax_type_check CHECK (tax_type IN ('AOS', 'QQS', 'YATT'));

ALTER TABLE report_type ADD COLUMN applies_to_yatt boolean NOT NULL DEFAULT false;
UPDATE report_type SET applies_to_yatt = true WHERE code = 'AOS';

-- V30 funksiyasi + YATT qatori
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
      WHEN c.tax_type = 'YATT' AND NOT rt.applies_to_yatt THEN 'TAX_TYPE'
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
