-- "Qo'lda tekshirish" yozuvi qaysi jadvalga tegishli: har sahifa (Hisobot topshirish / Buxgalter ishlari) faqat
-- o'z faylining kamchiliklarini ko'rsatadi va o'z importida faqat o'zinikini yopadi (rahbar qarori).
ALTER TABLE sheet_sync_error ADD COLUMN section text;

-- Eski yozuvlar: import yozuvi va audit_log bir tranzaksiyada (bir xil now()) — audit action'idan fayl turi.
-- Topilmagani (kataklarni keyin qo'llash, ref = davr) hisobot jadvaliga tegishli.
UPDATE sheet_sync_error e SET section = 'WORKS'
WHERE EXISTS (SELECT 1 FROM audit_log a WHERE a.entity = 'sheet_import' AND a.action = 'IMPORT_WORKS' AND a.at = e.occurred_at);
UPDATE sheet_sync_error SET section = 'REPORTS' WHERE section IS NULL;

ALTER TABLE sheet_sync_error ALTER COLUMN section SET NOT NULL;
ALTER TABLE sheet_sync_error ADD CONSTRAINT sheet_sync_error_section_check CHECK (section IN ('REPORTS', 'WORKS'));

-- Izoh farqi endi kamchilik emas (izoh ma'lumoti ogohlantirishga aloqador emas): ochiqlari yopiladi
UPDATE sheet_sync_error SET resolved = true, resolved_at = now()
WHERE NOT resolved AND message LIKE '%: Izoh farq qiladi: %';
