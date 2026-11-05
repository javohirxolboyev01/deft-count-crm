-- Rahbar javoblari (2026-11-05, "Hisobot topshirish muddatlari" jadvali bo'yicha savollar):
--   1) Yillik hisobotlar (Moliyaviy natijalar, Balans, Statistika) yiliga BIR marta. Muddat 1-mart (bu yildan;
--      ilgari 15-fevral edi), buxgalteriya bir yil orqada: 2025 yillik hisobot muddati 01.03.2027.
--      Katak hisobot yilining DEKABRIDA (oy joyida, muddat keyin — oylik hisobotlardagidek): dekabr 2025 = 2025 yil
--      hisoboti, muddati dekabrdan 15 oy keyingi oyning 1-kuni (01.03.2027). Boshqa oylarda ustun oxirgi dekabr
--      vazifasini ko'rsatadi (V11 mexanizmi).
--   2) Dividend, Norezident foyda, Norezident QQS — faqat QQS to'lovchilar (AOS to'lovchiga X).
--   3) Dividend muddati — keyingi oyning 20-kuni.
--   4) INPS — keyingi oyning 25-kuni; Poruchenya JShDS — muddatsiz.

-- Muddat necha oy keyin: oylik/choraklik — 1 (keyingi oy), yillik — 15 (dekabrdan keyin ikkinchi yilning marti)
ALTER TABLE report_type ADD COLUMN due_month_offset int NOT NULL DEFAULT 1 CHECK (due_month_offset BETWEEN 1 AND 24);

-- SQL-funksiya tanalari bog'liqlik sifatida kuzatilmaydi: eski 3 argumentli chaqiruvlar default 1 bilan ishlayveradi
DROP FUNCTION fn_report_due_at(date, int, text);
CREATE FUNCTION fn_report_due_at(p_period date, p_due_day int, p_time text, p_month_offset int DEFAULT 1)
RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT fn_due_at((p_period + make_interval(months => p_month_offset))::date, p_due_day, p_time);
$$;

CREATE OR REPLACE FUNCTION fn_task_rule_due_at(p_task_id bigint, p_time text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE t.kind
           WHEN 'REPORT' THEN fn_report_due_at(t.period, rt.due_day, p_time, rt.due_month_offset)
           WHEN 'ROUTINE' THEN fn_work_due_at(t.period, t.routine_type_id, p_time)
           ELSE t.due_at
         END
  FROM task t
  LEFT JOIN report_type rt ON rt.id = t.report_type_id
  WHERE t.id = p_task_id;
$$;

UPDATE report_type SET frequency = 'YEARLY', generation_months = '{12}', due_day = 1, due_month_offset = 15
WHERE code IN ('MOLIYAVIY_NATIJA', 'BALANS', 'STATISTIKA');
UPDATE report_type SET applies_to_aos = false WHERE code IN ('DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS');
UPDATE report_type SET due_day = 20 WHERE code = 'DIVIDEND';
UPDATE report_type SET due_day = 25 WHERE code = 'INPS';
UPDATE report_type SET due_day = NULL WHERE code = 'PORUCHENYA_JSHDS';

-- Endi qo'llanmaydigan OCHIQ vazifalar bekor (o'chirilmaydi, DONE tegilmaydi, audit'da): yillik hisobotning
-- dekabrdan boshqa oy vazifalari, AOS to'lovchining dividend/norezident vazifalari (rahbar katakda qo'lda 0/1
-- qo'ygan bo'lsa — fn_report_applicability'da qo'llanadi, qoladi)
WITH affected AS (
  SELECT id FROM report_type
  WHERE code IN ('MOLIYAVIY_NATIJA', 'BALANS', 'STATISTIKA', 'DIVIDEND', 'NOREZIDENT_FOYDA', 'NOREZIDENT_QQS')
),
periods AS (
  SELECT DISTINCT period FROM task
  WHERE kind = 'REPORT' AND report_type_id IN (SELECT id FROM affected) AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
),
applicable AS (
  SELECT p.period, a.client_id, a.report_type_id
  FROM periods p CROSS JOIN LATERAL fn_report_applicability(p.period) a
  WHERE a.applicable
),
cancelled AS (
  UPDATE task t SET prev_status = t.status, status = 'CANCELLED', cancel_reason = 'NOT_APPLICABLE'
  WHERE t.kind = 'REPORT' AND t.report_type_id IN (SELECT id FROM affected)
    AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
    AND NOT EXISTS (
      SELECT 1 FROM applicable a
      WHERE a.period = t.period AND a.client_id = t.client_id AND a.report_type_id = t.report_type_id)
  RETURNING t.id, t.client_id, t.title, t.prev_status
), timers AS (
  UPDATE time_entry SET ended_at = now() WHERE ended_at IS NULL AND task_id IN (SELECT id FROM cancelled)
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'CANCEL_NOT_APPLICABLE',
       jsonb_build_object('status', prev_status),
       jsonb_build_object('status', 'CANCELLED', 'title', title, 'source', 'V38')
FROM cancelled;

-- Muddatlar yangi qoidaga (barcha holatlar: qayta ochilsa ham, "o'z vaqtida" hisobi ham to'g'ri bo'lsin)
WITH t AS (SELECT coalesce((SELECT value #>> '{}' FROM setting WHERE key = 'task_due_time'), '18:00') AS tm),
moved AS (
  UPDATE task k SET
    due_at = x.new_due,
    overdue_notified_at = CASE WHEN x.new_due < now() THEN coalesce(k.overdue_notified_at, now()) END
  FROM (
    SELECT k2.id, fn_task_rule_due_at(k2.id, t.tm) AS new_due, k2.due_at AS old_due
    FROM task k2 CROSS JOIN t
    JOIN report_type rt ON rt.id = k2.report_type_id
    WHERE k2.kind = 'REPORT'
      AND rt.code IN ('MOLIYAVIY_NATIJA', 'BALANS', 'STATISTIKA', 'DIVIDEND', 'INPS', 'PORUCHENYA_JSHDS')
  ) x
  WHERE k.id = x.id AND x.new_due IS DISTINCT FROM x.old_due
  RETURNING k.id, k.client_id, k.title, k.status, x.old_due, x.new_due
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'RETIME',
       jsonb_build_object('dueAt', old_due),
       jsonb_build_object('dueAt', new_due, 'title', title, 'status', status, 'source', 'V38')
FROM moved;
