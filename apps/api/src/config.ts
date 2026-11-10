import path from 'node:path';
import dotenv from 'dotenv';

// .env monorepo ildizida (apps/api dan ikki daraja yuqori), keyin lokal .env
dotenv.config({ path: [path.resolve(__dirname, '../../../.env'), path.resolve(process.cwd(), '.env')] });

const env = process.env.NODE_ENV ?? 'development';

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

export const config = {
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl:
    (env === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL) ??
    (env === 'test' ? 'postgres://localhost:5432/buxcrm_test' : 'postgres://localhost:5432/buxcrm'),
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me-0123456789abcdef',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me-0123456789abcdef',
  accessTtlSec: Number(process.env.JWT_ACCESS_TTL_SEC ?? 15 * 60),
  refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS ?? 7),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  bootstrapLeader: {
    login: process.env.BOOTSTRAP_LEADER_LOGIN ?? '',
    password: process.env.BOOTSTRAP_LEADER_PASSWORD ?? '',
    fullName: process.env.BOOTSTRAP_LEADER_NAME ?? 'Rahbar',
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    username: process.env.TELEGRAM_BOT_USERNAME ?? '',
    // Chat fayllari ombori: bot admin bo'lgan yopiq kanal id'si (-100...). Bo'sh bo'lsa chatda fayl yuborilmaydi
    storageChatId: process.env.TELEGRAM_STORAGE_CHAT_ID ?? '',
    // Qo'ng'iroq audio yozuvlari kanali (V48). Bo'sh bo'lsa chat fayllari kanali ishlatiladi.
    // Alohida kanal tavsiya etiladi: yozuvlarni faqat rahbarlar ko'radigan kanal.
    callsChatId: process.env.TELEGRAM_CALLS_CHAT_ID || process.env.TELEGRAM_STORAGE_CHAT_ID || '',
  },
  // IP telefoniya (Asterisk CDR): ofisdagi pbx-agent shu token bilan POST /api/calls/ingest qiladi. Bo'sh bo'lsa o'chiq
  pbx: {
    ingestToken: process.env.PBX_INGEST_TOKEN ?? '',
    // CDR faylidagi vaqtlar qaysi zonada (cdr_csv usegmtime=no bo'lsa — server lokal vaqti)
    // TODO(tasdiqlash): Asterisk serveri vaqt zonasi Asia/Tashkent ekani
    cdrTimezone: process.env.PBX_CDR_TIMEZONE ?? 'Asia/Tashkent',
  },
  // Server holati va to'lovi (Railway API): rahbar sahifasi + to'lov eslatmasi. Token bo'sh bo'lsa o'chiq
  railway: {
    token: process.env.RAILWAY_TOKEN ?? '',
    projectId: process.env.RAILWAY_PROJECT_ID ?? '',
    serviceId: process.env.RAILWAY_SERVICE_ID ?? '',
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? '',
    apiUrl: process.env.RAILWAY_API_URL ?? 'https://backboard.railway.com/graphql/v2',
  },
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, env !== 'test'),
  backup: {
    enabled: bool(process.env.BACKUP_ENABLED, false),
    dir: process.env.BACKUP_DIR ?? './backups',
  },
  // "Bajarildi" dan keyin bekor qilish oynasi (CLAUDE.md 6.6)
  undoWindowSec: 5,
  timezone: 'Asia/Tashkent',
};

/** Prod'da zaif yoki standart maxfiy kalit bilan ishga tushmaslik */
export function assertSecrets() {
  if (!config.isProd) return;
  const bad: string[] = [];
  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET],
    ['JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET],
  ] as const) {
    if (!value || value.length < 32 || value.startsWith('change-me')) bad.push(name);
  }
  if (process.env.PBX_INGEST_TOKEN && process.env.PBX_INGEST_TOKEN.length < 32) bad.push('PBX_INGEST_TOKEN');
  if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    bad.push('JWT_ACCESS_SECRET == JWT_REFRESH_SECRET');
  }
  if (bad.length) throw new Error(`Xavfsiz bo'lmagan maxfiy kalitlar: ${bad.join(', ')}`);
}
