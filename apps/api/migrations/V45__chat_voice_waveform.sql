-- Ovozli xabar to'lqini (Telegram kabi): yozish paytida brauzer hisoblaydi, 0..31 oralig'idagi ≤ 100 ta ustun.
-- Faqat ko'rinish uchun metadata (fayl Telegram kanalida qoladi); eski xabarlarda NULL — fayl ochilganda hisoblanadi.
ALTER TABLE chat_attachment
  ADD COLUMN waveform smallint[] CHECK (cardinality(waveform) <= 100 AND 0 <= ALL (waveform) AND 31 >= ALL (waveform));
