-- Chatda istalgan hujjat (PDF, Excel, Word, arxiv...) — Telegram'dagi "Fayl" (rahbar qarori).
-- Rasm/video/ovozdan farqi: brauzerda ochilmaydi, faqat yuklab olinadi (Content-Disposition: attachment).
ALTER TABLE chat_attachment DROP CONSTRAINT chat_attachment_kind_check;
ALTER TABLE chat_attachment ADD CONSTRAINT chat_attachment_kind_check
  CHECK (kind IN ('IMAGE', 'VIDEO', 'VOICE', 'VIDEO_NOTE', 'FILE'));
