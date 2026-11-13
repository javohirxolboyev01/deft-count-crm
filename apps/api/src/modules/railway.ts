import { Router } from 'express';
import { DateTime } from 'luxon';
import { requireLeader } from '../common/auth';
import { TZ } from '../common/time';
import { config } from '../config';
import { pool } from '../db';
import { notifyLeaders } from './notifications';

/*
 * Server holati va to'lovi (Railway GraphQL API, faqat o'qish).
 *
 * Rahbar "Server" sahifasida: ishlayaptimi, yuklama (CPU/RAM), keyingi to'lovgacha qolgan kun, bu davr xarajati.
 * To'lovning o'zi Railway'da (karta Railway hisobiga ulanadi, har oy o'zi yechiladi) — CRM to'lov qabul qilmaydi.
 * Sana va summa API'dan olinadi (qo'lda kiritilmaydi): to'lov o'tgach Railway yangi davrni o'zi ko'rsatadi.
 * Deploy tarixi ko'rsatilmaydi (rahbar qarori — buxgalterga tushunarsiz). Server yiqilganda xabar yo'q (rahbar qarori).
 *
 * Qism-qism olinadi: billing huquqi yetmasa ham server holati va yuklama ko'rinadi (`errors` — qaysi qism olinmadi).
 */

export const RAILWAY_BILLING_URL = 'https://railway.com/workspace/billing';
/** To'lovdan necha kun oldin eslatiladi (rahbar qarori: 3, 1 kun oldin va to'lov kuni) */
export const PAYMENT_REMIND_DAYS = [3, 1, 0];
/** Eslatma soati (Asia/Tashkent); scheduler kunlik ishni shu soatda ishga tushiradi */
export const REMIND_AT = '09:00';
const CACHE_MS = 60_000;

export type ServerState = 'UP' | 'DOWN' | 'SLEEPING' | 'DEPLOYING' | 'UNKNOWN';

export interface ServerStatus {
  configured: boolean;
  fetchedAt: string | null;
  /** Server soati (javob paytida) — brauzer sanog'i kompyuter soati noto'g'ri bo'lsa ham to'g'ri yursin */
  serverTime: string;
  server: { state: ServerState; since: string | null } | null;
  usage: {
    cpu: number;
    cpuLimit: number | null;
    memoryGb: number;
    memoryLimitGb: number | null;
    history: { at: string; cpu: number | null; memoryGb: number | null }[];
  } | null;
  billing: {
    plan: string | null;
    /** Railway obunasi holati: ACTIVE | PAST_DUE | UNPAID | ... */
    state: string;
    paymentFailed: boolean;
    /** Keyingi to'lov sanasi (Asia/Tashkent, yyyy-MM-dd) */
    nextPaymentDate: string | null;
    /** Aniq vaqt (ISO, UTC): sinovda — tugash payti (sahifa va xabarda "soat HH:mm"); ma'lum bo'lmasa null */
    nextPaymentAt: string | null;
    daysLeft: number | null;
    /** Keyingi to'lov taxminiy summasi ($) */
    nextAmount: number | null;
    /** Joriy davrdagi xarajat ($) */
    currentUsage: number | null;
    card: { brand: string; last4: string } | null;
    /**
     * Sinov (trial) davri: to'lov yo'q, bepul kredit bilan ishlaydi; tugagach (kun yoki kredit tugasa) karta va tarif
     * bo'lmasa server to'xtaydi. Bunda nextPaymentDate/daysLeft — sinov tugash sanasi.
     */
    trial: { creditLeft: number | null; creditTotal: number | null } | null;
  } | null;
  costHistory: { at: string; amount: number }[];
  billingUrl: string;
  errors: ('server' | 'usage' | 'billing')[];
}

/** Testlarda almashtiriladi */
export const railwayDeps = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

export const railwayConfigured = () => !!config.railway.token && !!config.railway.projectId;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await railwayDeps.fetch(config.railway.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.railway.token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await r.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!r.ok || !body || body.errors?.length || !body.data) {
    throw new Error(`Railway API ${r.status}: ${body?.errors?.map((e) => e.message).join('; ') ?? 'javob yo\'q'}`);
  }
  return body.data;
}

// ---------- Server holati ----------
const IN_PROGRESS = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL']);

/**
 * Deploylar (yangisi birinchi) ichidan hozir ishlab turgani: yangi build yig'ilayotgan yoki yiqilgan bo'lsa ham
 * oldingi SUCCESS deploy xizmat qilishda davom etadi.
 */
export function serverStateOf(deploys: { status: string; statusUpdatedAt?: string | null; createdAt: string }[]): {
  state: ServerState;
  since: string | null;
} {
  const live = deploys.find((d) => d.status === 'SUCCESS' || d.status === 'CRASHED' || d.status === 'SLEEPING');
  if (live) {
    const state: ServerState = live.status === 'SUCCESS' ? 'UP' : live.status === 'CRASHED' ? 'DOWN' : 'SLEEPING';
    return { state, since: live.statusUpdatedAt ?? live.createdAt };
  }
  if (deploys.some((d) => IN_PROGRESS.has(d.status))) return { state: 'DEPLOYING', since: null };
  if (deploys.some((d) => d.status === 'FAILED')) return { state: 'DOWN', since: null };
  return { state: 'UNKNOWN', since: null };
}

async function loadServer() {
  const { projectId, serviceId, environmentId } = config.railway;
  const d = await gql<{ deployments: { edges: { node: { status: string; statusUpdatedAt: string | null; createdAt: string } }[] } }>(
    `query($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { status statusUpdatedAt createdAt } } } }`,
    { input: { projectId, serviceId: serviceId || undefined, environmentId: environmentId || undefined } },
  );
  return serverStateOf(d.deployments.edges.map((e) => e.node));
}

// ---------- Yuklama ----------
async function loadUsage() {
  const { projectId, serviceId, environmentId } = config.railway;
  const d = await gql<{ metrics: { measurement: string; values: { ts: number; value: number }[] }[] }>(
    `query($projectId: String, $serviceId: String, $environmentId: String, $startDate: DateTime!) {
       metrics(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId, startDate: $startDate,
               sampleRateSeconds: 60, measurements: [CPU_USAGE, CPU_LIMIT, MEMORY_USAGE_GB, MEMORY_LIMIT_GB]) {
         measurement values { ts value }
       }
     }`,
    {
      projectId,
      serviceId: serviceId || null,
      environmentId: environmentId || null,
      startDate: DateTime.utc().minus({ minutes: 15 }).toISO(),
    },
  );
  const values = (measurement: string) => d.metrics.find((x) => x.measurement === measurement)?.values ?? [];
  const latest = (measurement: string) => [...values(measurement)].sort((a, b) => b.ts - a.ts)[0]?.value ?? null;
  const historyByTime = new Map<number, { at: string; cpu: number | null; memoryGb: number | null }>();
  const addHistory = (measurement: string, key: 'cpu' | 'memoryGb') => {
    for (const point of values(measurement)) {
      const timestamp = point.ts < 1e12 ? point.ts * 1000 : point.ts;
      const row = historyByTime.get(timestamp) ?? { at: new Date(timestamp).toISOString(), cpu: null, memoryGb: null };
      row[key] = point.value;
      historyByTime.set(timestamp, row);
    }
  };
  addHistory('CPU_USAGE', 'cpu');
  addHistory('MEMORY_USAGE_GB', 'memoryGb');
  return {
    cpu: latest('CPU_USAGE') ?? 0,
    cpuLimit: latest('CPU_LIMIT'),
    memoryGb: latest('MEMORY_USAGE_GB') ?? 0,
    memoryLimitGb: latest('MEMORY_LIMIT_GB'),
    history: [...historyByTime.entries()].sort(([a], [b]) => a - b).map(([, row]) => row),
  };
}

// ---------- To'lov ----------
/** nextInvoiceDate: ISO yoki unix (soniya/millisekund) bo'lishi mumkin */
export function parseRailwayDate(v: string | null | undefined): DateTime | null {
  if (!v) return null;
  const d = /^\d+$/.test(v) ? DateTime.fromMillis(Number(v) < 1e12 ? Number(v) * 1000 : Number(v)) : DateTime.fromISO(v);
  return d.isValid ? d : null;
}

interface RawBilling {
  plan: string | null;
  state: string;
  nextPayment: string | null;
  nextAmount: number | null;
  currentUsage: number | null;
  card: { brand: string; last4: string } | null;
  trial: { daysLeft: number; startedAt: string | null; creditLeft: number | null; creditTotal: number | null } | null;
}

/** Railway sinovi 30 kun (hisob ochilgan paytdan) */
const TRIAL_DAYS = 30;

async function loadBilling(): Promise<RawBilling> {
  const d = await gql<{
    project: {
      subscriptionType: string | null;
      workspace: {
        customer: {
          state: string;
          isTrialing: boolean;
          trialDaysRemaining: number;
          creditBalance: number | null;
          remainingUsageCreditBalance: number | null;
          currentUsage: number | null;
          billingPeriod: { start?: string | null; end: string } | null;
          defaultPaymentMethod: { card: { brand: string; last4: string } | null } | null;
          subscriptions: { status: string; nextInvoiceDate: string; nextInvoiceCurrentTotal: number }[];
        };
      } | null;
    };
  }>(
    `query($id: String!) { project(id: $id) { subscriptionType workspace { customer {
       state isTrialing trialDaysRemaining creditBalance remainingUsageCreditBalance currentUsage billingPeriod { start end } defaultPaymentMethod { card { brand last4 } }
       subscriptions { status nextInvoiceDate nextInvoiceCurrentTotal }
     } } } }`,
    { id: config.railway.projectId },
  );
  const c = d.project.workspace?.customer;
  if (!c) throw new Error('Railway: workspace billing ma\'lumoti yo\'q');
  const sub = c.subscriptions.find((s) => s.status === 'active' || s.status === 'past_due') ?? c.subscriptions[0];
  const next = parseRailwayDate(sub?.nextInvoiceDate) ?? parseRailwayDate(c.billingPeriod?.end);
  return {
    plan: d.project.subscriptionType,
    state: c.state,
    nextPayment: next?.toISO() ?? null,
    // TODO(tasdiqlash): nextInvoiceCurrentTotal — Stripe kabi sentda deb olindi; currentUsage — dollarda
    nextAmount: sub ? sub.nextInvoiceCurrentTotal / 100 : null,
    currentUsage: c.currentUsage,
    card: c.defaultPaymentMethod?.card ? { brand: c.defaultPaymentMethod.card.brand, last4: c.defaultPaymentMethod.card.last4 } : null,
    trial: c.isTrialing
      ? { daysLeft: c.trialDaysRemaining, startedAt: parseRailwayDate(c.billingPeriod?.start)?.toISO() ?? null, creditLeft: c.remainingUsageCreditBalance, creditTotal: c.creditBalance }
      : null,
  };
}

// ---------- Kesh va yig'ish ----------
interface Snapshot {
  at: number;
  server: ServerStatus['server'];
  usage: ServerStatus['usage'];
  billing: RawBilling | null;
  errors: ServerStatus['errors'];
}
let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
// Billing alohida keshlanadi: sahifa, xarajat yozuvi va eslatma bitta javobni bo'lishadi (Railway'ga ortiqcha so'rov yo'q)
let billingCache: { at: number; value: RawBilling } | null = null;
let billingInflight: Promise<RawBilling> | null = null;

export function resetRailwayCache() {
  cache = null;
  inflight = null;
  billingCache = null;
  billingInflight = null;
}

function getBilling(): Promise<RawBilling> {
  if (billingCache && Date.now() - billingCache.at < CACHE_MS) return Promise.resolve(billingCache.value);
  billingInflight ??= loadBilling()
    .then((value) => {
      billingCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      billingInflight = null;
    });
  return billingInflight;
}

async function loadCostHistory() {
  const { rows } = await pool.query<{ at: string; amount: number }>(
    `SELECT to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            current_usage::float8 AS amount
     FROM server_cost_snapshot
     WHERE sampled_at >= now() - interval '30 days'
     ORDER BY sampled_at`,
  );
  return rows;
}

/**
 * Xarajat namunasi (grafik uchun): Railway billingdagi yig'ilgan davr xarajati. Scheduler kuniga bir marta (09:00) va
 * ilova ishga tushganda yozadi; bir soat ichidagi takror yozuv o'sha soat qatorini yangilaydi.
 */
export async function captureRailwayCost(now: DateTime = DateTime.now()) {
  if (!railwayConfigured()) return false;
  const billing = await getBilling();
  if (billing.currentUsage == null) return false;
  if (!Number.isFinite(billing.currentUsage) || billing.currentUsage < 0) {
    throw new Error('Railway currentUsage qiymati noto‘g‘ri');
  }
  const sampledAt = now.toUTC().startOf('hour').toISO();
  if (!sampledAt) throw new Error('Xarajat namunasining vaqtini aniqlab bo‘lmadi');
  await pool.query(
    `INSERT INTO server_cost_snapshot (sampled_at, current_usage) VALUES ($1, $2)
     ON CONFLICT (sampled_at) DO UPDATE SET current_usage = EXCLUDED.current_usage`,
    [sampledAt, billing.currentUsage],
  );
  await pool.query(`DELETE FROM server_cost_snapshot WHERE sampled_at < now() - interval '30 days'`);
  return true;
}

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  inflight ??= (async () => {
    const [server, usage, billing] = await Promise.allSettled([loadServer(), loadUsage(), getBilling()]);
    const errors: ServerStatus['errors'] = [];
    const pick = <T>(r: PromiseSettledResult<T>, name: ServerStatus['errors'][number]) => {
      if (r.status === 'fulfilled') return r.value;
      errors.push(name);
      console.error(`[railway] ${name}:`, (r.reason as Error)?.message);
      return null;
    };
    const s: Snapshot = { at: Date.now(), server: pick(server, 'server'), usage: pick(usage, 'usage'), billing: pick(billing, 'billing'), errors };
    cache = s;
    return s;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function billingView(b: RawBilling, now: DateTime): NonNullable<ServerStatus['billing']> {
  const today = now.setZone(TZ).startOf('day');
  // Sinovda billing davri oxiri to'lov emas: sana — sinov tugashi. trialDaysRemaining faqat butun kun (yuqoriga
  // yaxlitlangan), aniq payt — sinov boshi (billingPeriod.start, sinovda hisob ochilgan payt) + 30 kun.
  // Tekshirildi (13.11.2026): billingPeriod.start = workspace.createdAt = "Trial credits" berilgan payt.
  // TODO(tasdiqlash): sinov 30 kun deb olindi (Railway qoidasi; API tugash paytini to'g'ridan-to'g'ri bermaydi); trialDaysRemaining bilan 1 kundan ortiq
  // farq qilsa ishonilmaydi va eski usul (bugun + qolgan kun, soatsiz) qoladi.
  let dueAt: DateTime | null = null;
  if (b.trial) {
    const end = b.trial.startedAt ? DateTime.fromISO(b.trial.startedAt).plus({ days: TRIAL_DAYS }).setZone(TZ) : null;
    const byDays = now.setZone(TZ).plus({ days: b.trial.daysLeft });
    if (end && Math.abs(end.diff(byDays, 'days').days) <= 1) dueAt = end;
  } else if (b.nextPayment) dueAt = DateTime.fromISO(b.nextPayment).setZone(TZ);
  const due = b.trial
    ? (dueAt?.startOf('day') ?? today.plus({ days: b.trial.daysLeft }))
    : dueAt?.startOf('day') ?? null;
  return {
    plan: b.plan,
    state: b.state,
    paymentFailed: b.state === 'PAST_DUE' || b.state === 'UNPAID',
    nextPaymentDate: due?.toISODate() ?? null,
    nextPaymentAt: dueAt?.toUTC().toISO() ?? null,
    daysLeft: due ? Math.round(due.diff(today, 'days').days) : null,
    nextAmount: b.nextAmount,
    currentUsage: b.currentUsage,
    card: b.card,
    trial: b.trial ? { creditLeft: b.trial.creditLeft, creditTotal: b.trial.creditTotal } : null,
  };
}

/** Qolgan kun so'rov paytida hisoblanadi (kesh 1 daqiqa, kun almashsa ham to'g'ri) */
export async function getServerStatus(now: DateTime = DateTime.now()): Promise<ServerStatus> {
  if (!railwayConfigured()) {
    return { configured: false, fetchedAt: null, serverTime: new Date().toISOString(), server: null, usage: null, billing: null, costHistory: [], billingUrl: RAILWAY_BILLING_URL, errors: [] };
  }
  const [s, costHistory] = await Promise.all([snapshot(), loadCostHistory()]);
  const billing = s.billing ? billingView(s.billing, now) : null;
  return {
    configured: true,
    fetchedAt: new Date(s.at).toISOString(),
    serverTime: new Date().toISOString(),
    server: s.server,
    usage: s.usage,
    billing,
    costHistory,
    billingUrl: RAILWAY_BILLING_URL,
    errors: s.errors,
  };
}

/**
 * To'lov eslatmasi (SERVER_PAYMENT) — barcha faol rahbarlarga (rahbar qarori): to'lovdan 3 va 1 kun oldin va to'lov kuni,
 * to'lov o'tmagan bo'lsa (PAST_DUE/UNPAID) — har kuni. Scheduler kuniga bir marta (09:00) va ishga tushganda chaqiradi;
 * takror chaqiruvda dedupe_key bilan bir marta ketadi. Faqat billing so'raladi (server holati/yuklama kerak emas).
 */
export async function remindServerPayment(now: DateTime = DateTime.now()) {
  if (!railwayConfigured()) return { sent: false as const };
  const local = now.setZone(TZ);
  if (local.toFormat('HH:mm') < REMIND_AT) return { sent: false as const };
  const b = billingView(await getBilling(), now);

  let dedupeKey: string;
  if (b.paymentFailed) dedupeKey = `server-payment:failed:${local.toISODate()}`;
  else if (b.daysLeft !== null && PAYMENT_REMIND_DAYS.includes(b.daysLeft)) {
    dedupeKey = `server-${b.trial ? 'trial' : 'payment'}:${b.nextPaymentDate}:${b.daysLeft}`;
  } else return { sent: false as const };

  await notifyLeaders(pool, {
    kind: 'SERVER_PAYMENT',
    payload: {
      trial: !!b.trial,
      paymentFailed: b.paymentFailed,
      daysLeft: b.daysLeft,
      nextPaymentDate: b.nextPaymentDate,
      nextPaymentAt: b.nextPaymentAt,
      amount: b.nextAmount,
      hasCard: !!b.card,
      billingUrl: RAILWAY_BILLING_URL,
    },
    dedupeKey,
  });
  return { sent: true as const, dedupeKey };
}

// ---------- API ----------
export const serverRouter = Router();
serverRouter.use(requireLeader);

serverRouter.get('/status', async (_req, res) => {
  res.json(await getServerStatus());
});
