-- Firma Telegram akkaunti CRM ichida (rahbar qarori 2026-11-17, "A" varianti): rahbar bir marta firma raqami va
-- Telegram yuborgan kod bilan ulaydi, keyin rahbar va buxgalterlar CRM'dan shu akkaunt chatlarini o'qib-yozadi.
-- Qaror: xabarlar va fayllar bazada SAQLANMAYDI — har safar Telegram'dan olinadi (ombor Telegram'ning o'zi).
-- Bazada faqat: shifrlangan sessiya (bitta qator) va "qaysi xabarni CRM'dan qaysi xodim yozgan" belgisi.

-- Bitta akkaunt (id = 1). session_enc — GramJS StringSession, AES-256-GCM (common/secretBox, CREDENTIALS_KEY).
-- Sessiya akkauntga to'liq kirish beradi: brauzerga hech qachon chiqmaydi, audit'ga yozilmaydi.
CREATE TABLE tg_account (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  session_enc   text NOT NULL,
  phone         text,
  tg_user_id    bigint,
  display_name  text,
  connected_by  bigint REFERENCES app_user (id),
  connected_at  timestamptz NOT NULL DEFAULT now()
);

-- CRM'dan yuborilgan xabar muallifi. peer_id — Telegram "marked" id (foydalanuvchi > 0, guruh < 0, superguruh -100…),
-- message_id — shu chatdagi xabar id'si. Telefondan/Telegram ilovasidan yozilganlar bu yerda bo'lmaydi.
CREATE TABLE tg_sent_message (
  peer_id     bigint NOT NULL,
  message_id  bigint NOT NULL,
  user_id     bigint NOT NULL REFERENCES app_user (id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (peer_id, message_id)
);
