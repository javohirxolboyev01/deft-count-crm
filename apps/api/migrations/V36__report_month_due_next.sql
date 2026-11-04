-- Rahbar tuzatishi (V34 o'rniga): oy JOYIDA qoladi, faqat muddat keyingi oyga o'tadi.
--   task.period = hisobot / ish oyi ("Oktyabr" katagi = oktyabr vazifasi), muddat — keyingi oyning due_day-kuni:
--   oktyabr AOS = 15.11, QQS = 20.11, INPS = 25.11. Jadvalda oy surilmaydi (V34'dagi grid.ts surilishi olib tashlandi).
--   Holat bo'yicha hisobot (dividend, norezident): holat oyi katagida, muddat keyingi oyda.
--   INPS ham shu qoida: Buxgalter ishlarida "oktyabr" = oktyabr vazifasi (ilgari noyabr vazifasi edi).

CREATE OR REPLACE FUNCTION fn_report_due_at(p_period date, p_due_day int, p_time text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT fn_due_at((p_period + interval '1 month')::date, p_due_day, p_time);
$$;

-- Hisobotga bog'langan ish (INPS): hisobot muddati, davr endi ish oyining o'zi
CREATE OR REPLACE FUNCTION fn_work_due_at(p_period date, p_routine_type_id bigint, p_time text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN w.report_type_id IS NOT NULL THEN fn_report_due_at(p_period, rt.due_day, p_time)
              ELSE fn_routine_due_at(p_period, w.due_day, p_time) END
  FROM routine_work_type w
  LEFT JOIN report_type rt ON rt.id = w.report_type_id
  WHERE w.id = p_routine_type_id;
$$;

-- Holat belgisi endi o'z oyi katagida (ilgari holat oyi + 1 davrida). Rahbar bosgan katak joyida qolsin:
-- mavjud belgilar bir oy oldinga (ilgari ko'ringan katak oyiga) ko'chiriladi.
CREATE TEMP TABLE tmp_event ON COMMIT DROP AS SELECT * FROM client_report_event;
DELETE FROM client_report_event;
INSERT INTO client_report_event (client_id, report_type_id, month, marked_by, marked_at)
SELECT client_id, report_type_id, to_char(to_date(month, 'YYYY-MM') + interval '1 month', 'YYYY-MM'), marked_by, marked_at
FROM tmp_event;

-- V33 funksiyasi, holat sharti o'z oyiga
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
          AND ev.month = to_char(p_period, 'YYYY-MM')) THEN 'NO_EVENT'
      ELSE NULL
    END AS reason
  ) r;
$$;

-- Ochiq vazifalar yangi muddatga (bajarilgan/bekor qilinganlari tarixda o'zgarmaydi, audit'da)
WITH t AS (SELECT coalesce((SELECT value #>> '{}' FROM setting WHERE key = 'task_due_time'), '18:00') AS tm),
moved AS (
  UPDATE task k SET
    due_at = x.new_due,
    overdue_notified_at = CASE WHEN x.new_due < now() THEN coalesce(k.overdue_notified_at, now()) END
  FROM (
    SELECT k2.id,
           CASE WHEN k2.kind = 'REPORT' THEN fn_report_due_at(k2.period, rt.due_day, t.tm)
                ELSE fn_work_due_at(k2.period, k2.routine_type_id, t.tm) END AS new_due,
           k2.due_at AS old_due
    FROM task k2
    CROSS JOIN t
    LEFT JOIN report_type rt ON rt.id = k2.report_type_id
    LEFT JOIN routine_work_type w ON w.id = k2.routine_type_id
    WHERE k2.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
      AND (k2.kind = 'REPORT' OR (k2.kind = 'ROUTINE' AND w.report_type_id IS NOT NULL))
  ) x
  WHERE k.id = x.id AND x.new_due IS DISTINCT FROM x.old_due
  RETURNING k.id, k.client_id, k.title, x.old_due, x.new_due
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'RETIME',
       jsonb_build_object('dueAt', old_due),
       jsonb_build_object('dueAt', new_due, 'title', title, 'source', 'V36')
FROM moved;
