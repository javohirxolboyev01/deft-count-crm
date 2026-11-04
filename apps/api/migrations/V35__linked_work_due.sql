-- V34 tuzatish: hisobotga bog'langan doimiy ish (INPS, mijoz faqat Buxgalter ishlarida bo'lsa ROUTINE vazifa)
-- muddati hisobotniki. Uning davri allaqachon ish oyidan keyingi oy (oktyabr ishi = noyabr vazifasi, works.ts),
-- shuning uchun muddat shu davrning report_type.due_day-kuni (INPS: 25.11). Qolgan ishlar — V34 qoidasi.
CREATE OR REPLACE FUNCTION fn_work_due_at(p_period date, p_routine_type_id bigint, p_time text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN w.report_type_id IS NOT NULL THEN fn_due_at(p_period, rt.due_day, p_time)
              ELSE fn_routine_due_at(p_period, w.due_day, p_time) END
  FROM routine_work_type w
  LEFT JOIN report_type rt ON rt.id = w.report_type_id
  WHERE w.id = p_routine_type_id;
$$;

WITH t AS (SELECT coalesce((SELECT value #>> '{}' FROM setting WHERE key = 'task_due_time'), '18:00') AS tm),
moved AS (
  UPDATE task k SET
    due_at = x.new_due,
    overdue_notified_at = CASE WHEN x.new_due < now() THEN coalesce(k.overdue_notified_at, now()) END
  FROM (
    SELECT k2.id, fn_work_due_at(k2.period, k2.routine_type_id, t.tm) AS new_due, k2.due_at AS old_due
    FROM task k2 CROSS JOIN t
    JOIN routine_work_type w ON w.id = k2.routine_type_id AND w.report_type_id IS NOT NULL
    WHERE k2.kind = 'ROUTINE' AND k2.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
  ) x
  WHERE k.id = x.id AND x.new_due IS DISTINCT FROM x.old_due
  RETURNING k.id, k.client_id, k.title, x.old_due, x.new_due
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'RETIME',
       jsonb_build_object('dueAt', old_due),
       jsonb_build_object('dueAt', new_due, 'title', title, 'source', 'V35')
FROM moved;
