-- "Qo'lda tekshirish" yozuvi kartaning qaysi maydoni bilan tuzatiladi: maydon o'zgartirilib saqlansa yozuv o'zi
-- yopiladi, "Hal qilindi" tugmasi kerak emas (rahbar qarori). Bo'sh massiv — faqat "tekshiring": karta saqlanganda.
-- Qoidalar src/modules/sheets/review.ts (reviewFields) bilan bir xil; xabar "<korxona>: <matn>" ko'rinishida.
ALTER TABLE sheet_sync_error ADD COLUMN fields text[] NOT NULL DEFAULT '{}';

UPDATE sheet_sync_error SET fields = CASE
  WHEN message LIKE '%: STIR tizimda boshqa mijozga%' THEN ARRAY['name', 'stir']
  WHEN message LIKE '%: Nomi bo''yicha%' THEN '{}'
  WHEN message LIKE '%: STIR%' THEN ARRAY['stir']
  WHEN message LIKE '%: Soliq turi%' THEN ARRAY['taxType']
  WHEN message LIKE '%: Izohdagi soliq turi%' OR message LIKE '%: Izohda soliq turi%' THEN ARRAY['taxType', 'taxTypeEffectiveFrom', 'note']
  WHEN message LIKE '%: Barcha hisobotlar X%' THEN ARRAY['status']
  WHEN message LIKE '%: Buxgalter %' THEN ARRAY['accountantId']
  WHEN message LIKE '%: Oylik to''lov%' THEN ARRAY['monthlyFee']
  WHEN message LIKE '%: Bank-kalit%' THEN ARRAY['bankKey']
  WHEN message LIKE '%: Xodim soni%' THEN ARRAY['employeeCount']
  WHEN message LIKE '%: my.mehnat.uz sanasi%' THEN ARRAY['mehnatCheckedAt']
  WHEN message LIKE '%X bo''lishi kerak)' THEN ARRAY['taxType']
  ELSE '{}'
END;
