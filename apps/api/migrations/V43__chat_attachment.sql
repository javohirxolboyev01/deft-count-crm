-- Chatda media: rasm, video, ovozli xabar va dumaloq video xabar (rahbar qarori).
-- Qaror: fayl o'zimizning diskda emas, Telegram yopiq kanalida saqlanadi (bot kanalga sendDocument qiladi).
-- Bazada faqat Telegram havolasi: file_id (yuklab olish uchun, faqat shu botga tegishli) va kanal posti
-- (tg_chat_id + tg_message_id) — bot almashsa fayllarni kanaldan qayta tiklash uchun.
-- Bitta xabarda bitta fayl (Telegram'dagi kabi; albom yo'q). Matn (body) — fayl izohi, bo'sh bo'lishi mumkin.
CREATE TABLE chat_attachment (
  id                 bigserial PRIMARY KEY,
  message_id         bigint NOT NULL UNIQUE REFERENCES chat_message (id),
  kind               text NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'VOICE', 'VIDEO_NOTE')),
  mime               text NOT NULL,
  file_name          text,
  size_bytes         integer NOT NULL CHECK (size_bytes > 0),
  duration_sec       integer CHECK (duration_sec >= 0),
  width              integer CHECK (width > 0),
  height             integer CHECK (height > 0),
  tg_file_id         text NOT NULL,
  tg_file_unique_id  text NOT NULL,
  tg_chat_id         text NOT NULL,
  tg_message_id      bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Faylli xabarda matn bo'lmasligi mumkin: "kamida 1 belgi" tekshiruvi ilovaga o'tadi (fayl yoki matn shart)
ALTER TABLE chat_message DROP CONSTRAINT chat_message_body_check;
ALTER TABLE chat_message ADD CONSTRAINT chat_message_body_check CHECK (length(body) <= 4000);
