-- V37 faqat bajarilgan/bekor qilingan vazifalarni yangi muddatga o'tkazgan edi. V37 deploy bo'lgunga qadar ishlayotgan
-- serverda rahbar "0" bilan qayta ochgan vazifalar eski muddat (15.10, 20.10) bilan OCHIQ bo'lib qolgan: jadvalda "!",
-- "0" tanlansa ham o'zgarmasdi. Ochiq hisobot/doimiy ish vazifalari ham qoida muddatiga (fn_task_rule_due_at) o'tadi.
-- Yangi muddat allaqachon o'tgan bo'lsa "muddat o'tdi" xabari qayta yuborilmaydi; keyinga surilsa yana yuboriladi.
WITH t AS (SELECT coalesce((SELECT value #>> '{}' FROM setting WHERE key = 'task_due_time'), '18:00') AS tm),
moved AS (
  UPDATE task k SET
    due_at = x.new_due,
    overdue_notified_at = CASE WHEN x.new_due < now() THEN coalesce(k.overdue_notified_at, now()) END
  FROM (
    SELECT k2.id, fn_task_rule_due_at(k2.id, t.tm) AS new_due, k2.due_at AS old_due
    FROM task k2 CROSS JOIN t
    WHERE k2.kind IN ('REPORT', 'ROUTINE') AND k2.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
  ) x
  WHERE k.id = x.id AND x.new_due IS DISTINCT FROM x.old_due
  RETURNING k.id, k.client_id, k.title, k.status, x.old_due, x.new_due
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'RETIME',
       jsonb_build_object('dueAt', old_due),
       jsonb_build_object('dueAt', new_due, 'title', title, 'status', status, 'source', 'V39')
FROM moved;
