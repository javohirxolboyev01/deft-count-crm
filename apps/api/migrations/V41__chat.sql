-- Ichki chat (rahbar qarori): barcha xodimlar (rahbar, buxgalter, sotuv operatori) bir-biri bilan yakkama-yakka yozishadi.
-- Qaror: faqat shaxsiy (1:1) suhbat — guruh/kanal yo'q, shuning uchun alohida "suhbat" jadvali shart emas:
-- suhbat = (yuboruvchi, qabul qiluvchi) jufti. O'qilganlik read_at bilan (Telegram'dagi ✓ / ✓✓).
-- Mijozga xabar yuborilmaydi (CLAUDE.md 8) — faqat app_user'lar orasida.
CREATE TABLE chat_message (
  id            bigserial PRIMARY KEY,
  sender_id     bigint NOT NULL REFERENCES app_user (id),
  recipient_id  bigint NOT NULL REFERENCES app_user (id),
  body          text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CHECK (sender_id <> recipient_id)
);

-- Suhbat tarixi (ikkala yo'nalish bitta kalitda) va oxirgi xabar
CREATE INDEX ix_chat_message_pair ON chat_message (least(sender_id, recipient_id), greatest(sender_id, recipient_id), id DESC);
-- O'qilmaganlar soni (badge)
CREATE INDEX ix_chat_message_unread ON chat_message (recipient_id, sender_id) WHERE read_at IS NULL;
