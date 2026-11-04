-- Rahbar qarori: Foyda solig'i CHORAKLIK (yiliga 4 marta), lekin ustun Hisobot topshirish jadvalida har oy
-- ko'rinadi (V11 mexanizmi): chorak oralig'idagi oylarda katak oxirgi chorak oyi vazifasini ko'rsatadi,
-- rahbar chorak kelganda belgilaydi. Muddat = due_day (20) shu chorak oyi ichida.
-- TODO(tasdiqlash): chorak oylari 1,4,7,10 (dastlabki seed); rahbar sozlamada o'zgartira oladi.
UPDATE report_type SET frequency = 'QUARTERLY', generation_months = '{1,4,7,10}'
WHERE code = 'FOYDA';

-- Chorak oyi bo'lmagan davrlardagi OCHIQ Foyda vazifalari bekor qilinadi (o'chirilmaydi, DONE tegilmaydi, audit):
-- aks holda ular jadvalda ko'rinmay, muddati o'tib "kechikkan" bo'lib qolardi.
WITH cancelled AS (
  UPDATE task t SET prev_status = t.status, status = 'CANCELLED', cancel_reason = 'NOT_APPLICABLE'
  FROM report_type rt
  WHERE rt.id = t.report_type_id AND rt.code = 'FOYDA' AND t.kind = 'REPORT'
    AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
    AND NOT (extract(month FROM t.period)::int = ANY (rt.generation_months))
  RETURNING t.id, t.client_id, t.title, t.prev_status
), timers AS (
  UPDATE time_entry SET ended_at = now() WHERE ended_at IS NULL AND task_id IN (SELECT id FROM cancelled)
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'CANCEL_NOT_APPLICABLE',
       jsonb_build_object('status', prev_status),
       jsonb_build_object('status', 'CANCELLED', 'title', title, 'source', 'V32')
FROM cancelled;
