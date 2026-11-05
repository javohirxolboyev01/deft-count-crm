-- Chat xabarini tahrirlash va o'chirish: faqat yuboruvchi o'z xabarini (Telegram kabi, vaqt cheklovisiz).
-- Qaror: o'chirish yumshoq (deleted_at) — ikkala tomonda ham ko'rinmaydi, o'qilmaganlar soniga kirmaydi.
ALTER TABLE chat_message
  ADD COLUMN edited_at  timestamptz,
  ADD COLUMN deleted_at timestamptz;

DROP INDEX ix_chat_message_unread;
CREATE INDEX ix_chat_message_unread ON chat_message (recipient_id, sender_id) WHERE read_at IS NULL AND deleted_at IS NULL;
