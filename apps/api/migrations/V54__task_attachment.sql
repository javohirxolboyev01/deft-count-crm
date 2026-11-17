-- Yangi vazifaga fayl (rahbar qarori 2026-11-17): rasm, video, ovoz (brauzerda yozilgan yoki audio fayl), hujjat.
-- Ombor — ichki chat bilan bir xil Telegram yopiq kanali (TELEGRAM_STORAGE_CHAT_ID): bazada faqat Telegram havolasi.
-- Fayl faqat vazifa yaratilayotganda qo'shiladi: oyna ochiqligida yuklanadi (task_id NULL, created_by egasi),
-- vazifa yuborilganda unga bog'lanadi. Bog'lanmay qolgani (oyna yopilgan) bir kundan keyin bazadan o'chadi
-- (kanalda arxiv bo'lib qoladi).
CREATE TABLE task_attachment (
  id                 bigserial PRIMARY KEY,
  task_id            bigint REFERENCES task (id),
  kind               text NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'VOICE', 'FILE')),
  mime               text NOT NULL,
  file_name          text,
  size_bytes         integer NOT NULL CHECK (size_bytes > 0),
  duration_sec       integer CHECK (duration_sec >= 0),
  width              integer CHECK (width > 0),
  height             integer CHECK (height > 0),
  waveform           smallint[] CHECK (cardinality(waveform) <= 100 AND 0 <= ALL (waveform) AND 31 >= ALL (waveform)),
  tg_file_id         text NOT NULL,
  tg_file_unique_id  text NOT NULL,
  tg_chat_id         text NOT NULL,
  tg_message_id      bigint NOT NULL,
  created_by         bigint NOT NULL REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_task_attachment_task ON task_attachment (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX ix_task_attachment_pending ON task_attachment (created_by) WHERE task_id IS NULL;
