-- Qo'ng'iroq audio yozuvlari (rahbar qarori): Asterisk yozgan fayllarni pbx-agent CRM'ga yuboradi, CRM ularni
-- Telegram yopiq kanaliga yuklaydi (chat fayllari kabi, V43). Bazada faqat file_id va kanal posti saqlanadi.
-- Yozuvlar o'chirilmaydi (kanalda doimiy turadi). Eshitish — faqat rahbar (calls.ts).
-- Qo'ng'iroqqa bog'lanish: fayl nomidagi Asterisk UNIQUEID = call_log.uniqueid. Yozuv CDR qatoridan oldin ham,
-- keyin ham kelishi mumkin, shuning uchun bog'lanish o'qishda hisoblanadi.

CREATE TABLE call_recording (
  id                bigserial PRIMARY KEY,
  -- Agent ombordagi nisbiy yo'l (masalan '2026/11/10/out-998901234567-101-20261110-090000-1762750800.1.wav'):
  -- takroriy yuborishdan himoya
  source_path       text NOT NULL UNIQUE,
  uniqueid          text,
  file_name         text NOT NULL,
  mime              text NOT NULL,
  size_bytes        int NOT NULL,
  tg_file_id        text NOT NULL,
  tg_file_unique_id text NOT NULL,
  tg_chat_id        text NOT NULL,
  tg_message_id     bigint NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_call_recording_uniqueid ON call_recording (uniqueid) WHERE uniqueid IS NOT NULL;
CREATE INDEX ix_call_log_uniqueid ON call_log (uniqueid) WHERE uniqueid IS NOT NULL;
