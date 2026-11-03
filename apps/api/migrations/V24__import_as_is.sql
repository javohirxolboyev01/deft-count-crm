-- Excel jadval "boricha" yuklanadi: tizim tushunmagan qiymat tashlab ketilmaydi va taxmin qilinmaydi,
-- fayldagi matni saqlanib ko'rsatiladi; to'g'ri qiymat keyin (karta yoki keyingi fayl) kelganda o'zi almashadi.

-- 1) Soliq turi aniqlanmagan mijoz ("ЯТТ", "Қ АОС", bo'sh katak): tax_type NULL, fayldagi matn tax_type_raw'da.
--    Bunday mijozga vazifa chiqmaydi (qaysi hisobot kerakligi noma'lum); rahbar turni tanlaganda fayldagi
--    kataklar (client_report_raw) qo'llanadi.
ALTER TABLE client ALTER COLUMN tax_type DROP NOT NULL;
ALTER TABLE client ADD COLUMN tax_type_raw text;

-- 2) "Arxiv": firma bilan ishlamay qo'ygan mijoz (izohda "Ketgan", "Керак эмас"). Vazifa chiqmaydi,
--    ro'yxatlarda standart holda ko'rinmaydi; tarix (vazifalar, audit) saqlanadi.
ALTER TABLE client DROP CONSTRAINT client_status_check;
ALTER TABLE client ADD CONSTRAINT client_status_check
  CHECK (status IN ('ACTIVE', 'ZERO_REPORT', 'LIQUIDATING', 'ARCHIVED'));

-- 3) Hisobot faylidagi katak (1/0/X) soliq turi aniqlanmagan mijoz uchun: jadvalda fayldagidek ko'rinadi,
--    soliq turi tanlanganda vazifalarga qo'llanib o'chiriladi. period = topshirish oyi (import davri).
CREATE TABLE client_report_raw (
  client_id      bigint NOT NULL REFERENCES client (id) ON DELETE CASCADE,
  report_type_id bigint NOT NULL REFERENCES report_type (id),
  period         date NOT NULL CHECK (extract(day FROM period) = 1),
  raw            text NOT NULL,
  imported_by    bigint REFERENCES app_user (id),
  imported_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, report_type_id, period)
);

-- 4) "Бухгалтер ишлари" faylidagi tanilmagan ish katagi ("28,02,2025(14)", "eri", "Javob bermadi"):
--    sahifada fayldagidek ko'rinadi; rahbar oyni kiritsa yoki keyingi faylda sana kelsa o'chadi.
CREATE TABLE client_routine_raw (
  client_id       bigint NOT NULL REFERENCES client (id) ON DELETE CASCADE,
  routine_type_id bigint NOT NULL REFERENCES routine_work_type (id),
  raw             text NOT NULL,
  imported_by     bigint REFERENCES app_user (id),
  imported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, routine_type_id)
);

-- 5) Qo'llanish: arxiv va soliq turi aniqlanmagan mijozga hisobot yo'q (V20 funksiyasi + ikki shart)
CREATE OR REPLACE FUNCTION fn_report_applicability(p_period date)
RETURNS TABLE (client_id bigint, report_type_id bigint, tax_type text, applicable boolean, reason text)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT cl.id, cl.status, fn_client_tax_type(cl.id, fn_period_end(p_period)) AS tax_type
    FROM client cl
  )
  SELECT c.id, rt.id, c.tax_type,
         r.reason IS NULL AS applicable,
         r.reason
  FROM c
  CROSS JOIN fn_report_columns(p_period) rt
  CROSS JOIN LATERAL (
    SELECT CASE
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

-- 6) Fayl sarlavhasidagi xato yozuv ("Divedend solig'i") ham Dividend ustuni deb tanilsin
UPDATE report_type SET sheet_aliases = array_append(sheet_aliases, 'DIVEDEND')
WHERE code = 'DIVIDEND' AND NOT ('DIVEDEND' = ANY (sheet_aliases));

-- 7) Tuzatish: o'tgan oy fayli import qilinganda "X" istisnolari faqat import oyiga qo'llangan, joriy oyda
--    endi topshirilmaydigan hisobotlar ochiq qolgan (importer.ts tuzatildi). Reconcile qoidasi bilan bir xil:
--    qo'llanmaydigan OCHIQ hisobot vazifalari bekor qilinadi (o'chirilmaydi), DONE tegilmaydi, audit yoziladi.
WITH p AS (
  SELECT DISTINCT period FROM task WHERE kind = 'REPORT' AND status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
), na AS (
  SELECT a.client_id, a.report_type_id, p.period
  FROM p CROSS JOIN LATERAL fn_report_applicability(p.period) a
  WHERE NOT a.applicable
), cancelled AS (
  UPDATE task t SET prev_status = t.status, status = 'CANCELLED', cancel_reason = 'NOT_APPLICABLE'
  FROM na
  WHERE t.kind = 'REPORT' AND t.client_id = na.client_id AND t.report_type_id = na.report_type_id
    AND t.period = na.period AND t.status IN ('TODO', 'IN_PROGRESS', 'WAITING_CLIENT')
  RETURNING t.id, t.client_id, t.title, t.prev_status
), timers AS (
  UPDATE time_entry SET ended_at = now() WHERE ended_at IS NULL AND task_id IN (SELECT id FROM cancelled)
)
INSERT INTO audit_log (entity, entity_id, client_id, action, before, after)
SELECT 'task', id::text, client_id, 'CANCEL_NOT_APPLICABLE',
       jsonb_build_object('status', prev_status),
       jsonb_build_object('status', 'CANCELLED', 'title', title, 'source', 'V24')
FROM cancelled;
