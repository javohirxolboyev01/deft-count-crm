-- Mijozni o'chirish (rahbar so'rovi, 2026-11-16): «Mijozlar → Shartnoma tugagan» ro'yxatidan keraksiz firmalar o'chiriladi.
-- Yumshoq o'chirish: mijoz hech qayerda ko'rinmaydi, lekin bajarilgan vazifalari (statistika) va audit tarixda qoladi.
-- STIR bo'shatiladi (eski qiymati audit_log'da): shu firma keyin qayta qo'shilsa yoki fayldan kelsa — yangi mijoz bo'ladi.
ALTER TABLE client ADD COLUMN deleted_at timestamptz;
ALTER TABLE client ADD CONSTRAINT ck_client_deleted_ended
  CHECK (deleted_at IS NULL OR (NOT in_reports AND NOT in_works AND stir IS NULL));
