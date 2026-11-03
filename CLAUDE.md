# Buxgalteriya firmasi uchun CRM

Buxgalterlar ishini avtomatlashtirish va rahbar nazorati uchun tizim.
Bu fayl loyiha ildizida `CLAUDE.md` nomi bilan turadi. Har bosqichda shu kontekstga tayaning.

## 1. Maqsad

- ~100 mijoz (80 faol, 20 nol hisobot), 7 buxgalter, 3 rahbar.
- Vazifalar (oylik doimiy ishlar + hisobotlar) har oy o'zi yaratiladi.
- Buxgalter "Bajarildi" bosadi, rahbarga bildirishnoma boradi.
- Rahbar kim nima qilayotganini, nima kechikayotganini bir qarashda ko'radi.
- Ma'lumot Excel (.xlsx) importi bilan keladi: har sahifa o'z faylini yuklaydi. Google Sheets sinxron **yo'q** (rahbar qarori, ishlatilmaydi).
- Interfeys tillari: o'zbek (lotin) va rus.
- Barcha sana/vaqt mantiqi: `Asia/Tashkent`.

## 2. Texnologiya (0-bosqichda tanlangan: Node.js varianti)

- Monorepo (npm workspaces): `apps/web`, `apps/api`, `docker-compose.yml`.
- Frontend: React 18, TypeScript, Vite, Tailwind CSS, shadcn uslubidagi lokal komponentlar (`apps/web/src/components/ui`), TanStack Query, react-i18next.
- UI dizayni WinPro admin CRM bilan bir xil: teal brend (`brand-500` #37a0ad), navy (#1a344d) matn, Inter shrifti, `bg-page` foni ustida oq `section-container` bloklar, chap yig'iladigan sidebar, teal sarlavhali jadvallar (`table-head`). Tokenlar `apps/web/tailwind.config.js`, umumiy sinflar `apps/web/src/index.css`da. Neytral rang — `gray-*` (qorong'i rejimda avtomatik aylanadi); `brand-*` aylanmaydi, qorong'i variant `dark:` bilan yoziladi; rangli fon ustidagi oq matn — `text-on-brand`.
- Ochiladigan ro'yxat va sana: native `<select>`/`type="date|month|datetime-local"` ishlatilmaydi — WinPro'dagidek `ui/select.tsx` (`Select`, `options` + `onChange(value)`, `clearable` bo'sh qiymatli filtrlar uchun) va `ui/date-picker.tsx` (`DatePicker` 'yyyy-MM-dd', `MonthPicker` 'yyyy-MM', luxon asosida). Ikkalasi `ui/popover.tsx` orqali body'ga portal qilinadi (jadval/modal overflow kesmasin).
- Backend: Node.js 20+ / Express 5 / TypeScript, PostgreSQL 16, `pg` (toza SQL), Flyway uslubidagi SQL migratsiyalar (`apps/api/migrations/V<n>__<nom>.sql`, checksum bilan), JWT (access + aylanuvchi refresh cookie), zod validatsiya, `node-cron` rejalashtirish.
- ORM ishlatilmaydi: partial unique index, trigger, view va SQL funksiyalar (X qoidasi) to'g'ridan-to'g'ri SQL'da.
- Bildirishnoma: Telegram bot (faqat xodimlarga, long polling) + ilova ichidagi bildirishnoma (SSE).
- Import: `.xlsx` (exceljs). Google Sheets API ishlatilmaydi.
- Testlar: vitest + supertest (haqiqiy PostgreSQL test bazasi), Playwright smoke (alohida e2e bazasi).

## 3. Ishlash qoidalari (Claude uchun)

- Kichik, aniq o'zgarishlar: faqat so'ralgan narsani qiling, so'ralmagan funksiya qo'shmang.
- Mavjud kod tuzilmasini saqlang, keraksiz refaktoring qilmang.
- To'liq, ishlaydigan fayllar bering, qisman snippet emas.
- Muhim arxitektura qarorini qisqa izoh bilan (nima uchun) yozing.
- Har bosqich oxirida: ishga tushirish buyrug'i, nimalar tekshirildi, nimalar qolgani.
- Taxmin qilgan joyingizni `TODO(tasdiqlash):` bilan belgilang va oxirida ro'yxat qiling.
- Qo'llangan migratsiyani o'zgartirmang (checksum xatosi beradi): yangi `V<n+1>__...sql` yozing.

## 4. Rollar va ruxsatlar

- **Rahbar (3):** hamma mijoz, hamma vazifa, dashboard, sozlamalar, buxgalter tayinlash, shoshilinch vazifa.
- **Buxgalter (7):** faqat o'ziga biriktirilgan mijozlar va ularning vazifalari. Istisno: "Hisobot topshirish" jadvali buxgalterga biriktirilmaydi — barcha korxonalarni ko'radi, lekin faqat ko'radi (katak, holat belgisi, izoh o'zgarmaydi, mijoz kartasiga o'tmaydi).
- **Sotuv operatori (1):** faqat "Yangi mijozlar" (`lead`) bo'limi. Mavjud mijozlar bilan gaplashmaydi, buxgalteriya API'lari unga yopiq (`requireStaff`).
- Ruxsat tekshiruvi **serverda** (frontend yashirishi yetarli emas).

## 5. Ma'lumotlar modeli (asos)

- `user` (role: LEADER | ACCOUNTANT | OPERATOR, til, telegram_chat_id)
- `lead` (operator bazasi, `client`dan alohida): stir (unique), name, director, phone, address, registered_at, status (NEW | NO_ANSWER | CALL_LATER | MEETING | HAS_ACCOUNTANT | REJECTED | WON | CONVERTED), next_call_date, converted_client_id; `lead_call`: har qo'ng'iroq natijasi + izoh. Rahbar Excel yuklaydi (STIR bo'yicha takror va mavjud mijozlar o'tkaziladi). HAS_ACCOUNTANT/REJECTED — yopiladi. WON — rahbarga bildirishnoma (`LEAD_WON`), operatorga ko'rinmaydi. Rahbar mijozga aylantiradi (CONVERTED). Qayta qo'ng'iroq eslatmasi faqat ilovada ("Bugun qo'ng'iroq" ro'yxati).
- `client`: stir (unique), name, name_normalized, contact_person, phone, tax_type (AOS | QQS | NULL = importda tanilmagan, fayldagi matn `tax_type_raw`), tax_type_effective_from, accountant_id, status (ACTIVE | ZERO_REPORT | LIQUIDATING | ARCHIVED), note, in_reports / in_works (qaysi bo'limda, V25)
- `client_tax_type_history`: client_id, tax_type, effective_from (rejim o'zgarsa hisobotlar shu sanadan almashadi)
- `report_type`: code, name, frequency (MONTHLY | QUARTERLY | YEARLY), due_day, applies_to (AOS/QQS), active, creates_accountant_task (INPS = true, qolganlari = false, `TODO(tasdiqlash)`), generation_months (chorak: 1,4,7,10; yillik: 2)
- `routine_work_type`: name, order, active (ko'pi bilan 10 ta; boshlang'ich 8 ta)
- `task`: client_id, kind (ROUTINE | REPORT | URGENT | MANUAL), type_id, period (YYYY-MM), title, note, assignee_id, due_at, status (TODO | IN_PROGRESS | WAITING_CLIENT | DONE), done_at, created_by
  - Unique: (client_id, kind, type_id, period) — takroriy generatsiyadan himoya.
- `task_checklist_item`: task_id, text, done
- `time_entry`: task_id, user_id, started_at, ended_at
- `audit_log`: **faqat qo'shiladi** (UPDATE/DELETE yo'q): actor, entity, entity_id, action, before, after, at
- `notification`: user_id, kind, payload, deliver_at, delivered_at, cancelled_at
- `setting`: key/value (urgent shablonlar, va h.k.)

## 6. Biznes qoidalari

### 6.1 Mijoz kartasi maydonlari
STIR, korxona nomi, mas'ul shaxs (FISH + telefon), soliq turi, javobgar buxgalter, holati (Faol / Nol hisobot / Tugatilmoqda), soliq turi qachondan yangi, izoh.
Mas'ul shaxs telefoni faqat aloqa ma'lumoti (mijozga avtomatik xabar **yuborilmaydi**).

### 6.2 Oylik doimiy ishlar (har oyning 1-kuni, faol mijozlarga)
1. INPS hisoboti
2. Ish haqi hisoblash
3. Bank aylanmalarini kiritish
4. Kirim hisobvaraq-fakturalarini kiritish
5. Chiqim hisobvaraq-fakturalarini kiritish
6. Debitor-kreditorlar bilan ishlash
7. Boshqa ishlar (har oy buxgalter o'zi erkin matn yozadi)
8. Oyni yopish

- Ishlar soni ko'pi bilan 10; rahbar sozlamada qo'shadi/olib tashlaydi/nomini o'zgartiradi; yangi ish keyingi oydan chiqadi.
- INPS ham "ish", ham "hisobot": **bitta** vazifa (ikki marta yaratilmaydi).
- **Nol hisobot** mijozlarga 8 ta oylik ish chiqmaydi, faqat hisobotlar.
- **Tugatilmoqda** mijozga hisobot vazifasi chiqmaydi.
- Buxgalter ishlari sahifasi oyma-oy (`/api/works?month=`): katakda tanlangan oy ishining holati (✓ / ○ / ! / —), bosilsa shu oy ishi "Bajarildi". Ish oyi bo'yicha: INPS ustunida oktyabr = noyabr vazifasi (15.11). Vazifasi yo'q tizimgacha bo'lgan oy — rahbar kiritgan boshlang'ich nuqtadan, ketma-ket yopiladi. Rahbar katakni bosib **1 / 0 / X** tanlaydi (V31, `client_routine_cell`, `fn_routine_applicability`): holat (Nol hisobot, Tugatilmoqda) to'smaydi, tanlov keyingi oylarga o'tadi. INPS hisobot bo'limida ham bo'lsa — Hisobot topshirish katagi bilan bitta (V30). Buxgalter o'z ishini bosib "Bajarildi" qiladi.

### 6.3 Hisobotlar (soliq turiga qarab avtomatik)

| Hisobot | Davr | Muddat | AOS | QQS |
|---|---|---|---|---|
| JShDS | oylik | 15-sana | ha | ha |
| To'lov manbaidan ushlanadigan soliq | oylik | 15-sana | ha | ha |
| AOS | oylik | 15-sana | ha | yo'q |
| QQS | oylik | 20-sana | yo'q | ha |
| INPS | oylik | hisobot oyidan keyingi oyning 15-kuni | ha | ha |
| Poruchenya JShDS (to'lov topshiriqnomasi) | oylik, hamma mijoz | `TODO(tasdiqlash)`: muddat kuni | ha | ha |
| Foyda solig'i | oylik | 20-sana | yo'q | ha |
| Dividend hisoboti | holat bo'yicha: dividend to'langan oydan keyingi oyda | 20-sana (sozlamadan) | ha | ha |
| Norezident foyda (norezident daromadidan to'lov manbaida ushlanadigan foyda solig'i) | holat bo'yicha: norezidentga daromad to'langan oydan keyingi oyda | 20-sana | yo'q | ha |
| Norezident QQS (chet ellik shaxslardan olingan tovar/xizmat bo'yicha QQS) | holat bo'yicha: chet eldan tovar/xizmat olingan oydan keyingi oyda | 20-sana | yo'q | ha |
| Moliyaviy natijalar | oylik | 15-sana | ha | ha |
| Buxgalteriya balansi | oylik | 15-sana | ha | ha |
| Statistika hisoboti | oylik | 15-sana | ha | ha |

#### Asosiy qoida: soliq turi va "X"

Korxonalar 2 sinfga bo'linadi: **QQS to'lovchi** va **AOS to'lovchi**. QQS to'lovchi AOS to'lamaydi.

- Soliq turini **rahbar o'zi tanlaydi** (mijoz kartasida ochiladigan ro'yxat: `QQS` yoki `AOS`, boshqa qiymat yo'q). Buxgalter ko'radi, o'zgartirmaydi (`TODO(tasdiqlash)`).
- Tanlovga qarab hisobot katakchalari **avtomatik** belgilanadi (boshlang'ich qiymat; rahbar jadvalda istalgan katakni 1/0/X qila oladi — V30, pastda):

| Tanlangan tur | AOS | QQS | Foyda solig'i | Qolgan hisobotlar |
|---|---|---|---|---|
| **AOS** | bor | **X** | **X** | bor |
| **QQS** | **X** | bor | bor | bor |

- "X" = topshirilmaydi: vazifa **yaratilmaydi**, oylik jadvalda "—" ko'rinadi (jadvaldagi "X" ning o'zi).
- Katak qiymatlari: `1` faqat **topshirilgandan keyin** yoziladi ("Bajarildi" bosilganda), `0` hali topshirilmagan, `X` topshirilmaydi.
- Haqiqiy jadvaldan misol: SHERPROM STROY (AOS) — QQS va Foyda `X`; INSAR MIX TRADE (QQS) — AOS `X`.
- Tur o'zgarsa (`tax_type_effective_from`): shu sanadan boshlab hisobotlar ro'yxati almashadi. Joriy davrda endi qo'llanmaydigan **ochiq** vazifalar bekor qilinadi (o'chirilmaydi, `audit_log`'da qoladi), yangi qo'llanadiganlari yaratiladi, **bajarilganlari** o'zgarmaydi.
- Qoida kodda qotirilmagan: `report_type.applies_to` ma'lumotidan o'qiladi (6.3 jadvali seed).
- Mijozga xos istisno: import faylida soliq turi bo'yicha topshiriladigan katakda `X` bo'lsa, `client_report_exclusion` (shu oydan doimiy) — vazifa yaratilmaydi, jadvalda X. Faylda 0/1 kelsa yoki rahbar mijoz kartasidan olib tashlasa, belgi o'chadi.

- Generatsiya har oyning 1-kuni; muddat shu oy ichida (Oktyabrda INPS = 15.10, dividend = 20.10).
- Muddat kunlari va "qaysi soliq turiga qaysi hisobot" qoidasi **ma'lumot sifatida** (`report_type`), kodga qotirilmaydi. Qonun o'zgarsa rahbar sozlamadan tuzatadi.
- Holat bo'yicha hisobotlar (`report_type.requires_event_flag`: Dividend, Norezident foyda, Norezident QQS): mijoz kartasida har biri uchun alohida belgi — holat bo'lgan oy (`client_report_event`, faqat joriy yoki o'tgan oy). Hisobot **keyingi** oyda chiqadi ("hisobot oyidan keyingi oyning 20 kunigacha"). Kartada esa **topshirish oyi** ko'rsatiladi ("Oktyabr · 20.10 gacha" = sentabr holati): sahifa va Excel ham topshirish oyi bo'yicha. Belgini rahbar ham, buxgalter ham qo'yadi. Importda shu ustunda 0/1 = holat bo'lgan (belgi qo'yiladi), X = holat yo'q.
- Soliq turi o'zgarsa (`effective_from`), hisobotlar ro'yxati shu sanadan almashadi; o'tgan davrlar o'zgarmaydi.

### 6.4 Vazifa holatlari
`Bajarilishi kerak → Jarayonda → Mijozdan kutilmoqda → Bajarildi`
- "Jarayonda" bosilganda taymer o'zi yoqiladi (`time_entry`), holatdan chiqqanda to'xtaydi.
- "Mijozdan kutilmoqda" kechikish buxgalter aybi emasligini ko'rsatadi.
- Ish 1C'da bajariladi, tizimda faqat holat belgilanadi.

### 6.5 Ranglar
- Qizil: muddati o'tgan
- Sariq: muddatga 24 soatdan kam qoldi
- To'q sariq: mijozdan hujjat kutilmoqda
- Yashil: bajarildi
- "Muddati o'tgan" **saqlanmaydi**, `due_at` va holatdan hisoblanadi.

### 6.6 "Bajarildi" bosilganda
1. Buxgalter "Bajarildi" bosadi (rahbar oylik jadvalda katakchani ham bosishi mumkin).
2. Rahbarga bildirishnoma boradi.
3. Xato bosilsa 5 soniya ichida "Bekor qilish" mumkin.

Qaror: bildirishnoma `deliver_at = now + 5s` bilan navbatga qo'yiladi; "Bekor qilish" holatni qaytaradi va bildirishnomani `cancelled_at` bilan bekor qiladi. Shunda rahbarga xato xabar ketmaydi.

### 6.7 Eslatmalar
- Muddatga 24 soat qolganda vazifa sariq.
- Muddat o'tsa qizil, buxgalter va rahbarga xabar.
- Kechikkan mijozlar (`CLIENTS_OVERDUE`): har kuni `sendAt` soatida bitta yig'ma xabar — buxgalterga o'z mijozlari (vazifa mas'uli, bo'lmasa mijoz buxgalteri), rahbarga hammasi. Kechikish kuni = eng eski ochiq muddati o'tgan vazifadan beri kalendar kunlar. Mijoz faqat "eslatma kuni"da kiradi: `setting.overdue_reminder.steps` (`fromDay`, `everyDays`), standart 1,2,3,5,7,10,13,16,23,30… Rahbar sozlamadan o'zgartiradi.

### 6.8 Buxgalter almashsa
Rahbar mijozga boshqa buxgalter tayinlaydi; tugallanmagan vazifalar yangisiga o'tadi, bajarilganlari eskisida tarixda qoladi. Hammasi `audit_log`'da.

### 6.9 Shoshilinch vazifa (10 soniya)
"+ Shoshilinch": mijoz tanlanadi, matn yoziladi yoki tayyor shablon; tizim **eng kam ochiq vazifali** buxgalterni birinchi taklif qiladi; buxgalter ekranida qizil xabar + Telegram; muddat odatda shu kuni 18:00.

### 6.10 Oylik jadval (Google Sheet ko'rinishi)
Qatorda mijoz, ustunda hisobot va muddati. Katakcha holati vazifadan olinadi:

| Katak | Ma'nosi |
|---|---|
| `1` / ✓ | topshirildi (vazifa DONE) |
| `0` / ○ | hali topshirilmagan (vazifa ochiq) |
| `!` | muddati o'tdi (hisoblanadi) |
| `X` / — | topshirmaydi (vazifa yaratilmaydi, soliq turi/holat sabab) |

Jadval Exceldagidek, detail sahifa yo'q (rahbar qarori). Rahbar katakni bosib **1 / 0 / X** tanlaydi — soliq turi qoidasi to'smaydi (`client_report_cell`, V30; qoida faqat boshlang'ich qiymat). Tanlov keyingi oylarga ham o'tadi (Exceldagi nusxa kabi), holat bo'yicha hisobotda faqat o'z oyi. 1 — vazifa "Bajarildi" (6.6 oqimi, undo); 0 — vazifa ochiq (bajarilgani qayta ochiladi); X — vazifa bekor (bajarilgani ham, audit'da). Fayl importi o'z oyidan boshlab qo'lda tanlovni almashtiradi. STIR, nom, soliq turi (almashsa tasdiq), holat, izoh — katakning o'zida. Soliq turi tarixi va holat belgilari mijoz kartasida (`/clients/:id`). Buxgalter faqat ko'radi (server `requireLeader`).

### 6.11 Dashboard
- Mijozlar bo'yicha: joriy oy tayyor / jarayonda / kechikkan, umumiy foiz, muddati o'tganlar ro'yxati.
- Buxgalterlar bo'yicha: bajargan (kun/hafta/oy), o'z vaqtida foiz, kechikkan, ochiq vazifa (yuklama), ishga sarflangan vaqt.
- "O'z vaqtida" = `done_at <= due_at`.

## 7. Excel import (jadval fayllari)

Haqiqiy jadval ustunlari:
`№ | STIR | Korxona nomi | Soliq turi | JSHDS dd.mm.yyyy | To'lov manbai dd.mm.yyyy | AOS dd.mm.yyyy | QQS dd.mm.yyyy | FOYDA dd.mm.yyyy | INPS | Poruchenya JSHDS | Қилиниши лозим бўлган ишлар`

- Oxirgi ustun **erkin izoh** (masalan "Tugatishga bergan", "01.01.2026 dan AOS to'lovchisi"). Doimiy ishlar ro'yxati emas.
- Migratsiyada izoh uch joyga bo'linadi: `status` (Tugatishga bergan → LIQUIDATING), `tax_type_effective_from` (01.01.2026), `note`. Avtomatik ajratib bo'lmaganlar **qo'lda tekshirish hisobotiga** tushadi, jim taxmin qilinmaydi.
- Kirill/lotin aralashmasi: `AOC`/`AOS`, `ҚҚС`/`QQS` → `tax_type` enumga normallashtiriladi; `name_normalized` (kirill→lotin, kichik harf, MChJ/МЧЖ bir xil) qidiruv uchun.
- Sarlavhadagi sanalar har oyda o'zgaradi (yangi ustun/varaq); ustunni sarlavha matnidan aniqlang, indeksdan emas.
- Import fayl turini sarlavhadan o'zi aniqlaydi: kamida 3 ta doimiy ish ustuni (`routine_work_type.sheet_aliases`) bo'lsa "Бухгалтер ишлари" fayli → Buxgalter ishlari sahifasi (mijoz maydonlari, buxgalter, my.mehnat.uz, har ish uchun "qaysi oygacha bajarilgan"); aks holda hisobot jadvali → Hisobot topshirish sahifasi.
- Jadval **boricha** yuklanadi (V24): tanilmagan qiymat tashlanmaydi va taxmin qilinmaydi. Soliq turi tanilmagan qator (ЯТТ, "Қ АОС", bo'sh) mijoz bo'ladi (`tax_type` NULL, vazifa chiqmaydi), kataklari `client_report_raw`da saqlanib jadvalda fayldagidek ko'rinadi; rahbar kartada turni tanlasa (yoki keyingi faylda kelsa) kataklar o'zi qo'llanadi. Tanilmagan ish katagi (`eri`, `28,02,2025(14)`) `client_routine_raw`da, oy kiritilganda o'chadi. Izohdagi "Ketgan"/"Kerak emas" → ARCHIVED, "bankrot" → LIQUIDATING. Bir faylda takroriy STIR yoki nomi tizimdagidan butunlay farqli STIR qatori yozilmaydi (review). Izohdagi login/parol izohga yozilmaydi.
- Bo'limlar alohida yuklanadi (V25): hisobot jadvali mijozni faqat Hisobot topshirishga (`in_reports`), «Бухгалтер ишлари» fayli faqat Buxgalter ishlariga (`in_works`) qo'shadi. Bir xil STIR ikkinchi bo'lim faylida kelsa — o'sha mijoz, ikkala belgi, ma'lumot bitta. Bo'limida yo'q mijozga o'sha bo'lim vazifalari chiqmaydi (hisobot / doimiy ish); INPS faqat Buxgalter ishlarida bo'lsa doimiy ish, hisobot bo'limida ham bo'lsa bitta hisobot vazifasi. "Yangi mijoz" formasi ham shunday (rahbar qarori): Hisobot topshirishdan qo'shilgani faqat `in_reports`, Buxgalter ishlaridan — faqat `in_works`; shu STIR boshqa bo'limda bo'lsa yangi mijoz emas, o'sha mijozga ikkinchi belgi qo'yiladi (`joined`). Hisobot topshirishda yaratilgach jadvalda qoladi (detail yo'q). Lead'dan aylantirilgan mijoz ikkala bo'limda (`TODO(tasdiqlash)`).
- Har sahifada "Excel yuklash" (faqat rahbar): avval dry-run + hisobot, keyin yuklash. Buxgalter ishlari sahifasi faqat «Бухгалтер ишлари» faylini, Hisobot topshirish faqat hisobot jadvalini qabul qiladi (`kind`, mos kelmasa `WRONG_FILE_KIND`). Bir xil fayl (SHA-256) qayta yozilmaydi. Davriy sinxron yo'q.
- "Qo'lda tekshirish" (V27) har sahifada faqat o'z jadvali faylining kamchiliklari: ma'lumot yo'q yoki tizimdagidan farq qiladi. Import faqat o'z bo'limidagi eski yozuvlarni yopadi. Izoh farqi kamchilik emas: izoh bo'sh bo'lsa fayldan to'ldiriladi, aks holda tizimdagisi qoladi. Kartadagi blokda "Hal qilindi" yo'q (V28): yozuv o'z maydoni (`fields`) o'zgartirilib saqlansa yoki ish katagida oy kiritilsa o'zi yopiladi; maydonsiz "tekshiring" yozuvi karta to'liq saqlanganda (`reviewed`). Sahifadagi "Qo'lda tekshirish" ro'yxatida tugma qoladi.

## 8. Tizimda yo'q (qilmang)

- CRM'dan qo'ng'iroq qilish
- Fayl yuklash
- 1C va soliq.uz bilan avtomatik bog'lanish
- To'lov qabul qilish
- Mijozga SMS/Telegram xabar

## 9. Zaxira va xavfsizlik

- Har kuni DB zaxira nusxasi.
- `audit_log` o'chirib bo'lmaydi (DB darajasida UPDATE/DELETE taqiqlanadi).
- Parollar hash, JWT qisqa muddatli, HTTPS, maxfiy kalitlar `.env`da (git'ga kirmaydi).

## 10. Hali ochiq masalalar (`TODO(tasdiqlash)`)

1. Poruchenya JShDS muddat kuni.
2. "Qolgan hisobotlarni o'zimiz topshiramiz": hozircha faqat INPS buxgalterga vazifa (`creates_accountant_task`), qolganlari oylik jadvalda ko'rinadi. Tasdiqlansa bayroq o'zgartiriladi.
3. JShDS/To'lov manbai/AOS/QQS muddati oy: jadvaldagi sarlavha (15.10, 20.10) bo'yicha joriy oyda deb olingan.
