-- Qayta ochilgan vazifa eski muddat bilan "!" bo'lib qolardi.
--
-- V34/V36 faqat OCHIQ vazifalarni yangi muddatga o'tkazgan. Bajarilgan (1) va bekor qilingan (X) vazifalarda
-- eski muddat qolgan (oktyabr JShDS = 15.10 o'rniga 15.11). Rahbar katakda 0 tanlasa vazifa qayta ochilardi,
-- lekin muddat qayta hisoblanmasdi: sarlavhada 15.11, katakda esa darhol "!". "O'z vaqtida" foizi ham buzilgan edi
-- (noyabrda topshirilgan oktyabr hisoboti 15.10 muddat bilan kechikkan deb sanalardi).
--
-- Tuzatish:
--   1) fn_task_rule_due_at — vazifaning qoida bo'yicha muddati (hisobot: fn_report_due_at, doimiy ish: fn_work_due_at;
--      shoshilinch/qo'lda vazifa — o'z muddati). Kod vazifani qayta ochganda shu bilan muddatni yangilaydi.
--   2) Bajarilgan va bekor qilingan hisobot/doimiy ish vazifalari ham joriy qoidaga o'tkaziladi (audit'da RETIME).

CREATE OR REPLACE FUNCTION fn_task_rule_due_at(p_task_id bigint, p_time text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE t.kind
           WHEN 'REPORT' THEN fn_report_due_at(t.period, rt.due_day, p_time)
           WHEN 'ROUTINE' THEN fn_work_due_at(t.period, t.routine_type_id, p_time)
           ELSE t.due_at
         END
  FROM task t
  LEFT JOIN report_type rt ON rt.id = t.report_type_id
  WHERE t.id = p_task_id;
$$;

WITH t AS (SELECT coalesce((SELECT value #>> '{}' FROM setting WHERE key = 'task_due_time'), '18:00') AS tm),
moved AS (
  UPDATE task k SET
    due_at = x.new_due,
    overdue_notified_at = CASE WHEN x.new_due < now() THEN coalesce(k.overdue_notified_at, now()) END
  FROM (
    SELECT k2.id, fn_task_rule_due_at(k2.id, t.tm) AS new_due, k2.due_at AS old_due
    FROM task k2 CROSS JOIN t
    WHERE k2.kind IN ('REPORT', 'ROUTINE') AND k2.status IN ('DONE', 'CANCELLED')
  ) x
  WHERE k.id = x.id AND x.new_due IS DISTINCT FROM x.old_due
  RETURNING k.id, k.client_id, k.title, k.status, x.old_due, x.new_due
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'RETIME',
       jsonb_build_object('dueAt', old_due),
       jsonb_build_object('dueAt', new_due, 'title', title, 'status', status, 'source', 'V37')
FROM moved;
