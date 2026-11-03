-- Buxgalter ishlari jadvali ham Exceldagidek (rahbar qarori, V30 bilan bir xil): rahbar istalgan ish katagiga
-- 1 / 0 / X qo'yadi, holat (Nol hisobot, Tugatilmoqda) yoki aniqlanmagan soliq turi to'smaydi.
-- period = vazifa davri (INPS kabi hisobotga bog'langan ishda ish oyidan keyingi oy). Tanlov keyingi oylarga o'tadi.
CREATE TABLE client_routine_cell (
  client_id       bigint NOT NULL REFERENCES client (id) ON DELETE CASCADE,
  routine_type_id bigint NOT NULL REFERENCES routine_work_type (id),
  period          date NOT NULL CHECK (extract(day FROM period) = 1),
  applicable      boolean NOT NULL,
  set_by          bigint REFERENCES app_user (id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, routine_type_id, period)
);

-- Doimiy ish qo'llanadimi: generator va reconcile shu yerdan o'qiydi (oldin generator.ts ichidagi shart edi).
-- Hisobotga bog'langan ish (INPS): hisobot qo'llansa yoki rahbar hisobot katagiga X qo'ygan bo'lsa — alohida
-- doimiy ish chiqmaydi (bitta INPS; X qo'yilganda doimiy ish bo'lib "qaytib chiqmasin").
CREATE FUNCTION fn_routine_applicability(p_period date)
RETURNS TABLE (client_id bigint, routine_type_id bigint, applicable boolean)
LANGUAGE sql STABLE AS $$
  WITH ra AS (
    SELECT a.client_id, a.report_type_id FROM fn_report_applicability(p_period) a
    WHERE a.applicable OR a.reason = 'MANUAL_X'
  )
  SELECT c.id, w.id,
         c.in_works AND w.active AND w.effective_from <= p_period
         AND ra.client_id IS NULL
         AND coalesce(o.applicable, c.status = 'ACTIVE' AND c.tax_type IS NOT NULL)
  FROM client c
  CROSS JOIN routine_work_type w
  LEFT JOIN ra ON ra.client_id = c.id AND ra.report_type_id = w.report_type_id
  LEFT JOIN LATERAL (
    SELECT o.applicable FROM client_routine_cell o
    WHERE o.client_id = c.id AND o.routine_type_id = w.id AND o.period <= p_period
    ORDER BY o.period DESC
    LIMIT 1
  ) o ON true;
$$;
