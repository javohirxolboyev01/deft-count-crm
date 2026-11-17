import bigInt from 'big-integer';
import { Api, TelegramClient, utils } from 'telegram';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events';
import { LogLevel } from 'telegram/extensions/Logger';
import { computeCheck } from 'telegram/Password';
import { StringSession } from 'telegram/sessions';
import { audit } from '../common/audit';
import { AppError } from '../common/errors';
import { decryptSecret, encryptSecret } from '../common/secretBox';
import { config } from '../config';
import { one, pool, q } from '../db';
import { emitToUsers } from './events';

/**
 * Firma Telegram akkaunti CRM ichida (V53, rahbar qarori "A" varianti).
 *
 * Qaror: GramJS (Telegram'ning rasmiy MTProto API'si — Telegram Desktop ham shu API bilan ishlaydi). Server firma
 * akkauntiga bitta "qurilma" sifatida ulanadi; rahbar va buxgalterlar shu bitta ulanish orqali o'qib-yozadi.
 * Xabarlar va fayllar bazada saqlanmaydi: chatlar ro'yxati xotirada (kesh, hodisalar bilan yangilanadi),
 * xabarlar har safar Telegram'dan olinadi. Bazada faqat sessiya va "CRM'dan kim yozgan" belgisi (tg_sent_message).
 *
 * Akkauntni bloklanishdan himoya: ommaviy yuborish yo'q, chatlar ro'yxati bir marta yuklanib keyin hodisalardan
 * yangilanadi, so'nggi sahifa qisqa keshlanadi (bir nechta xodim bir chatni ochsa Telegram'ga bitta so'rov).
 */

// ---------------- Holat ----------------

let client: TelegramClient | null = null;
let account: { phone: string | null; name: string | null; tgUserId: string | null } | null = null;
let starting: Promise<void> | null = null;

/** Rahbar ulash jarayonida: kod kutilmoqda yoki 2FA paroli kutilmoqda (bir vaqtda bittasi) */
let pending: {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  step: 'CODE' | 'PASSWORD';
  hint: string | null;
  byUserId: number;
  timer: NodeJS.Timeout;
} | null = null;

export const tgConfigured = () => config.tgAccount.apiId > 0 && !!config.tgAccount.apiHash;
export const tgConnected = () => !!client && !!account;

export function tgStatus() {
  return {
    configured: tgConfigured(),
    connected: tgConnected(),
    account: account ? { phone: account.phone, name: account.name } : null,
    login: pending ? { step: pending.step, phone: pending.phone, hint: pending.hint } : null,
  };
}

function newClient(session = '') {
  const c = new TelegramClient(new StringSession(session), config.tgAccount.apiId, config.tgAccount.apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    // Qaror: WebSocket (443-port, HTTPS kabi). Oddiy TCP (80-port) ba'zi provayderlarda to'silgan — ulanish
    // javobsiz qotib qolardi (ofis tarmog'ida tekshirilgan). TG_USE_WSS=false bo'lsa oddiy TCP.
    useWSS: config.tgAccount.useWss,
    // Telegram'ning «Qurilmalar» ro'yxatida shu nom ko'rinadi
    deviceModel: 'Buxgalteriya CRM',
    systemVersion: 'Server',
    appVersion: '1.0',
    langCode: 'uz',
    systemLangCode: 'uz',
  });
  c.setLogLevel(LogLevel.ERROR);
  return c;
}

// ---------------- Xatolar ----------------

/** Telegram xatosini tushunarli AppError'ga. FLOOD_WAIT — necha soniya kutish kerakligi bilan */
function tgError(e: any): AppError {
  if (e instanceof AppError) return e;
  const m: string = e?.errorMessage ?? e?.message ?? '';
  if (typeof e?.seconds === 'number' || m.startsWith('FLOOD_WAIT')) {
    return new AppError(429, 'TG_FLOOD_WAIT', 'Telegram kutishni so\'radi', { seconds: e?.seconds ?? null });
  }
  const known: Record<string, [number, string]> = {
    PHONE_NUMBER_INVALID: [400, 'TG_PHONE_INVALID'],
    PHONE_NUMBER_BANNED: [400, 'TG_PHONE_BANNED'],
    PHONE_CODE_INVALID: [400, 'TG_CODE_INVALID'],
    PHONE_CODE_EMPTY: [400, 'TG_CODE_INVALID'],
    PHONE_CODE_EXPIRED: [400, 'TG_CODE_EXPIRED'],
    PASSWORD_HASH_INVALID: [400, 'TG_PASSWORD_INVALID'],
    PHONE_NUMBER_UNOCCUPIED: [400, 'TG_PHONE_UNOCCUPIED'],
    PEER_ID_INVALID: [404, 'NOT_FOUND'],
    CHAT_WRITE_FORBIDDEN: [403, 'TG_WRITE_FORBIDDEN'],
    USER_IS_BLOCKED: [403, 'TG_WRITE_FORBIDDEN'],
    YOU_BLOCKED_USER: [403, 'TG_WRITE_FORBIDDEN'],
    CHAT_ADMIN_REQUIRED: [403, 'TG_WRITE_FORBIDDEN'],
    MESSAGE_ID_INVALID: [404, 'NOT_FOUND'],
    MESSAGE_AUTHOR_REQUIRED: [403, 'TG_EDIT_FORBIDDEN'],
    MESSAGE_EDIT_TIME_EXPIRED: [403, 'TG_EDIT_FORBIDDEN'],
    MESSAGE_DELETE_FORBIDDEN: [403, 'TG_DELETE_FORBIDDEN'],
    CHAT_FORWARDS_RESTRICTED: [403, 'TG_FORWARD_FORBIDDEN'],
  };
  const k = known[m];
  if (k) return new AppError(k[0], k[1], m);
  if (/^(TRANSLATE|TO_LANG|PREMIUM)/.test(m)) return new AppError(400, 'TG_TRANSLATE_FAILED', m);
  console.error('Telegram xatosi:', m || e);
  return new AppError(502, 'TG_ERROR', 'Telegram bilan bog\'lanishda xato', { error: m || null });
}

/** Tarmoq Telegram'ni to'ssa so'rov abadiy kutib qolmasin: tushunarli xato bilan qaytadi */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(504, 'TG_TIMEOUT', 'Telegram serveriga ulanib bo\'lmadi')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function tgCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw tgError(e);
  }
}

function requireConnected(): TelegramClient {
  if (!tgConfigured()) throw new AppError(503, 'TG_NOT_CONFIGURED', 'Telegram API sozlanmagan');
  if (!client || !account) throw new AppError(503, 'TG_NOT_CONNECTED', 'Telegram akkaunti ulanmagan');
  return client;
}

// ---------------- Ulash (rahbar) ----------------

function clearPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  void pending.client.destroy().catch(() => undefined);
  pending = null;
}

export async function loginStart(phone: string, userId: number) {
  if (!tgConfigured()) throw new AppError(503, 'TG_NOT_CONFIGURED', 'Telegram API sozlanmagan');
  if (tgConnected()) throw new AppError(409, 'TG_ALREADY_CONNECTED', 'Akkaunt allaqachon ulangan');
  clearPending();
  const c = newClient();
  const r = await tgCall(() =>
    withTimeout(
      c.connect().then(() => c.sendCode({ apiId: config.tgAccount.apiId, apiHash: config.tgAccount.apiHash }, phone)),
      30_000,
    ),
  ).catch(async (e) => {
    await c.destroy().catch(() => undefined);
    throw e;
  });
  pending = {
    client: c,
    phone,
    phoneCodeHash: r.phoneCodeHash,
    step: 'CODE',
    hint: null,
    byUserId: userId,
    // Kod ~10 daqiqa amal qiladi: undan keyin ulanish yopiladi
    timer: setTimeout(clearPending, 10 * 60_000),
  };
  return { via: r.isCodeViaApp ? 'APP' : 'SMS' };
}

/** Rahbar raqamni o'zgartirmoqchi («raqam noto'g'ri»): jarayon bekor */
export function loginCancel(userId: number) {
  if (pending && pending.byUserId === userId) clearPending();
}

function requirePending(step: 'CODE' | 'PASSWORD', userId: number) {
  if (!pending || pending.step !== step) throw new AppError(409, 'TG_LOGIN_EXPIRED', 'Ulash jarayoni topilmadi, qaytadan boshlang');
  if (pending.byUserId !== userId) throw new AppError(409, 'TG_LOGIN_BUSY', 'Boshqa rahbar ulash jarayonida');
  return pending;
}

export async function loginCode(code: string, userId: number) {
  const p = requirePending('CODE', userId);
  try {
    const r = await p.client.invoke(
      new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: code }),
    );
    if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new AppError(400, 'TG_PHONE_UNOCCUPIED', 'Bu raqamda Telegram akkaunti yo\'q');
    await finishLogin(userId);
    return { done: true as const };
  } catch (e: any) {
    if (e?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      const pw = await tgCall(() => p.client.invoke(new Api.account.GetPassword()));
      p.step = 'PASSWORD';
      p.hint = pw.hint ?? null;
      return { done: false as const, needPassword: true, hint: p.hint };
    }
    throw tgError(e);
  }
}

export async function loginPassword(password: string, userId: number) {
  const p = requirePending('PASSWORD', userId);
  await tgCall(async () => {
    const pw = await p.client.invoke(new Api.account.GetPassword());
    await p.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pw, password) }));
  });
  await finishLogin(userId);
  return { done: true as const };
}

async function finishLogin(userId: number) {
  const p = pending!;
  clearTimeout(p.timer);
  pending = null;
  const c = p.client;
  const meUser = (await tgCall(() => c.getMe())) as Api.User;
  const session = (c.session as StringSession).save();
  const info = {
    phone: meUser.phone ? `+${meUser.phone}` : p.phone,
    name: [meUser.firstName, meUser.lastName].filter(Boolean).join(' ') || null,
    tgUserId: meUser.id.toString(),
  };
  await pool.query(
    `INSERT INTO tg_account (id, session_enc, phone, tg_user_id, display_name, connected_by)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET session_enc = EXCLUDED.session_enc, phone = EXCLUDED.phone, tg_user_id = EXCLUDED.tg_user_id,
       display_name = EXCLUDED.display_name, connected_by = EXCLUDED.connected_by, connected_at = now()`,
    [encryptSecret(session), info.phone, info.tgUserId, info.name, userId],
  );
  await audit(pool, { actorId: userId, entity: 'tg_account', entityId: 1, action: 'TG_CONNECT', after: { phone: info.phone, name: info.name } });
  await activate(c, info);
}

/** Rahbar uzadi: Telegram'dagi «qurilma» ham o'chadi (auth.LogOut), sessiya bazadan o'chiriladi */
export async function logout(userId: number) {
  clearPending();
  const c = client;
  const before = account;
  await deactivate();
  if (c) {
    await c.invoke(new Api.auth.LogOut()).catch(() => undefined);
    await c.destroy().catch(() => undefined);
  }
  await pool.query('DELETE FROM tg_account');
  await audit(pool, { actorId: userId, entity: 'tg_account', entityId: 1, action: 'TG_DISCONNECT', before: before ? { phone: before.phone, name: before.name } : null });
  broadcast('tg-status', {});
}

// ---------------- Ishga tushish ----------------

/** Ilova ishga tushganda: saqlangan sessiya bo'lsa ulanadi. Xato bo'lsa ilova to'xtamaydi */
export function startTgAccount() {
  if (!tgConfigured() || config.isTest) return;
  starting = (async () => {
    const row = await one<{ session_enc: string; phone: string | null; display_name: string | null; tg_user_id: string | null }>(
      pool,
      'SELECT session_enc, phone, display_name, tg_user_id::text FROM tg_account WHERE id = 1',
    );
    if (!row) return;
    const c = newClient(decryptSecret(row.session_enc));
    try {
      await withTimeout(c.connect().then(() => c.getMe()), 60_000);
    } catch (e: any) {
      await c.destroy().catch(() => undefined);
      // Sessiya Telegram'da o'chirilgan (telefondan «qurilmani chiqarish»): qayta ulash kerak
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(e?.errorMessage ?? '')) {
        await pool.query('DELETE FROM tg_account');
        await audit(pool, { actorId: null, entity: 'tg_account', entityId: 1, action: 'TG_SESSION_REVOKED', before: { phone: row.phone } });
        console.warn('Telegram sessiyasi bekor qilingan — rahbar qayta ulashi kerak');
        return;
      }
      throw e;
    }
    await activate(c, { phone: row.phone, name: row.display_name, tgUserId: row.tg_user_id });
  })()
    .catch((e) => console.error('Telegram akkauntiga ulanib bo\'lmadi:', e?.errorMessage ?? e))
    .finally(() => (starting = null));
}

export async function stopTgAccount() {
  clearPending();
  const c = client;
  await deactivate();
  await c?.disconnect().catch(() => undefined);
}

let reloadTimer: NodeJS.Timeout | null = null;
let fullReloadTimer: NodeJS.Timeout | null = null;
let readPollTimer: NodeJS.Timeout | null = null;

async function activate(c: TelegramClient, info: NonNullable<typeof account>) {
  client = c;
  account = info;
  c.addEventHandler(onNewMessage, new NewMessage({}));
  c.addEventHandler(onRawUpdate, new Raw({}));
  await reloadDialogs().catch((e) => console.error('Telegram chatlari yuklanmadi:', e?.errorMessage ?? e));
  await reloadFolders().catch((e) => console.error('Telegram jildlari yuklanmadi:', e?.errorMessage ?? e));
  // Xavfsizlik to'ri: hodisa o'tkazib yuborilsa ham ro'yxat 10 daqiqada bir to'liq yangilanadi
  fullReloadTimer = setInterval(() => scheduleReload(0), 10 * 60_000);
  readPollTimer = setInterval(() => void pollReadOutbox(), READ_POLL_MS);
  broadcast('tg-status', {});
}

async function deactivate() {
  if (fullReloadTimer) clearInterval(fullReloadTimer);
  if (readPollTimer) clearInterval(readPollTimer);
  readPollTimer = null;
  if (reloadTimer) clearTimeout(reloadTimer);
  if (foldersTimer) clearTimeout(foldersTimer);
  fullReloadTimer = reloadTimer = foldersTimer = null;
  client?.removeEventHandler(onNewMessage, new NewMessage({}));
  client?.removeEventHandler(onRawUpdate, new Raw({}));
  client = null;
  account = null;
  dialogs.clear();
  pageCache.clear();
  photoCache.clear();
  pinnedCache.clear();
  folders = null;
}

/** Ilova ishga tushayotganda so'rov kelsa — ulanish tugashini kutadi */
export async function ready() {
  if (starting) await starting;
}

// ---------------- Real vaqt: faqat rahbar va buxgalterlarga ----------------

let staffCache: { ids: number[]; at: number } | null = null;

async function staffIds() {
  if (staffCache && Date.now() - staffCache.at < 30_000) return staffCache.ids;
  const rows = await q<{ id: number }>(pool, `SELECT id FROM app_user WHERE active AND role IN ('LEADER', 'ACCOUNTANT')`);
  staffCache = { ids: rows.map((r) => r.id), at: Date.now() };
  return staffCache.ids;
}

function broadcast(event: string, data: unknown) {
  void staffIds()
    .then((ids) => emitToUsers(ids, event, data))
    .catch(() => undefined);
}

// «Ro'yxat o'zgardi» signali: ko'p hodisa ketma-ket kelsa ham xodimlarga sekundiga ko'pi bilan bir marta.
// Qaror: odatda faqat o'zgargan chat(lar) yuboriladi (bir necha yuz bayt) — har xabarda har xodim butun ro'yxatni
// (500 tagacha chat, ~200 KB) qayta yuklamasin. To'liq qayta yuklash faqat ro'yxat Telegram'dan qayta olinganda.
let dialogsSignal: NodeJS.Timeout | null = null;
const changedPeers = new Set<string>();
let fullSignal = false;

function signalDialogs(peerId?: string) {
  if (peerId) changedPeers.add(peerId);
  else fullSignal = true;
  if (dialogsSignal) return;
  dialogsSignal = setTimeout(() => {
    dialogsSignal = null;
    const items = [...changedPeers].map((id) => dialogs.get(id)?.dto).filter(Boolean);
    const full = fullSignal || items.length !== changedPeers.size || items.length > 30;
    changedPeers.clear();
    fullSignal = false;
    // Menyu belgisi uchun o'qilmaganlar soni ham shu yerda — alohida so'rov kerak emas
    if (full) broadcast('tg-dialogs', { unread: unreadTotal() });
    else if (items.length) broadcast('tg-dialogs-patch', { items, unread: unreadTotal() });
  }, 800);
}

// ---------------- Chatlar ro'yxati (xotirada) ----------------

export type MediaKind = 'PHOTO' | 'VIDEO' | 'VIDEO_NOTE' | 'VOICE' | 'AUDIO' | 'STICKER' | 'GIF' | 'FILE' | 'CONTACT' | 'LOCATION' | 'POLL' | 'OTHER';

export interface DialogDto {
  peerId: string;
  title: string;
  kind: 'USER' | 'BOT' | 'GROUP' | 'CHANNEL';
  /** Telegram kontaktlarida bor (jildlar: «Kontaktlar» / «Kontakt emaslar») */
  contact: boolean;
  /** Xabar yozish mumkin (kanalda — faqat egasi/admin) */
  canWrite: boolean;
  phone: string | null;
  username: string | null;
  unread: number;
  pinned: boolean;
  archived: boolean;
  date: number;
  readOutboxMaxId: number;
  readInboxMaxId: number;
  muted: boolean;
  /** Profil rasmi versiyasi (bo'lmasa null): brauzer keshi kaliti */
  photoId: string | null;
  /** Foydalanuvchi holati (Telegram'dagi «online», «yaqinda», «oxirgi marta …») */
  status: UserStatus | null;
  members: number | null;
  lastMessage: { id: number; out: boolean; text: string; mediaKind: MediaKind | null; date: number; service: boolean } | null;
}

export type UserStatus = { kind: 'ONLINE' | 'OFFLINE' | 'RECENTLY' | 'LAST_WEEK' | 'LAST_MONTH' | 'LONG_AGO'; at: number | null };

interface CachedDialog {
  dto: DialogDto;
  input: Api.TypeInputPeer;
  entity: any;
}

function statusOf(st: any): UserStatus | null {
  if (!st) return null;
  if (st instanceof Api.UserStatusOnline) return { kind: 'ONLINE', at: st.expires };
  if (st instanceof Api.UserStatusOffline) return { kind: 'OFFLINE', at: st.wasOnline };
  if (st instanceof Api.UserStatusRecently) return { kind: 'RECENTLY', at: null };
  if (st instanceof Api.UserStatusLastWeek) return { kind: 'LAST_WEEK', at: null };
  if (st instanceof Api.UserStatusLastMonth) return { kind: 'LAST_MONTH', at: null };
  return { kind: 'LONG_AGO', at: null };
}

function photoIdOf(e: any): string | null {
  const ph = e?.photo;
  return ph && 'photoId' in ph && ph.photoId ? ph.photoId.toString() : null;
}

const dialogs = new Map<string, CachedDialog>();
// Bir vaqtda ko'pi bilan shuncha chat yuklanadi (Telegram'ga ~5 so'rov). Eskiroq chat qidiruvda chiqmaydi
const DIALOG_LIMIT = 500;

function entityTitle(e: any): string {
  if (!e) return '';
  if (e instanceof Api.User) {
    if (e.deleted) return 'Deleted Account';
    return [e.firstName, e.lastName].filter(Boolean).join(' ') || (e.phone ? `+${e.phone}` : '') || (e.username ?? '');
  }
  return e.title ?? '';
}

/** Yozish huquqi: kanalga faqat egasi/admin; guruhda taqiq bo'lsa yo'q (Telegram baribir tekshiradi — bu faqat UI uchun) */
function canWriteTo(e: any, broadcastChannel: boolean): boolean {
  if (!e) return false;
  if (e instanceof Api.User) return !e.deleted;
  if (e instanceof Api.Chat) return !e.left && !e.deactivated && !e.defaultBannedRights?.sendMessages;
  if (e instanceof Api.Channel) {
    if (e.creator) return true;
    if (broadcastChannel) return !!e.adminRights?.postMessages;
    return !e.left && (!!e.adminRights || !(e.bannedRights?.sendMessages || e.defaultBannedRights?.sendMessages));
  }
  return false;
}

function toDialog(d: any): CachedDialog | null {
  // Qaror (2026-11-17, rahbar talabi «Telegram'dagi hamma narsa»): kanallar ham chiqadi — Telegram jildlari
  // («Kanallar») to'liq ishlashi uchun. Kanalga yozish faqat egasi/adminga (canWrite)
  if (!d.id || !d.inputEntity) return null;
  const e = d.entity;
  const isUser = e instanceof Api.User;
  const isBroadcast = !!d.isChannel && !d.isGroup;
  const mute = d.dialog?.notifySettings?.muteUntil ?? 0;
  return {
    input: d.inputEntity,
    entity: e,
    dto: {
      peerId: d.id.toString(),
      title: entityTitle(e) || d.title || d.name || '',
      kind: isUser ? (e.bot ? 'BOT' : 'USER') : isBroadcast ? 'CHANNEL' : 'GROUP',
      contact: isUser && (!!e.contact || !!e.self),
      canWrite: canWriteTo(e, isBroadcast),
      phone: isUser && e.phone ? `+${e.phone}` : null,
      username: e?.username ?? null,
      unread: d.unreadCount ?? 0,
      pinned: !!d.pinned,
      archived: !!d.archived,
      date: d.date ?? 0,
      readOutboxMaxId: d.dialog?.readOutboxMaxId ?? 0,
      readInboxMaxId: d.dialog?.readInboxMaxId ?? 0,
      muted: mute > Date.now() / 1000,
      photoId: photoIdOf(e),
      status: isUser && !e.bot && !e.self ? statusOf(e.status) : null,
      members: !isUser ? (e?.participantsCount ?? null) : null,
      lastMessage: d.message ? lastOf(d.message) : null,
    },
  };
}

function lastOf(m: any): DialogDto['lastMessage'] {
  const service = m instanceof Api.MessageService;
  return { id: m.id, out: !!m.out, text: service ? '' : (m.message ?? ''), mediaKind: service ? null : mediaKind(m.media), date: m.date, service };
}

async function reloadDialogs() {
  const c = requireConnected();
  const list = await c.getDialogs({ limit: DIALOG_LIMIT });
  const fresh = new Map<string, CachedDialog>();
  for (const d of list) {
    const cd = toDialog(d);
    if (cd) fresh.set(cd.dto.peerId, cd);
  }
  dialogs.clear();
  for (const [k, v] of fresh) dialogs.set(k, v);
  signalDialogs();
}

// «O'qildi» (✓✓) uchun xavfsizlik to'ri. Muammo: mijoz xabarni o'qiganda Telegram'ning UpdateReadHistoryOutbox hodisasi
// sessiyaga ba'zan kelmaydi — ✓✓ faqat mijoz javob yozib, chat qayta o'qilganda chiqardi.
// Qaror: oxirgi xabari bizniki va hali o'qilmagan (yaqinda yozilgan) chatlar bir necha soniyada bir marta
// bitta GetPeerDialogs so'rovi bilan tekshiriladi. Bunday chat bo'lmasa Telegram'ga so'rov ketmaydi.
const READ_POLL_MS = 8_000;
const READ_POLL_WINDOW_S = 3 * 24 * 3600;
const READ_POLL_MAX = 50;
let readPolling = false;

async function pollReadOutbox() {
  const c = client;
  if (!c || readPolling) return;
  const now = Date.now() / 1000;
  const waiting = [...dialogs.values()]
    .filter((d) => {
      const lm = d.dto.lastMessage;
      return (d.dto.kind === 'USER' || d.dto.kind === 'GROUP') && !!lm && lm.out && !lm.service && lm.id > d.dto.readOutboxMaxId && now - lm.date < READ_POLL_WINDOW_S;
    })
    .sort((a, b) => b.dto.date - a.dto.date)
    .slice(0, READ_POLL_MAX);
  if (!waiting.length) return;
  readPolling = true;
  try {
    const r: any = await c.invoke(new Api.messages.GetPeerDialogs({ peers: waiting.map((d) => new Api.InputDialogPeer({ peer: d.input })) }));
    for (const dl of r?.dialogs ?? []) {
      if (!dl?.peer) continue;
      const peerId = utils.getPeerId(dl.peer);
      const d = dialogs.get(peerId);
      const max = dl.readOutboxMaxId ?? 0;
      if (!d || max <= d.dto.readOutboxMaxId) continue;
      d.dto.readOutboxMaxId = max;
      broadcast('tg-read', { peerId, outboxMaxId: max });
      signalDialogs(peerId);
    }
  } catch (e: any) {
    console.error("Telegram «o'qildi» holati tekshirilmadi:", e?.errorMessage ?? e);
  } finally {
    readPolling = false;
  }
}

/** Ko'p hodisa ketma-ket kelsa ham Telegram'ga bitta so'rov (debounce) */
function scheduleReload(delayMs = 3000) {
  if (!client || reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadDialogs().catch((e) => console.error('Telegram chatlari yangilanmadi:', e?.errorMessage ?? e));
  }, delayMs);
}

export function listDialogs(): DialogDto[] {
  requireConnected();
  // Telegram'dagidek: qadalganlar tepada, keyin oxirgi xabar vaqti bo'yicha
  return [...dialogs.values()]
    .map((d) => d.dto)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date - a.date);
}

/** Menyu belgisi uchun: arxiv va ovozi o'chirilganlardan tashqari o'qilmaganlar (butun ro'yxatni yubormaslik uchun) */
export function unreadTotal() {
  if (!client || !account) return 0;
  let n = 0;
  for (const d of dialogs.values()) if (!d.dto.archived && !d.dto.muted) n += d.dto.unread;
  return n;
}

export function getDialog(peerId: string) {
  return dialogs.get(peerId)?.dto ?? null;
}

async function inputPeer(peerId: string): Promise<Api.TypeInputPeer> {
  const c = requireConnected();
  const cached = dialogs.get(peerId);
  if (cached) return cached.input;
  // Ro'yxatda yo'q (juda eski chat): GramJS keshidan
  return tgCall(() => c.getInputEntity(bigInt(peerId)));
}

// ---------------- Xabarlar ----------------

function mediaKind(media: any): MediaKind | null {
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) return null;
  if (media instanceof Api.MessageMediaPhoto) return 'PHOTO';
  if (media instanceof Api.MessageMediaContact) return 'CONTACT';
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaVenue || media instanceof Api.MessageMediaGeoLive) return 'LOCATION';
  if (media instanceof Api.MessageMediaPoll) return 'POLL';
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const attrs = media.document.attributes;
    const audio = attrs.find((a) => a instanceof Api.DocumentAttributeAudio) as Api.DocumentAttributeAudio | undefined;
    if (audio) return audio.voice ? 'VOICE' : 'AUDIO';
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) return 'STICKER';
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)) return 'GIF';
    const video = attrs.find((a) => a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo | undefined;
    if (video) return video.roundMessage ? 'VIDEO_NOTE' : 'VIDEO';
    return 'FILE';
  }
  return 'OTHER';
}

export interface MessageDto {
  id: number;
  date: number;
  out: boolean;
  text: string;
  service: boolean;
  senderName: string | null;
  /** Guruhda yozgan odam (rang va avatar uchun) */
  senderId: string | null;
  replyToId: number | null;
  edited: boolean;
  forwardedFrom: string | null;
  /** Matn formatlash (Telegram entity'lari, UTF-16 bo'yicha offset) */
  entities: TextEntity[];
  media: {
    kind: MediaKind;
    mime: string | null;
    fileName: string | null;
    size: number | null;
    durationSec: number | null;
    width: number | null;
    height: number | null;
    // Kontakt, joylashuv, so'rovnoma — qisqa matn (fayl yo'q)
    label: string | null;
    /** Ovozli xabar to'lqini 0..31 */
    waveform: number[] | null;
    /** Video/fayl uchun kichik oldindan ko'rish rasmi bor */
    hasThumb: boolean;
  } | null;
  /** CRM'dan yozgan xodim (Telegram ilovasidan yozilgan bo'lsa null) */
  sentBy: string | null;
  /** Albom (Telegram'da bitta to'r bo'lib ko'rinadigan rasm/video/fayllar guruhi) */
  groupedId: string | null;
}

function mediaDto(m: any): MessageDto['media'] {
  const kind = mediaKind(m.media);
  if (!kind) return null;
  const base = { kind, mime: null, fileName: null, size: null, durationSec: null, width: null, height: null, label: null, waveform: null, hasThumb: false } as NonNullable<MessageDto['media']>;
  const media = m.media;
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    const sizes = media.photo.sizes.filter((s: any) => s.w && s.h) as any[];
    const big = sizes.at(-1);
    return { ...base, mime: 'image/jpeg', width: big?.w ?? null, height: big?.h ?? null };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    const attrs = d.attributes as any[];
    const fn = attrs.find((a) => a instanceof Api.DocumentAttributeFilename);
    const vid = attrs.find((a) => a instanceof Api.DocumentAttributeVideo);
    const aud = attrs.find((a) => a instanceof Api.DocumentAttributeAudio);
    const img = attrs.find((a) => a instanceof Api.DocumentAttributeImageSize);
    const st = attrs.find((a) => a instanceof Api.DocumentAttributeSticker);
    return {
      ...base,
      mime: d.mimeType,
      fileName: fn?.fileName ?? null,
      size: Number(d.size),
      durationSec: vid?.duration ?? aud?.duration ?? null,
      width: vid?.w ?? img?.w ?? null,
      height: vid?.h ?? img?.h ?? null,
      label: st?.alt || (aud && !aud.voice ? [aud.performer, aud.title].filter(Boolean).join(' — ') || null : null),
      waveform: aud?.voice && aud.waveform ? decodeWaveform(aud.waveform) : null,
      hasThumb: !!d.thumbs?.length,
    };
  }
  if (media instanceof Api.MessageMediaContact) {
    return { ...base, label: [[media.firstName, media.lastName].filter(Boolean).join(' '), media.phoneNumber ? `+${media.phoneNumber.replace(/^\+/, '')}` : ''].filter(Boolean).join(' · ') };
  }
  if (media instanceof Api.MessageMediaVenue) return { ...base, label: media.title || media.address };
  if (media instanceof Api.MessageMediaPoll) return { ...base, label: media.poll.question?.text ?? null };
  return base;
}

/** Telegram ovozli xabar to'lqini: 5 bitli qiymatlar ketma-ket joylangan */
function decodeWaveform(buf: Buffer): number[] {
  const count = Math.floor((buf.length * 8) / 5);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const byte = Math.floor((i * 5) / 8);
    const shift = (i * 5) % 8;
    out.push(((buf[byte] | ((buf[byte + 1] ?? 0) << 8)) >> shift) & 31);
  }
  return out;
}

export interface TextEntity {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'pre' | 'url' | 'textUrl' | 'email' | 'phone' | 'mention' | 'hashtag' | 'spoiler' | 'quote';
  offset: number;
  length: number;
  url?: string;
}

const ENTITY_TYPES: [any, TextEntity['type']][] = [
  [Api.MessageEntityBold, 'bold'],
  [Api.MessageEntityItalic, 'italic'],
  [Api.MessageEntityUnderline, 'underline'],
  [Api.MessageEntityStrike, 'strike'],
  [Api.MessageEntityCode, 'code'],
  [Api.MessageEntityPre, 'pre'],
  [Api.MessageEntityUrl, 'url'],
  [Api.MessageEntityTextUrl, 'textUrl'],
  [Api.MessageEntityEmail, 'email'],
  [Api.MessageEntityPhone, 'phone'],
  [Api.MessageEntityMention, 'mention'],
  [Api.MessageEntityMentionName, 'mention'],
  [Api.MessageEntityHashtag, 'hashtag'],
  [Api.MessageEntitySpoiler, 'spoiler'],
  [Api.MessageEntityBlockquote, 'quote'],
];

function entitiesOf(m: any): TextEntity[] {
  const out: TextEntity[] = [];
  for (const e of m.entities ?? []) {
    const t = ENTITY_TYPES.find(([cls]) => e instanceof cls)?.[1];
    if (!t) continue;
    out.push({ type: t, offset: e.offset, length: e.length, ...(t === 'textUrl' ? { url: e.url } : {}) });
  }
  return out;
}

function forwardedFrom(m: any): string | null {
  const f = m.fwdFrom;
  if (!f) return null;
  if (f.fromName) return f.fromName;
  const fwd = m.forward;
  return entityTitle(fwd?.sender) || entityTitle(fwd?.chat) || (f.fromId ? dialogs.get(utils.getPeerId(f.fromId))?.dto.title ?? '' : '') || '—';
}

function toMessage(m: any, isGroup: boolean, sentBy: string | null = null): MessageDto {
  const service = m instanceof Api.MessageService;
  return {
    id: m.id,
    date: m.date,
    out: !!m.out,
    text: service ? '' : (m.message ?? ''),
    service,
    // Guruhda kim yozgani; shaxsiy chatda kerak emas
    senderName: isGroup && !m.out ? entityTitle(m.sender) || null : null,
    senderId: isGroup && !m.out && m.senderId ? m.senderId.toString() : null,
    replyToId: m.replyTo?.replyToMsgId ?? null,
    edited: !service && !!m.editDate && !m.editHide,
    forwardedFrom: service ? null : forwardedFrom(m),
    entities: service ? [] : entitiesOf(m),
    media: service ? null : mediaDto(m),
    sentBy,
    groupedId: !service && m.groupedId ? m.groupedId.toString() : null,
  };
}

/** Guruhda har xabarda yozgan odam ko'rsatiladi; shaxsiy chat va kanalda — yo'q */
function isGroupPeer(peerId: string, peer?: Api.TypeInputPeer) {
  const kind = dialogs.get(peerId)?.dto.kind;
  if (kind) return kind === 'GROUP';
  return !!peer && !(peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf);
}

async function sentByMap(peerId: string, ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const rows = await q<{ message_id: number; full_name: string }>(
    pool,
    `SELECT s.message_id, u.full_name FROM tg_sent_message s JOIN app_user u ON u.id = s.user_id
     WHERE s.peer_id = $1 AND s.message_id = ANY($2::bigint[])`,
    [peerId, ids],
  );
  return new Map(rows.map((r) => [r.message_id, r.full_name]));
}

// So'nggi sahifa qisqa keshlanadi: bir nechta xodim bir chatni ochsa yoki ro'yxat yangilansa Telegram'ga qayta so'rov ketmaydi
const pageCache = new Map<string, { at: number; data: { items: MessageDto[]; hasMore: boolean } }>();
const PAGE_TTL_MS = 15_000;

function dropPageCache(peerId?: string | null) {
  if (!peerId) return pageCache.clear();
  for (const k of pageCache.keys()) if (k.startsWith(`${peerId}:`)) pageCache.delete(k);
}

export async function listMessages(peerId: string, before: number | undefined, limit: number) {
  const c = requireConnected();
  const key = `${peerId}:${before ?? 0}:${limit}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.data;
  const peer = await inputPeer(peerId);
  const msgs = await tgCall(() => c.getMessages(peer, { limit, offsetId: before ?? 0 }));
  const isGroup = isGroupPeer(peerId, peer);
  const by = await sentByMap(peerId, msgs.map((m) => m.id));
  const items = msgs.map((m) => toMessage(m, isGroup, by.get(m.id) ?? null)).reverse();
  const data = { items, hasMore: msgs.length === limit };
  pageCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------------- Fayl yuborish uchun (tgUpload.ts) ----------------

export const tgClient = () => requireConnected();
export const peerInput = (peerId: string) => inputPeer(peerId);

/** CRM'dan yuborilgan xabar(lar): muallif belgisi, chatlar ro'yxati va xodimlarga real vaqt */
export async function recordSent(peerId: string, msgs: any[], userId: number, userName: string) {
  if (!msgs.length) return [];
  await pool.query(
    `INSERT INTO tg_sent_message (peer_id, message_id, user_id) SELECT $1, unnest($2::bigint[]), $3 ON CONFLICT DO NOTHING`,
    [peerId, msgs.map((m) => m.id), userId],
  );
  const group = isGroupPeer(peerId);
  const dtos = msgs.map((m) => toMessage(m, group, userName));
  dropPageCache(peerId);
  touchDialog(peerId, msgs.at(-1));
  signalDialogs(peerId);
  for (const d of dtos) broadcast('tg-message', { peerId, message: d });
  return dtos;
}

export async function sendText(peerId: string, text: string, userId: number, userName: string, replyTo?: number) {
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  const m = await tgCall(() => c.sendMessage(peer, { message: text, replyTo, parseMode: false as any, linkPreview: true }));
  await pool.query(
    'INSERT INTO tg_sent_message (peer_id, message_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [peerId, m.id, userId],
  );
  const dto = toMessage(m, dialogs.get(peerId)?.dto.kind === 'GROUP', userName);
  dropPageCache(peerId);
  touchDialog(peerId, m);
  signalDialogs(peerId);
  // Telegram hodisasi (NewMessage) ham keladi, lekin muallifsiz: bu yerda muallif bilan qayta yuboriladi (frontend id bo'yicha almashtiradi)
  broadcast('tg-message', { peerId, message: dto });
  return dto;
}

/**
 * Xabar ekranda ko'ringan zahoti o'qilgan bo'ladi (Telegram kabi): `maxId` — ko'ringan eng oxirgi kiruvchi xabar.
 * `maxId` berilmasa — butun chat o'qiladi.
 */
export async function markRead(peerId: string, maxId?: number) {
  const c = requireConnected();
  const d = dialogs.get(peerId);
  if (d && (d.dto.unread === 0 || (maxId && maxId <= d.dto.readInboxMaxId))) return;
  const peer = await inputPeer(peerId);
  // `clearMentions: true` — gramjs'da bu ReadMentions'ni o'tkazib yuboradi (aks holda maxId bilan tarix o'qilmay qolishi mumkin)
  await tgCall(() => (maxId ? c.markAsRead(peer, undefined, { maxId, clearMentions: true }) : c.markAsRead(peer)));
  if (d) {
    if (!maxId || maxId >= (d.dto.lastMessage?.id ?? 0)) {
      d.dto.unread = 0;
      d.dto.readInboxMaxId = Math.max(d.dto.readInboxMaxId, maxId ?? d.dto.lastMessage?.id ?? 0);
    } else {
      // Qisman o'qildi: qolgan o'qilmaganlar soni Telegram'dan aniq olinadi
      d.dto.readInboxMaxId = Math.max(d.dto.readInboxMaxId, maxId);
      const r = await tgCall(() => c.invoke(new Api.messages.GetPeerDialogs({ peers: [new Api.InputDialogPeer({ peer })] }))).catch(() => null);
      const dl: any = r?.dialogs?.[0];
      if (dl) d.dto.unread = dl.unreadCount ?? d.dto.unread;
    }
  }
  signalDialogs(peerId);
}

export async function downloadMedia(peerId: string, msgId: number, maxBytes: number, thumb = false) {
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  const [m] = await tgCall(() => c.getMessages(peer, { ids: msgId }));
  if (!m || !m.media) return null;
  const info = mediaDto(m);
  if (!info || !['PHOTO', 'VIDEO', 'VIDEO_NOTE', 'VOICE', 'AUDIO', 'STICKER', 'GIF', 'FILE'].includes(info.kind)) return null;
  if (thumb) {
    // Video/fayl oldindan ko'rish rasmi (bir necha KB): eng kattasi
    const doc: any = (m.media as any)?.document;
    const n = doc?.thumbs?.length ?? 0;
    if (!n) return null;
    const tb = await tgCall(() => c.downloadMedia(m, { thumb: n - 1 }));
    if (!tb || typeof tb === 'string') return null;
    return { buf: tb as Buffer, info: { ...info, kind: 'PHOTO' as MediaKind, mime: 'image/jpeg', fileName: `thumb-${msgId}.jpg` } };
  }
  if (info.size && info.size > maxBytes) throw new AppError(413, 'TG_FILE_TOO_LARGE', 'Fayl juda katta — Telegram ilovasida oching', { maxBytes });
  const buf = await tgCall(() => c.downloadMedia(m, {}));
  if (!buf || typeof buf === 'string') return null;
  return { buf: buf as Buffer, info };
}

// ---------------- Video/ovoz oqimi (Range): Telegram kabi darhol o'ynaydi, oldinga-orqaga sakrash mumkin ----------------
// Qaror: butun fayl yuklanmaydi — brauzer so'ragan bo'lakni Telegram'dan 512 KB'lik qismlarda olib to'g'ridan-to'g'ri beradi.
// Serverda hech narsa saqlanmaydi; bitta video uchun brauzer ko'p so'rov yuboradi, shuning uchun xabar ma'lumoti qisqa keshlanadi.

const STREAM_CHUNK = 512 * 1024;
const mediaMsgCache = new Map<string, { at: number; m: any; peer: Api.TypeInputPeer }>();

async function mediaMessage(peerId: string, msgId: number) {
  const key = `${peerId}:${msgId}`;
  const hit = mediaMsgCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  const [m] = await tgCall(() => c.getMessages(peer, { ids: msgId }));
  const doc: any = (m?.media as any)?.document;
  if (!m || !(doc instanceof Api.Document)) throw new AppError(404, 'NOT_FOUND', 'Fayl topilmadi');
  const v = { at: Date.now(), m, peer };
  mediaMsgCache.set(key, v);
  if (mediaMsgCache.size > 300) mediaMsgCache.delete(mediaMsgCache.keys().next().value!);
  return v;
}

export async function streamInfo(peerId: string, msgId: number) {
  const { m } = await mediaMessage(peerId, msgId);
  const doc = (m.media as any).document as Api.Document;
  const info = mediaDto(m);
  return { size: Number(doc.size), mime: doc.mimeType || 'application/octet-stream', fileName: info?.fileName ?? null };
}

/** [start, end] oralig'i (ikkalasi ham kiradi) */
export async function* streamRange(peerId: string, msgId: number, start: number, end: number): AsyncGenerator<Buffer> {
  const c = requireConnected();
  const { m, peer } = await mediaMessage(peerId, msgId);
  const aligned = Math.floor(start / STREAM_CHUNK) * STREAM_CHUNK;
  let pos = aligned;
  const iter = c.iterDownload({
    file: m.media,
    offset: bigInt(aligned),
    requestSize: STREAM_CHUNK,
    limit: Math.ceil((end + 1 - aligned) / STREAM_CHUNK),
    // Fayl havolasi eskirsa (FILE_REFERENCE_EXPIRED) GramJS xabarni qayta olib davom etadi
    msgData: [peer, msgId],
  });
  for await (const chunk of iter as AsyncIterable<Buffer>) {
    const from = Math.max(0, start - pos);
    const to = Math.min(chunk.length, end + 1 - pos);
    if (to > from) yield chunk.subarray(from, to);
    pos += chunk.length;
    if (pos > end) break;
  }
}

// ---------------- Xabar amallari: tahrirlash, o'chirish, qadash, uzatish, tarjima ----------------
// Hammasi Telegram'ning o'zida bajariladi (CRM'da saqlanmaydi). O'chirish va tahrirlash audit'ga yoziladi —
// bitta akkauntdan bir nechta xodim ishlaydi, kim nima qilgani ko'rinsin (matnning o'zi yozilmaydi).

export async function editText(peerId: string, msgId: number, text: string, userId: number) {
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  let m: any;
  try {
    m = await c.editMessage(peer, { message: msgId, text, parseMode: false as any, linkPreview: true });
  } catch (e: any) {
    // Matn o'zgarmagan — xato emas, joriy xabar qaytadi
    if (e?.errorMessage !== 'MESSAGE_NOT_MODIFIED') throw tgError(e);
    [m] = await tgCall(() => c.getMessages(peer, { ids: msgId }));
    if (!m) throw new AppError(404, 'NOT_FOUND', 'Xabar topilmadi');
  }
  const by = await sentByMap(peerId, [m.id]);
  const dto = toMessage(m, isGroupPeer(peerId, peer), by.get(m.id) ?? null);
  const d = dialogs.get(peerId);
  if (d && d.dto.lastMessage?.id === m.id) d.dto.lastMessage = lastOf(m);
  dropPageCache(peerId);
  pinnedCache.delete(peerId);
  await audit(pool, { actorId: userId, entity: 'tg_message', entityId: `${peerId}:${msgId}`, action: 'TG_EDIT' });
  broadcast('tg-edit', { peerId, message: dto });
  signalDialogs(peerId);
  return dto;
}

/** revoke — suhbatdoshda ham o'chadi (kanal/superguruhda har doim hammada) */
export async function deleteMsgs(peerId: string, ids: number[], revoke: boolean, userId: number) {
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  await tgCall(() => c.deleteMessages(peer, ids, { revoke }));
  dropPageCache(peerId);
  pinnedCache.delete(peerId);
  await audit(pool, { actorId: userId, entity: 'tg_message', entityId: peerId, action: 'TG_DELETE', after: { ids, revoke } });
  // O'zimiz o'chirganda Telegram bu ulanishga hodisa yubormaydi: xodimlarga o'zimiz xabar beramiz
  broadcast('tg-delete', { peerId, ids });
  const d = dialogs.get(peerId);
  if (d?.dto.lastMessage && ids.includes(d.dto.lastMessage.id)) scheduleReload(500);
  return { ok: true };
}

// Qadalgan xabarlar: chat ochilganda bitta so'rov, qisqa kesh (bir nechta xodim bir chatni ochsa Telegram'ga bitta so'rov)
const pinnedCache = new Map<string, { at: number; items: MessageDto[] }>();
const PINNED_TTL_MS = 60_000;

/** Eng yangisi birinchi */
export async function listPinned(peerId: string) {
  const c = requireConnected();
  const hit = pinnedCache.get(peerId);
  if (hit && Date.now() - hit.at < PINNED_TTL_MS) return hit.items;
  const peer = await inputPeer(peerId);
  const msgs = await tgCall(() => c.getMessages(peer, { filter: new Api.InputMessagesFilterPinned(), limit: 50 }));
  const by = await sentByMap(peerId, msgs.map((m) => m.id));
  const group = isGroupPeer(peerId, peer);
  const items = msgs.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, group, by.get(m.id) ?? null));
  pinnedCache.set(peerId, { at: Date.now(), items });
  return items;
}

export async function setPinned(peerId: string, msgId: number, unpin: boolean, userId: number) {
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  // Qadash ovozsiz (Telegram'dagi «xabar berilmasin»): mijozga keraksiz bildirishnoma bormasin
  if (unpin) await tgCall(() => c.unpinMessage(peer, msgId));
  else await tgCall(() => c.pinMessage(peer, msgId, { notify: false }));
  pinnedCache.delete(peerId);
  dropPageCache(peerId);
  await audit(pool, { actorId: userId, entity: 'tg_message', entityId: `${peerId}:${msgId}`, action: unpin ? 'TG_UNPIN' : 'TG_PIN' });
  broadcast('tg-pinned', { peerId });
  return { ok: true };
}

/** Uzatish: bir nechta xabar, ko'pi bilan bir necha chatga (ommaviy yuborish emas — route cheklaydi) */
export async function forward(fromPeerId: string, ids: number[], toPeerIds: string[], userId: number) {
  const c = requireConnected();
  const from = await inputPeer(fromPeerId);
  const name = (await one<{ full_name: string }>(pool, 'SELECT full_name FROM app_user WHERE id = $1', [userId]))?.full_name ?? null;
  for (const to of toPeerIds) {
    const peer = await inputPeer(to);
    const sent = (await tgCall(() => c.forwardMessages(peer, { messages: ids, fromPeer: from }))).filter(Boolean);
    if (sent.length) {
      await pool.query(
        `INSERT INTO tg_sent_message (peer_id, message_id, user_id) SELECT $1, unnest($2::bigint[]), $3 ON CONFLICT DO NOTHING`,
        [to, sent.map((m) => m.id), userId],
      );
      dropPageCache(to);
      touchDialog(to, sent.at(-1));
      const group = isGroupPeer(to, peer);
      for (const m of sent) broadcast('tg-message', { peerId: to, message: toMessage(m, group, name) });
      signalDialogs(to);
    }
  }
  return { ok: true };
}

/** Telegram'ning o'z tarjimoni (Telegram ilovasidagi «Tarjima qilish» bilan bir xil) */
export async function translate(peerId: string, ids: number[], toLang: string) {
  const c = requireConnected();
  const peer = await inputPeer(peerId);
  const r = await tgCall(() => c.invoke(new Api.messages.TranslateText({ peer, id: ids, toLang })));
  return r.result.map((x) => ({ text: x.text, entities: entitiesOf(x) }));
}

// ---------------- Jildlar (Telegram papkalari) ----------------

export interface FolderDto {
  id: number;
  title: string;
  emoticon: string | null;
  contacts: boolean;
  nonContacts: boolean;
  groups: boolean;
  broadcasts: boolean;
  bots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
  /** Har doim kiradigan / hech qachon kirmaydigan / jild ichida qadalgan chatlar (tartib bilan) */
  include: string[];
  exclude: string[];
  pinned: string[];
}

// Jildlar xotirada: ulanganda bir marta, keyin Telegram hodisasi kelganda (jild telefondan o'zgartirilsa) qayta olinadi.
// Qaror: qaysi chat qaysi jildga kirishi brauzerda hisoblanadi — o'qilmaganlar/ovoz o'zgarganda ro'yxat qayta yuborilmaydi
let folders: FolderDto[] | null = null;

function peerIdsOf(list: Api.TypeInputPeer[]): string[] {
  const out: string[] = [];
  for (const p of list ?? []) {
    try {
      if (p instanceof Api.InputPeerSelf) {
        if (account?.tgUserId) out.push(account.tgUserId);
      } else out.push(utils.getPeerId(p));
    } catch {
      /* noma'lum peer — o'tkaziladi */
    }
  }
  return out;
}

async function reloadFolders() {
  const c = requireConnected();
  const r: any = await c.invoke(new Api.messages.GetDialogFilters());
  const list: any[] = Array.isArray(r) ? r : (r?.filters ?? []);
  folders = list
    .filter((f) => f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist)
    .map((f) => {
      const full = f instanceof Api.DialogFilter;
      return {
        id: f.id,
        title: typeof f.title === 'string' ? f.title : (f.title?.text ?? ''),
        emoticon: f.emoticon ?? null,
        contacts: full && !!f.contacts,
        nonContacts: full && !!f.nonContacts,
        groups: full && !!f.groups,
        broadcasts: full && !!f.broadcasts,
        bots: full && !!f.bots,
        excludeMuted: full && !!f.excludeMuted,
        excludeRead: full && !!f.excludeRead,
        excludeArchived: full && !!f.excludeArchived,
        include: peerIdsOf(f.includePeers),
        exclude: full ? peerIdsOf(f.excludePeers) : [],
        pinned: peerIdsOf(f.pinnedPeers),
      };
    });
  broadcast('tg-folders', {});
}

let foldersTimer: NodeJS.Timeout | null = null;
function scheduleFolders() {
  if (!client || foldersTimer) return;
  foldersTimer = setTimeout(() => {
    foldersTimer = null;
    reloadFolders().catch((e) => console.error('Telegram jildlari yangilanmadi:', e?.errorMessage ?? e));
  }, 1000);
}

export async function listFolders() {
  requireConnected();
  if (!folders) await tgCall(() => reloadFolders());
  return folders ?? [];
}

// ---------------- Profil rasmlari ----------------

// Kichik avatarlar (~5–15 KB) xotirada: chatlar ro'yxati har ochilganda Telegram'ga qayta so'rov ketmasin. Diskka yozilmaydi
const photoCache = new Map<string, Buffer | null>();
const PHOTO_CACHE_MAX = 400;

export async function profilePhoto(peerId: string) {
  const c = requireConnected();
  const d = dialogs.get(peerId);
  if (d && !d.dto.photoId) return null;
  const key = `${peerId}:${d?.dto.photoId ?? 'x'}`;
  if (photoCache.has(key)) {
    const v = photoCache.get(key)!;
    photoCache.delete(key);
    photoCache.set(key, v);
    return v;
  }
  const target = d?.entity ?? (await inputPeer(peerId));
  const buf = await tgCall(() => c.downloadProfilePhoto(target, { isBig: false })).catch(() => undefined);
  const v = buf && typeof buf !== 'string' && buf.length ? (buf as Buffer) : null;
  photoCache.set(key, v);
  if (photoCache.size > PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value!);
  return v;
}

// ---------------- Telegram hodisalari ----------------

function touchDialog(peerId: string, m: any) {
  const d = dialogs.get(peerId);
  if (!d) return scheduleReload();
  if (d.dto.lastMessage && d.dto.lastMessage.id > m.id) return;
  d.dto.lastMessage = lastOf(m);
  d.dto.date = m.date;
  if (m.out) d.dto.unread = 0;
}

async function onNewMessage(ev: NewMessageEvent) {
  const m = ev.message;
  if (!m?.peerId) return;
  const peerId = utils.getPeerId(m.peerId);
  const d = dialogs.get(peerId);
  if (!d) {
    // Yangi chat (yoki kanal — reload'da tashlab yuboriladi)
    scheduleReload(1000);
    if (m.peerId instanceof Api.PeerChannel) return;
  }
  const isGroup = d ? d.dto.kind === 'GROUP' : !(m.peerId instanceof Api.PeerUser);
  if (isGroup && !m.out && !m.sender) await m.getSender().catch(() => undefined);
  const wasLast = d?.dto.lastMessage?.id ?? 0;
  touchDialog(peerId, m);
  if (d && !m.out && m.id > wasLast) d.dto.unread += 1;
  dropPageCache(peerId);
  broadcast('tg-message', { peerId, message: toMessage(m, isGroup) });
  signalDialogs(peerId);
}

function peerOf(u: any): string | null {
  if (u.peer) return utils.getPeerId(u.peer);
  if (u.channelId) return utils.getPeerId(new Api.PeerChannel({ channelId: u.channelId }));
  return null;
}

async function onRawUpdate(u: Api.TypeUpdate) {
  if (u instanceof Api.UpdateEditMessage || u instanceof Api.UpdateEditChannelMessage) {
    const m: any = u.message;
    if (!m?.peerId) return;
    const peerId = utils.getPeerId(m.peerId);
    const d = dialogs.get(peerId);
    if (d && d.dto.lastMessage?.id === m.id) d.dto.lastMessage = lastOf(m);
    dropPageCache(peerId);
    const by = await sentByMap(peerId, [m.id]).catch(() => new Map<number, string>());
    broadcast('tg-edit', { peerId, message: toMessage(m, d?.dto.kind === 'GROUP', by.get(m.id) ?? null) });
    signalDialogs(peerId);
  } else if (u instanceof Api.UpdateDeleteMessages || u instanceof Api.UpdateDeleteChannelMessages) {
    // Shaxsiy chat/oddiy guruhda o'chirish hodisasida chat ko'rsatilmaydi: hammasi qayta o'qiladi
    const peerId = peerOf(u);
    dropPageCache(peerId);
    broadcast('tg-delete', { peerId, ids: u.messages });
    scheduleReload();
  } else if (u instanceof Api.UpdateReadHistoryOutbox || u instanceof Api.UpdateReadChannelOutbox) {
    const peerId = peerOf(u);
    const d = peerId ? dialogs.get(peerId) : undefined;
    if (!peerId || !d) return;
    d.dto.readOutboxMaxId = Math.max(d.dto.readOutboxMaxId, u.maxId);
    broadcast('tg-read', { peerId, outboxMaxId: d.dto.readOutboxMaxId });
    signalDialogs(peerId);
  } else if (u instanceof Api.UpdateReadHistoryInbox || u instanceof Api.UpdateReadChannelInbox) {
    // Telefondan yoki boshqa qurilmadan o'qildi
    const peerId = peerOf(u);
    const d = peerId ? dialogs.get(peerId) : undefined;
    if (!d) return;
    d.dto.unread = u.stillUnreadCount ?? 0;
    d.dto.readInboxMaxId = u.maxId;
    signalDialogs(peerId!);
  } else if (u instanceof Api.UpdatePinnedMessages || u instanceof Api.UpdatePinnedChannelMessages) {
    // Telefondan yoki boshqa qurilmadan qadaldi/olindi
    const peerId = peerOf(u);
    if (!peerId) return;
    pinnedCache.delete(peerId);
    broadcast('tg-pinned', { peerId });
  } else if (u instanceof Api.UpdateDialogFilter || u instanceof Api.UpdateDialogFilters || u instanceof Api.UpdateDialogFilterOrder) {
    scheduleFolders();
  } else if (u instanceof Api.UpdateDialogPinned || u instanceof Api.UpdatePinnedDialogs || u instanceof Api.UpdateFolderPeers || u instanceof Api.UpdateNotifySettings) {
    scheduleReload();
  } else if (u instanceof Api.UpdateUserStatus) {
    // «online»/«oxirgi marta» — juda tez-tez keladi: faqat xotirada yangilanadi, xodimlarga alohida signal yuborilmaydi
    const d = dialogs.get(u.userId.toString());
    if (d && d.dto.kind === 'USER') d.dto.status = statusOf(u.status);
  } else if (u instanceof Api.UpdateUserTyping || u instanceof Api.UpdateChatUserTyping || u instanceof Api.UpdateChannelUserTyping) {
    // «yozmoqda…» — vaqtinchalik signal, hech qayerda saqlanmaydi
    const peerId =
      u instanceof Api.UpdateUserTyping
        ? u.userId.toString()
        : u instanceof Api.UpdateChatUserTyping
          ? utils.getPeerId(new Api.PeerChat({ chatId: u.chatId }))
          : utils.getPeerId(new Api.PeerChannel({ channelId: u.channelId }));
    if (!dialogs.has(peerId)) return;
    const typing = !(u.action instanceof Api.SendMessageCancelAction);
    broadcast('tg-typing', { peerId, typing, kind: u.action?.className ?? null });
  }
}
