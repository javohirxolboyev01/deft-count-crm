-- Buxgalteriya 1 oy orqada yuradi (rahbar qarori): oktyabrning ishi va hisoboti noyabrda topshiriladi.
--
-- Hisobotlar: vazifa davri (task.period) avvalgidek TOPSHIRISH oyi (noyabr vazifasi, muddat 15.11) — o'zgarmaydi.
-- O'zgargani jadval ko'rinishi (grid.ts): Hisobot topshirish jadvalida "Oktyabr" = oktyabr UCHUN hisobotlar
-- (noyabr davri vazifalari, sarlavhada 15.11 / 20.11). Mavjud vazifalar va importlar shundayligicha to'g'ri.
--
-- INPS muddati: keyingi oyning 25-kuni (rahbar qarori; ilgari 10).
UPDATE report_type SET due_day = 25 WHERE code = 'INPS';

-- Doimiy ishlar: ish oyidan KEYINGI oyning due_day-kunigacha (ilgari ish oyining oxiri).
-- NULL = muddat kuni belgilanmagan: keyingi oyning oxirgi kuni ("Boshqa ishlar").
-- Hisobotga bog'langan ish (INPS) muddati hisobotniki (report_type.due_day), bu ustun ishlatilmaydi.
ALTER TABLE routine_work_type ADD COLUMN due_day int CHECK (due_day BETWEEN 1 AND 31);
UPDATE routine_work_type SET due_day = CASE
    WHEN 'ISHHAQI' = ANY (sheet_aliases) THEN 5
    WHEN 'VIPISKA' = ANY (sheet_aliases) THEN 10
    WHEN 'KIRIM' = ANY (sheet_aliases) THEN 15
    WHEN 'CHIQIM' = ANY (sheet_aliases) THEN 10
    WHEN 'DEBITOR' = ANY (sheet_aliases) THEN 20
    WHEN 'YOPIL' = ANY (sheet_aliases) THEN 20
  END
WHERE report_type_id IS NULL;

-- Doimiy ish vazifasi muddati: davr (ish oyi) + 1 oy, due_day (yo'q bo'lsa oy oxiri)
CREATE OR REPLACE FUNCTION fn_routine_due_at(p_period date, p_due_day int, p_time text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT fn_due_at((p_period + interval '1 month')::date, coalesce(p_due_day, 31), p_time);
$$;

-- Ochiq vazifalar yangi muddatga o'tadi (bajarilgan/bekor qilinganlari tarixda o'zgarmaydi, audit'da).
-- Yangi muddat allaqachon o'tgan bo'lsa "muddat o'tdi" xabari qayta yuborilmaydi; keyinga surilsa yana yuboriladi.
WITH t AS (SELECT coalesce((SELECT value #>> '{}' FROM setting WHERE key = 'task_due_time'), '18:00') AS tm),
moved AS (
  UPDATE task k SET
    due_at = x.new_due,
    overdue_notified_at = CASE WHEN x.new_due < now() THEN coalesce(k.overdue_notified_at, now()) END
  FROM (
    SELECT k2.id,
           CASE WHEN k2.kind = 'ROUTINE' THEN fn_routine_due_at(k2.period, w.due_day, t.tm)
                ELSE fn_due_at(k2.period, rt.due_day, t.tm) END AS new_due,
           k2.due_at AS old_due
    FROM task k2
    CROSS JOIN t
    LEFT JOIN routine_work_type w ON w.id = k2.routine_type_id
    LEFT JOIN report_type rt ON rt.id = k2.report_type_id
    WHERE k2.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
      AND (k2.kind = 'ROUTINE' OR (k2.kind = 'REPORT' AND rt.code = 'INPS'))
  ) x
  WHERE k.id = x.id AND x.new_due IS DISTINCT FROM x.old_due
  RETURNING k.id, k.client_id, k.title, x.old_due, x.new_due
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'RETIME',
       jsonb_build_object('dueAt', old_due),
       jsonb_build_object('dueAt', new_due, 'title', title, 'source', 'V34')
FROM moved;
