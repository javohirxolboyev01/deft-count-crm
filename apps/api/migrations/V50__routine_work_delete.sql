-- Oylik ishni o'chirish (rahbar so'rovi). Vazifasi bo'lmagan ish butunlay o'chiriladi (server);
-- vazifasi bor ish yumshoq o'chiriladi: sozlamalar ro'yxatidan yo'qoladi, bajarilgan vazifalar tarixda qoladi.
ALTER TABLE routine_work_type ADD COLUMN deleted_at timestamptz;
ALTER TABLE routine_work_type ADD CONSTRAINT routine_work_deleted_inactive CHECK (deleted_at IS NULL OR NOT active);
