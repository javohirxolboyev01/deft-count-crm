-- IP telefoniya (Asterisk) qo'ng'iroqlar jurnali — rahbar tasdiqlagan "a" variant: faqat jurnal va statistika.
-- CRM'dan qo'ng'iroq qilinmaydi (CLAUDE.md 8). Asterisk CDR fayliga (cdr_csv, Master.csv) yozadi;
-- ofisdagi serverda turgan pbx-agent yangi qatorlarni HTTPS orqali POST /api/calls/ingest ga yuboradi.
-- Qaror: agent "soqov" — qatorni fayldagidek yuboradi, yo'nalish/xodim/mijozni server aniqlaydi
-- (qoida bir joyda, test qilinadi, agentni qayta o'rnatmasdan tuzatiladi).

-- Xodimning ichki raqami (Asterisk extension / PJSIP endpoint nomi, masalan '101')
ALTER TABLE app_user ADD COLUMN phone_ext text CHECK (phone_ext ~ '^[0-9A-Za-z_.-]{1,32}$');
CREATE UNIQUE INDEX ux_app_user_phone_ext ON app_user (phone_ext) WHERE deleted_at IS NULL AND phone_ext IS NOT NULL;

-- Telefon matnidan qidiruv kalitlari: har raqam uchun oxirgi 9 ta raqam (O'zbekiston milliy raqami).
-- "+998 90 123-45-67, 93 111 22 33" -> {901234567, 931112233}. 9 tadan qisqa bo'laklar (ichki raqam) tashlanadi.
CREATE FUNCTION fn_phone_keys(p text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT right(d, 9)), '{}')
  FROM (SELECT regexp_replace(part, '\D', '', 'g') AS d
        FROM regexp_split_to_table(coalesce(p, ''), '[,;/\n]') AS part) s
  WHERE length(d) >= 9
$$;

CREATE INDEX ix_client_phone_keys ON client USING gin (fn_phone_keys(phone));
CREATE INDEX ix_lead_phone_keys ON lead USING gin (fn_phone_keys(phone));

CREATE TABLE call_log (
  id              bigserial PRIMARY KEY,
  -- Takrordan himoya: agent har CDR qatoridan sha1 hisoblaydi (qayta yuborilsa ham bitta yozuv)
  source_key      text NOT NULL UNIQUE,
  uniqueid        text,
  direction       text NOT NULL CHECK (direction IN ('IN', 'OUT', 'INTERNAL', 'UNKNOWN')),
  src             text,
  dst             text,
  -- Tashqi raqam (oxirgi 9 raqam); ichki qo'ng'iroqda NULL.
  -- Mijoz/lead bog'lanishi saqlanmaydi, o'qishda telefon bo'yicha hisoblanadi (fn_phone_keys):
  -- telefon kartaga keyinroq yozilsa yoki o'zgarsa, eski qo'ng'iroqlar ham to'g'ri bog'lanadi.
  external_number text,
  -- Xodim tomonidagi ichki raqam va xodim. user_id qo'ng'iroq paytidagi egasi (raqam keyin boshqaga
  -- berilsa tarix o'zgarmaydi); raqam keyinroq biriktirilsa, bo'sh user_id'lar to'ldiriladi (users.ts).
  ext             text,
  user_id         bigint REFERENCES app_user (id),
  -- Ichki qo'ng'iroqda ikkinchi tomon
  peer_ext        text,
  peer_user_id    bigint REFERENCES app_user (id),
  started_at      timestamptz NOT NULL,
  answered_at     timestamptz,
  ended_at        timestamptz,
  duration_sec    int NOT NULL DEFAULT 0,
  -- Gaplashilgan vaqt (javob berilgandan keyin)
  billsec         int NOT NULL DEFAULT 0,
  -- ANSWERED | NO ANSWER | BUSY | FAILED | CONGESTION (Asterisk qiymati boricha)
  disposition     text NOT NULL,
  raw             jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_call_log_started ON call_log (started_at DESC);
CREATE INDEX ix_call_log_user ON call_log (user_id, started_at DESC);
CREATE INDEX ix_call_log_external ON call_log (external_number);
