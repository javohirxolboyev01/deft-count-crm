-- Vazifani boshqa xodimga o'tkazish (rahbar qarori): faqat Shoshilinch va qo'lda yaratilgan (URGENT/MANUAL) vazifa.
-- Vazifa egasi yoki rahbar so'rov yuboradi, sabab majburiy; qabul qiluvchi "Qabul qilaman / Rad etaman" bosguncha
-- vazifa eski egasida qoladi. Zanjir cheklanmaydi (qabul qilgan xodim yana o'tkaza oladi).
-- Qaror: alohida jadval — so'rovlar tarixi (kim, kimga, nega, natija) vazifadan alohida saqlanadi, audit_log'da ham bor.
CREATE TABLE task_transfer (
  id             bigserial PRIMARY KEY,
  task_id        bigint NOT NULL REFERENCES task (id),
  from_user_id   bigint REFERENCES app_user (id),
  to_user_id     bigint NOT NULL REFERENCES app_user (id),
  requested_by   bigint NOT NULL REFERENCES app_user (id),
  reason_code    text NOT NULL CHECK (reason_code IN ('NOT_MINE', 'BUSY', 'OTHER')),
  reason_text    text,
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  reject_reason  text,
  resolved_by    bigint REFERENCES app_user (id),
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (reason_code <> 'OTHER' OR nullif(btrim(reason_text), '') IS NOT NULL),
  CHECK ((status = 'PENDING') = (resolved_at IS NULL))
);

-- Bitta vazifada bir vaqtda bitta kutilayotgan so'rov
CREATE UNIQUE INDEX ux_task_transfer_pending ON task_transfer (task_id) WHERE status = 'PENDING';
CREATE INDEX ix_task_transfer_to_pending ON task_transfer (to_user_id) WHERE status = 'PENDING';
CREATE INDEX ix_task_transfer_task ON task_transfer (task_id, created_at DESC);
