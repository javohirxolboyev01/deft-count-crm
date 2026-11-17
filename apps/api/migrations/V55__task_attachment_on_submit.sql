-- Vazifa fayllari endi faqat "Yuborish" bosilganda, vazifa bilan bitta so'rovda yuklanadi (rahbar qarori 2026-11-17).
-- Oyna ochiqligida oldindan yuklash (V54, task_id NULL) bekor: bog'lanmagan qatorlar o'chiriladi
-- (kanaldagi postlari arxiv bo'lib qoladi), har fayl endi albatta vazifaga tegishli.
DELETE FROM task_attachment WHERE task_id IS NULL;
ALTER TABLE task_attachment ALTER COLUMN task_id SET NOT NULL;
DROP INDEX ix_task_attachment_pending;
