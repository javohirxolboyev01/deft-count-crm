# Buxgalteriya CRM

Buxgalteriya firmasi uchun CRM: oylik vazifalar va hisobotlar avtomatik yaratiladi, buxgalter "Bajarildi" bosadi,
rahbar dashboard'da kim nima qilayotganini ko'radi. Ma'lumot Excel (.xlsx) importi bilan keladi; sotuv operatori
yangi mijozlarga qo'ng'iroqlarni shu yerda yuritadi.
Biznes qoidalari: [CLAUDE.md](CLAUDE.md).

- **Backend:** Node.js 20+ · Express 5 · TypeScript · PostgreSQL 16 (toza SQL, Flyway uslubidagi migratsiyalar)
- **Frontend:** React 18 · Vite · TypeScript · Tailwind · TanStack Query · react-i18next (uz/ru)

## Tez ishga tushirish (lokal)

```bash
# 1. PostgreSQL 16: Docker bilan
docker compose up -d            # buxcrm, buxcrm_test, buxcrm_e2e bazalari yaratiladi
#    ...yoki lokal Postgres'da:
#    psql -d postgres -c "CREATE ROLE buxcrm LOGIN PASSWORD 'buxcrm_dev_password'"
#    createdb -O buxcrm buxcrm && createdb -O buxcrm buxcrm_test && createdb -O buxcrm buxcrm_e2e

# 2. Sozlamalar va paketlar
cp .env.example .env
npm install

# 3. Ishga tushirish
npm run dev                     # API: http://localhost:8080/api, Web: http://localhost:5173
```

Demo ma'lumot yo'q: bo'sh bazada birinchi ishga tushishda `.env` dagi `BOOTSTRAP_LEADER_*` bilan rahbar yaratiladi.
Keyin Xodimlar bo'limida buxgalterlarni qo'shing va fayllarni «Mijozlar» bo'limidan yuklang ("Excel yuklash" tugmasi,
fayl turi sarlavhadan aniqlanadi): hisobot jadvali va «Бухгалтер ишлари» fayli. Operator bazasi — Yangi mijozlar.

## Buyruqlar

| Buyruq | Nima qiladi |
|---|---|
| `npm run dev` | API (tsx watch) + Web (Vite, `/api` proksi) |
| `npm test` | Backend testlari (vitest + supertest, `buxcrm_test` bazasi har faylda noldan) |
| `npm run test:e2e -w apps/web` | Playwright smoke testlari (`buxcrm_e2e` bazasi, 8090/5174 portlar). Birinchi marta: `npx playwright install chromium` |
| `npm run build` | API (`apps/api/dist`) va Web (`apps/web/dist`) build |
| `npm run db:migrate` | Migratsiyalarni qo'llash (API ishga tushganda ham avtomatik) |
| `npm run lint -w apps/web` | ESLint |
| `scripts/backup.sh` | Zaxira nusxa (pg_dump, 14 kun saqlanadi) — [docs/restore.md](docs/restore.md) |

## `.env` o'zgaruvchilari

| O'zgaruvchi | Ma'nosi |
|---|---|
| `DATABASE_URL`, `TEST_DATABASE_URL` | PostgreSQL ulanishlari |
| `PORT` | API porti (standart 8080) |
| `CORS_ORIGIN` | Frontend manzili (vergul bilan bir nechta) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Kamida 32 belgi, bir-biridan farqli. Prod'da zaif bo'lsa API ishga tushmaydi |
| `BOOTSTRAP_LEADER_LOGIN/PASSWORD/NAME` | Bo'sh bazada birinchi rahbar |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Telegram bot (ixtiyoriy). Bo'sh bo'lsa faqat ilova ichidagi bildirishnoma |
| `SCHEDULER_ENABLED` | Generator, dispatcher, eslatma (standart `true`) |
| `BACKUP_ENABLED`, `BACKUP_DIR` | API ichidan kunlik zaxira (02:30) |

## Tuzilma

```
apps/api/
  migrations/V0..V5__*.sql   sxema, seed (6.2/6.3 jadvallari), view va SQL funksiyalar
  src/common/                auth middleware, xato formati, audit, vaqt, normalizatsiya
  src/modules/               auth, users, clients, settings, tasks(+taskService), generator,
                             grid, notifications, events (SSE), telegram, dashboard(+audit), sheets/
  tests/                     vitest testlari, e2e server
apps/web/src/
  pages/                     Login, Dashboard, MyDay, Clients, ClientCard, Monthly, Settings,
                             Users, Notifications, Profile, Audit, Sheets
  components/                Layout, TaskPanel, UrgentDialog, TaskCard, ui/*
  i18n/                      uz.ts, ru.ts (ru tipi uz'ga bog'langan: kalit yetishmasa build yiqiladi)
docs/restore.md              zaxiradan tiklash
scripts/backup.sh            kunlik zaxira
```

## Asosiy arxitektura qarorlari

- **"X" qoidasi bitta joyda.** `fn_report_applicability(period)` SQL funksiyasi `report_type.applies_to_*`,
  mijozning shu davrdagi soliq turi (`client_tax_type_history`), holati va dividend belgisidan "qo'llanadimi" ni
  hisoblaydi. Generator ham, oylik jadval (`fn_monthly_grid`, `v_monthly_grid`) ham shundan o'qiydi — kodda qotirilmagan.
- **Idempotent generator.** `ux_task_generated` partial unique indeks + `ON CONFLICT DO NOTHING`; bekor qilingan vazifa
  qayta qo'llansa qayta ochiladi (dublikat emas). Server 1-kuni o'chiq bo'lsa ham ishga tushganda joriy oy yaratiladi.
- **creates_accountant_task=false hisobotlar** buxgalterga biriktirilmaydi (`assignee_id = NULL`): "Mening kunim"da
  chiqmaydi, lekin oylik jadval katagi uchun yozuv bor (bosib belgilash, Sheets sinxron, dashboard foizi ishlaydi).
- **Bajarildi + undo.** Rahbarga xabar `deliver_at = now + 6s` bilan navbatga qo'yiladi, undo esa faqat 5 soniya ichida
  ruxsat etiladi — dispatcher bilan poyga bo'lmaydi. Undo `cancelled_at` qo'yadi, xabar yuborilmaydi.
- **Real vaqt: SSE** (`/api/events`). Bir tomonlama oqim yetarli; ~10 xodim, bitta instansiya. Ko'p instansiyada
  `LISTEN/NOTIFY` kerak bo'ladi. Polling (60 s) zaxira sifatida.
- **Auth.** Access JWT (15 daqiqa) xotirada, refresh token httpOnly `SameSite=Strict` cookie'da, har yangilashda aylanadi;
  eski token qayta ishlatilsa barcha sessiyalar yopiladi (30 soniyalik parallel-tab oynasi bundan mustasno).
  5 marta xato parol — 15 daqiqa blok + IP bo'yicha rate limit. Har so'rovda foydalanuvchi bazadan tekshiriladi
  (faolsizlantirilgan xodim darhol uziladi).
- **Audit faqat qo'shiladi:** DB triggeri `UPDATE/DELETE/TRUNCATE` ni taqiqlaydi. Generator oyiga bitta umumiy yozuv
  qoldiradi (har vazifa uchun emas), qolgan barcha yozish amallari alohida yoziladi.
- **Excel import:** «Mijozlar» bo'limida bitta tugma (`/api/sheets/import`), fayl turi sarlavhadan aniqlanadi
  (V51: hamma mijoz Hisobot topshirishda, «Бухгалтер ишлари» fayli — Buxgalter ishlarida ham). Avval dry-run (ROLLBACK bilan haqiqiy mantiq), bir xil fayl (SHA-256)
  qayta yozilmaydi. Avtomatik ajratib bo'lmagan qatorlar "Qo'lda tekshirish" ro'yxatiga tushadi.
  Google Sheets sinxron V19 da olib tashlangan (ishlatilmagan).

## Deploy (qisqacha)

1. Serverda PostgreSQL 16, Node.js 20+, nginx (HTTPS).
2. `npm ci && npm run build`; `.env` ni prod qiymatlari bilan to'ldiring (`NODE_ENV=production`, kuchli JWT kalitlari).
3. API: `node apps/api/dist/index.js` (systemd yoki pm2). Migratsiyalar ishga tushganda qo'llanadi.
4. nginx: `apps/web/dist` ni statik beradi, `/api` ni `localhost:8080` ga proksi qiladi. SSE uchun
   `proxy_buffering off; proxy_read_timeout 1h;` (`/api/events`). SPA uchun `try_files $uri /index.html`.
5. Zaxira: `BACKUP_ENABLED=true` yoki cron (`scripts/backup.sh` ichida misol). Tiklash: [docs/restore.md](docs/restore.md).
6. Telegram: @BotFather'dan token → `TELEGRAM_BOT_TOKEN`. Xodim profil sahifasidan kod olib, botga `/start <kod>` yuboradi.

## Ochiq masalalar — `TODO(tasdiqlash)`

| # | Joy | Taxmin |
|---|---|---|
| 1 | `V2__settings.sql` | Poruchenya JShDS muddat kuni noma'lum (`due_day = NULL`, muddatsiz) |
| 2 | `clients.ts` (dividend) | Dividend belgisini rahbar yoki mijozning buxgalteri qo'yadi |
| 3 | `V2__settings.sql` | Faqat INPS `creates_accountant_task = true` |
| 4 | `sheets/parse.ts` | Import davri = sarlavhadagi muddat sanasining oyi (15.10 → oktyabr) |
| 5 | `V2__settings.sql` (`task_due_time`) | Muddat soati 18:00 (23:59 emas); Sozlamalar → Umumiy'da o'zgartiriladi |
| 6 | `generator.ts` | Oylik doimiy ishlar muddati — oyning oxirgi kuni |
| 7 | `clients.ts` (PATCH) | Buxgalter mijoz kartasida faqat aloqa ma'lumotlari va izohni o'zgartiradi |
| 8 | `V1__users_clients.sql` | STIR 9 raqam yoki JShShIR 14 raqam |
| 9 | `grid.ts` | `creates_accountant_task=false` hisobot katagini rahbar va mijozning buxgalteri belgilay oladi |

## CLAUDE.md bilan solishtirish

| Bo'lim | Holat | Izoh |
|---|---|---|
| 1. Maqsad | ✅ | |
| 2. Texnologiya | ✅ (o'zgartirilgan) | Spring Boot o'rniga Node.js/Express (CLAUDE.md 2-bo'limida ruxsat etilgan variant); Prisma o'rniga toza SQL (trigger, partial index, view kerak) |
| 4. Rollar | ✅ | Serverda tekshiriladi; UI faqat yashiradi |
| 5. Model | ✅ | `period` — `date` (oyning 1-kuni); `task.status` ga `CANCELLED` qo'shilgan (reconcile uchun) |
| 6.2–6.3 | ✅ | Seed AYNAN jadvaldan; testlar matritsani tekshiradi |
| 6.4–6.7 | ✅ | Taymer, ranglar, undo, eslatma (muddat o'tsa bir marta) |
| 6.8–6.11 | ✅ | |
| 7. Sheets | ✅ (o'zgartirilgan) | Google sinxron olib tashlandi (rahbar qarori): faqat Excel import, «Mijozlar» bo'limida (V51) |
| 8. Yo'q narsalar | ✅ | Mijozga xabar yuborilmaydi; `.xlsx` yuklash faqat bir martalik import uchun |
| 9. Zaxira/xavfsizlik | ✅ | HTTPS — nginx darajasida |

Qilinmagan: `docs/openapi.json` (LAYERS B10/F0 — frontend tiplari `apps/web/src/lib/types.ts` da qo'lda yozilgan).
