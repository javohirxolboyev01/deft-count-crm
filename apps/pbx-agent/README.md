# pbx-agent — Asterisk qo'ng'iroqlarini CRM'ga yuborish

Asterisk har bir qo'ng'iroqni `/var/log/asterisk/cdr-csv/Master.csv` fayliga yozadi (CDR).
Agent shu fayldagi yangi qatorlarni o'qiydi va HTTPS orqali CRM'ga yuboradi.
Suhbat audio yozuvlarini ham (`/var/spool/asterisk/monitor`) yuboradi. CRM ularni Telegram yopiq kanaliga saqlaydi,
CRM'da faqat rahbarlar eshitadi. Yozuvlar serverdan o'chirilmaydi.

- **Asterisk konfiguratsiyasi o'zgartirilmaydi.** Agent faqat faylni o'qiydi.
- **Serverda port ochilmaydi.** Ulanish faqat serverdan CRM'ga chiquvchi HTTPS.
- **Qo'shimcha dastur o'rnatilmaydi.** Faqat `python3` (3.8+) kerak.
- Internet uzilsa, agent kutib turadi va keyin qolgan qo'ng'iroqlarni yuboradi. Bir qo'ng'iroq ikki marta yozilmaydi.

## O'rnatish (serverchi uchun, root sifatida)

```bash
python3 --version                                  # 3.8 yoki undan yangi bo'lishi kerak
ls -l /var/log/asterisk/cdr-csv/Master.csv          # CDR fayli shu yerda ekanini tekshirish

mkdir -p /opt/pbx-agent
cp pbx_agent.py /opt/pbx-agent/
# Tayyor pbx-agent.env berilgan bo'lsa — o'shani, aks holda namunani nusxalang
cp pbx-agent.env /etc/pbx-agent.env 2>/dev/null || cp pbx-agent.env.example /etc/pbx-agent.env
chmod 600 /etc/pbx-agent.env
nano /etc/pbx-agent.env                             # CRM_URL va PBX_INGEST_TOKEN to'g'riligini tekshiring

# Tekshirish: oxirgi 5 qatorni qanday tushunganini ko'rsatadi, hech narsa yubormaydi
set -a; . /etc/pbx-agent.env; set +a
python3 /opt/pbx-agent/pbx_agent.py --dry-run

cp pbx-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pbx-agent
journalctl -u pbx-agent -f                          # "yuborildi: {'inserted': N ...}" chiqishi kerak
```

`--dry-run` natijasida `src`, `dst`, `start`, `disposition` maydonlarida to'g'ri qiymat turganini tekshiring.
Agar ustunlar siljigan bo'lsa (`cdr.conf` dagi `[csv]` sozlamasi boshqacha bo'lsa), `/etc/pbx-agent.env` faylidagi
`CDR_COLUMNS` qatoriga ustun nomlarini fayldagi tartibda yozing.

Agar `asterisk` foydalanuvchisi bo'lmasa, `pbx-agent.service` dagi `User=` va `Group=` qatorlarini
`Master.csv` faylini o'qiy oladigan foydalanuvchiga almashtiring.

Birinchi ishga tushishda fayldagi **eski qo'ng'iroqlar ham** yuboriladi va statistikaga kiradi.
Eski qo'ng'iroqlar kerak bo'lmasa, birinchi marta `--from-end` bilan ishga tushiring.

## Audio yozuvlar

- Agent `REC_DIR` papkasini (ichki papkalari bilan) har 30 soniyada tekshiradi. Yozilib bo'lgan fayllarni
  (oxirgi o'zgarishidan 2 daqiqa o'tgan) yuboradi.
- Fayl nomida Asterisk UNIQUEID bo'lishi kerak (masalan `...-1762750800.123.wav` yoki `1762750800.123.wav`).
  CRM yozuvni qo'ng'iroqqa shu raqam orqali bog'laydi. Odatdagi `MixMonitor(${UNIQUEID}.wav)` shunday nom beradi.
  CDR faylida ham `uniqueid` ustuni bo'lishi kerak (`cdr.conf` → `[csv]` → `loguniqueid=yes`).
- **ffmpeg o'rnatish tavsiya etiladi** (`apt install ffmpeg`). U bo'lsa yozuv OGG formatiga siqiladi va 1 soatlik suhbat
  taxminan 10 MB bo'ladi. ffmpeg bo'lmasa asl WAV yuboriladi: soatiga ~60 MB. Telegram 50 MB dan katta faylni
  qabul qilmaydi, CRM'da esa 20 MB gacha bo'lgan yozuvni eshitish mumkin.
- Telegram cheklovi sababli agent daqiqasiga ~17 tadan ko'p yozuv yubormaydi. Birinchi ishga tushishda eski
  yozuvlar bir necha soat ichida asta-sekin yuklanadi. Faqat yangi yozuvlar kerak bo'lsa, `REC_SINCE` ga sana yozing.
- Qaysi yozuv yuborilgani `/var/lib/pbx-agent/recordings.json` faylida saqlanadi.

## CRM tomonida

1. Railway'da `PBX_INGEST_TOKEN` o'zgaruvchisini qo'ying (`openssl rand -hex 32`). Xuddi shu qiymat `/etc/pbx-agent.env` ga yoziladi.
2. Rahbar «Xodimlar» sahifasida har bir xodimga ichki raqamini (masalan `101`) kiritadi.
   Raqam keyinroq kiritilsa ham, shu raqamdan oldin qilingan qo'ng'iroqlar o'sha xodimga o'tadi.
3. Railway'da `TELEGRAM_CALLS_CHAT_ID` ga yozuvlar uchun alohida yopiq kanal id'sini qo'ying. Kanalga bot admin
   qilinadi, a'zolari faqat rahbarlar bo'ladi. Bo'sh qoldirilsa chat fayllari kanali ishlatiladi.
4. Mijoz va lead kartalarida qo'ng'iroqlar telefon raqami bo'yicha ko'rinadi (oxirgi 9 raqam solishtiriladi).

## Muammo bo'lsa

| Belgi | Sabab |
|---|---|
| `CRM xatosi 401` | Token CRM'dagi bilan bir xil emas |
| `CRM xatosi 404` | CRM'da `PBX_INGEST_TOKEN` qo'yilmagan |
| `aloqa yo'q` | Serverdan internetga yoki CRM manziliga chiqib bo'lmayapti |
| `CRM xatosi (yozuv) 503` | CRM'da Telegram bot yoki kanal sozlanmagan yoki Telegram vaqtincha band. Agent keyin qayta urinadi |
| Yozuv qo'ng'iroq qatorida chiqmayapti | Fayl nomida UNIQUEID yo'q yoki CDR'da `uniqueid` ustuni yozilmayapti |
| Xodim ustunida bo'sh | Ichki raqam hali xodimga biriktirilmagan («Qo'ng'iroqlar» sahifasining yuqorisida ko'rinadi) |
