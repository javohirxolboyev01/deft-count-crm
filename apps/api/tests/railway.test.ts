import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { renderNotification } from '../src/modules/messages';
import { captureRailwayCost, parseRailwayDate, railwayDeps, remindServerPayment, resetRailwayCache, serverStateOf } from '../src/modules/railway';
import { api, createUser, pool, q, resetDb, seedTeam, token } from './helpers';

// Railway API soxta javoblari (so'rov matniga qarab)
let billing: any;
let deployments: { status: string; statusUpdatedAt: string | null; createdAt: string }[];
let failBilling = false;
const realFetch = railwayDeps.fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let L: ReturnType<typeof api>;
let A: ReturnType<typeof api>;
let O: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  await seedTeam();
  await createUser('leader2', 'LEADER', 'Rahbar 2');
  await createUser('op', 'OPERATOR', 'Operator');
  L = api(await token('leader'));
  A = api(await token('acc1'));
  O = api(await token('op'));
  Object.assign(config.railway, { token: 'test-token', projectId: 'p1', serviceId: 's1', environmentId: 'e1' });
  railwayDeps.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-token');
    if (body.query.includes('deployments')) return json({ data: { deployments: { edges: deployments.map((node) => ({ node })) } } });
    if (body.query.includes('metrics')) {
      return json({
        data: {
          metrics: [
            { measurement: 'CPU_USAGE', values: [{ ts: 1, value: 0.5 }, { ts: 2, value: 0.12 }] },
            { measurement: 'CPU_LIMIT', values: [{ ts: 2, value: 8 }] },
            { measurement: 'MEMORY_USAGE_GB', values: [{ ts: 2, value: 0.34 }] },
            { measurement: 'MEMORY_LIMIT_GB', values: [{ ts: 2, value: 8 }] },
          ],
        },
      });
    }
    if (failBilling) return json({ errors: [{ message: 'Not Authorized' }] });
    return json({ data: { project: { subscriptionType: 'hobby', workspace: { customer: billing } } } });
  };
});

afterAll(() => {
  railwayDeps.fetch = realFetch;
  Object.assign(config.railway, { token: '', projectId: '', serviceId: '', environmentId: '' });
});

beforeEach(async () => {
  resetRailwayCache();
  await pool.query(`DELETE FROM server_cost_snapshot`);
  failBilling = false;
  deployments = [{ status: 'SUCCESS', statusUpdatedAt: '2026-11-10T09:32:00Z', createdAt: '2026-11-10T09:30:00Z' }];
  billing = {
    state: 'ACTIVE',
    isTrialing: false,
    trialDaysRemaining: 0,
    creditBalance: 0,
    remainingUsageCreditBalance: 0,
    currentUsage: 8.4,
    billingPeriod: { end: '2026-12-15T00:00:00Z' },
    defaultPaymentMethod: { card: { brand: 'visa', last4: '4242' } },
    // 15.12.2026 10:00 Toshkent
    subscriptions: [{ status: 'active', nextInvoiceDate: '2026-12-15T05:00:00Z', nextInvoiceCurrentTotal: 1980 }],
  };
});

describe('server holati', () => {
  it('yangi build yig\'ilayotgan yoki yiqilgan bo\'lsa ham oldingi SUCCESS ishlayapti', () => {
    const at = '2026-11-10T09:00:00Z';
    expect(serverStateOf([{ status: 'BUILDING', createdAt: at }, { status: 'SUCCESS', createdAt: at }]).state).toBe('UP');
    expect(serverStateOf([{ status: 'FAILED', createdAt: at }, { status: 'SUCCESS', createdAt: at }]).state).toBe('UP');
    expect(serverStateOf([{ status: 'CRASHED', createdAt: at }, { status: 'REMOVED', createdAt: at }]).state).toBe('DOWN');
    expect(serverStateOf([{ status: 'SLEEPING', createdAt: at }]).state).toBe('SLEEPING');
    expect(serverStateOf([{ status: 'DEPLOYING', createdAt: at }]).state).toBe('DEPLOYING');
    expect(serverStateOf([]).state).toBe('UNKNOWN');
  });

  it('sana ISO yoki unix', () => {
    expect(parseRailwayDate('1797310800')?.toUTC().toISO()).toBe('2026-12-15T05:00:00.000Z');
    expect(parseRailwayDate('2026-12-15T05:00:00Z')?.toUTC().toISO()).toBe('2026-12-15T05:00:00.000Z');
    expect(parseRailwayDate('')).toBeNull();
  });

  it('faqat rahbar ko\'radi', async () => {
    expect((await A.get('/api/server/status')).status).toBe(403);
    expect((await O.get('/api/server/status')).status).toBe(403);
    expect((await L.get('/api/server/status')).status).toBe(200);
  });

  it('holat, yuklama va to\'lov', async () => {
    const r = await L.get('/api/server/status');
    expect(r.body).toMatchObject({
      configured: true,
      server: { state: 'UP' },
      usage: { cpu: 0.12, cpuLimit: 8, memoryGb: 0.34, memoryLimitGb: 8 },
      billing: { plan: 'hobby', state: 'ACTIVE', paymentFailed: false, nextPaymentDate: '2026-12-15', nextAmount: 19.8, currentUsage: 8.4, card: { brand: 'visa', last4: '4242' }, trial: null },
      costHistory: [],
      errors: [],
    });
    expect(r.body.usage.history).toEqual([
      { at: '1970-01-01T00:00:01.000Z', cpu: 0.5, memoryGb: null },
      { at: '1970-01-01T00:00:02.000Z', cpu: 0.12, memoryGb: 0.34 },
    ]);
    expect(typeof r.body.billing.daysLeft).toBe('number');
  });

  it('bir soat ichidagi takror xarajat namunasi o\'sha soatni yangilaydi va Server API qaytaradi', async () => {
    const sampledAt = DateTime.fromISO('2026-11-10T09:32:00Z');
    expect(await captureRailwayCost(sampledAt)).toBe(true);
    billing.currentUsage = 8.75;
    resetRailwayCache();
    expect(await captureRailwayCost(sampledAt.plus({ minutes: 20 }))).toBe(true);

    const r = await L.get('/api/server/status');
    expect(r.status).toBe(200);
    expect(r.body.costHistory).toEqual([{ at: '2026-11-10T09:00:00Z', amount: 8.75 }]);
  });

  it('sinov davri: sana — sinov tugashi (billing davri oxiri emas), bepul kredit', async () => {
    // Haqiqiy Railway javobi shakli (trial, karta yo'q, obuna yo'q)
    Object.assign(billing, {
      state: 'INACTIVE', isTrialing: true, trialDaysRemaining: 7, creditBalance: 5, remainingUsageCreditBalance: 3.51,
      currentUsage: 1.49, billingPeriod: { end: '2026-11-10T23:59:59.999Z' }, defaultPaymentMethod: null, subscriptions: [],
    });
    const { getServerStatus } = await import('../src/modules/railway');
    const s = await getServerStatus(DateTime.fromISO('2026-11-10T13:00', { zone: 'Asia/Tashkent' }));
    expect(s.billing).toMatchObject({
      nextPaymentDate: '2026-11-17', daysLeft: 7, nextAmount: null, card: null, paymentFailed: false,
      trial: { creditLeft: 3.51, creditTotal: 5 },
    });
  });

  it('billing huquqi yetmasa ham server holati ko\'rinadi', async () => {
    failBilling = true;
    const r = await L.get('/api/server/status');
    expect(r.body.server.state).toBe('UP');
    expect(r.body.billing).toBeNull();
    expect(r.body.errors).toEqual(['billing']);
  });

  it('sozlanmagan', async () => {
    const tok = config.railway.token;
    config.railway.token = '';
    const r = await L.get('/api/server/status');
    config.railway.token = tok;
    expect(r.body).toMatchObject({ configured: false, server: null, billing: null });
  });
});

describe('to\'lov eslatmasi', () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Asia/Tashkent' });
  const sent = () => q<{ user_id: number; payload: any; dedupe_key: string }>(pool, `SELECT user_id, payload, dedupe_key FROM notification WHERE kind = 'SERVER_PAYMENT' AND channel = 'APP' ORDER BY id`);

  beforeEach(async () => {
    await pool.query(`DELETE FROM notification WHERE kind = 'SERVER_PAYMENT'`);
  });

  it('3 va 1 kun oldin, to\'lov kuni — har rahbarga bir marta; boshqa kunlarda yo\'q', async () => {
    expect((await remindServerPayment(at('2026-12-11T10:00'))).sent).toBe(false); // 4 kun
    expect((await remindServerPayment(at('2026-12-12T08:59'))).sent).toBe(false); // 09:00 dan oldin
    expect((await remindServerPayment(at('2026-12-12T09:00'))).sent).toBe(true); // 3 kun
    await remindServerPayment(at('2026-12-12T15:00')); // takror — dedupe
    await remindServerPayment(at('2026-12-13T10:00')); // 2 kun — yo'q
    await remindServerPayment(at('2026-12-14T10:00')); // 1 kun
    await remindServerPayment(at('2026-12-15T10:00')); // bugun
    const rows = await sent();
    // 2 rahbar × 3 kun; buxgalter va operatorga yo'q
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.payload.daysLeft)).toEqual([3, 3, 1, 1, 0, 0]);
    const leaders = (await q<{ id: number }>(pool, `SELECT id FROM app_user WHERE role = 'LEADER'`)).map((u) => u.id).sort();
    expect([...new Set(rows.map((r) => r.user_id))].sort()).toEqual(leaders);
  });

  it('to\'lov o\'tmasa — har kuni', async () => {
    billing.state = 'PAST_DUE';
    await remindServerPayment(at('2026-12-16T10:00'));
    await remindServerPayment(at('2026-12-16T11:00'));
    resetRailwayCache();
    await remindServerPayment(at('2026-12-17T10:00'));
    const rows = await sent();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.payload.paymentFailed)).toBe(true);
  });

  it('sinov tugashidan 1 kun oldin — sinov eslatmasi', async () => {
    Object.assign(billing, { isTrialing: true, trialDaysRemaining: 1, subscriptions: [], defaultPaymentMethod: null });
    await remindServerPayment(at('2026-11-10T10:00'));
    const rows = await sent();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload).toMatchObject({ trial: true, daysLeft: 1, nextPaymentDate: '2026-11-11' });
    expect(rows[0]!.dedupe_key).toBe('server-trial:2026-11-11:1');
    expect(renderNotification('SERVER_PAYMENT', rows[0]!.payload, 'uz')).toContain('sinov muddati 1 kundan keyin tugaydi');
  });

  it('kunlik ish (xarajat + eslatma) Railway\'ga bitta billing so\'rovi bilan, server holati/yuklama so\'ralmaydi', async () => {
    const queries: string[] = [];
    const mock = railwayDeps.fetch;
    railwayDeps.fetch = async (url, init) => {
      queries.push(String(JSON.parse(String(init?.body)).query));
      return mock(url, init);
    };
    try {
      await captureRailwayCost(at('2026-12-12T09:00'));
      expect((await remindServerPayment(at('2026-12-12T09:00'))).sent).toBe(true);
      await remindServerPayment(at('2026-12-12T08:00')); // 09:00 dan oldin — so'rov ham yo'q
    } finally {
      railwayDeps.fetch = mock;
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('subscriptions');
  });

  it('Telegram matni', () => {
    const p = { daysLeft: 1, nextPaymentDate: '2026-12-15', amount: 19.8, hasCard: false, billingUrl: 'https://railway.com/workspace/billing' };
    expect(renderNotification('SERVER_PAYMENT', p, 'uz')).toContain("Server to'lovi 1 kundan keyin: 15.12.2026 (~$19.80)");
    expect(renderNotification('SERVER_PAYMENT', p, 'uz')).toContain('Karta ulanmagan');
    expect(renderNotification('SERVER_PAYMENT', { ...p, paymentFailed: true }, 'ru')).toContain('Оплата сервера не прошла');
  });
});
