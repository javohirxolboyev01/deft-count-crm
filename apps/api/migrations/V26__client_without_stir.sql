-- "Qo'lda tekshirish"dagi korxonalar ham jadvalda boricha ko'rinsin (rahbar qarori): STIR'i yo'q yoki noto'g'ri
-- (#REF!), bir faylda takroriy yoki tizimda boshqa nomdagi mijozga tegishli qator endi tashlanmaydi —
-- STIR'siz mijoz bo'lib yoziladi, fayldagi matn stir_raw'da; rahbar kartada to'g'ri STIR kiritadi.
-- Qayta importda bunday mijoz nomi (name_normalized) bo'yicha topiladi. UNIQUE (stir) NULL'larga ta'sir qilmaydi.
ALTER TABLE client ALTER COLUMN stir DROP NOT NULL;
ALTER TABLE client ADD COLUMN stir_raw text;
CREATE INDEX ix_client_no_stir_name ON client (name_normalized) WHERE stir IS NULL;

-- Kamchilik yozuvi mijozga to'g'ridan-to'g'ri bog'lanadi (STIR'siz mijozni STIR orqali topib bo'lmaydi)
ALTER TABLE sheet_sync_error ADD COLUMN client_id bigint REFERENCES client (id) ON DELETE SET NULL;
UPDATE sheet_sync_error e SET client_id = c.id FROM client c WHERE c.stir = e.stir AND e.client_id IS NULL;
