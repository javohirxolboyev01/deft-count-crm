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
  };
  const k = known[m];
  if (k) return new AppError(k[0], k[1], m);
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

async function activate(c: TelegramClient, info: NonNullable<typeof account>) {
  client = c;
  account = info;
  c.addEventHandler(onNewMessage, new NewMessage({}));
  c.addEventHandler(onRawUpdate, new Raw({}));
  await reloadDialogs().catch((e) => console.error('Telegram chatlari yuklanmadi:', e?.errorMessage ?? e));
  // Xavfsizlik to'ri: hodisa o'tkazib yuborilsa ham ro'yxat 10 daqiqada bir to'liq yangilanadi
  fullReloadTimer = setInterval(() => scheduleReload(0), 10 * 60_000);
  broadcast('tg-status', {});
}

async function deactivate() {
  if (fullReloadTimer) clearInterval(fullReloadTimer);
  if (reloadTimer) clearTimeout(reloadTimer);
  fullReloadTimer = reloadTimer = null;
  client?.removeEventHandler(onNewMessage, new NewMessage({}));
  client?.removeEventHandler(onRawUpdate, new Raw({}));
  client = null;
  account = null;
  dialogs.clear();
  pageCache.clear();
  photoCache.clear();
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
  kind: 'USER' | 'BOT' | 'GROUP';
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

function toDialog(d: any): CachedDialog | null {
  // Kanallar (faqat o'qiladigan) chiqmaydi — mijozlar bilan yozishma shaxsiy chat va guruhlarda
  if (d.isChannel && !d.isGroup) return null;
  if (!d.id || !d.inputEntity) return null;
  const e = d.entity;
  const isUser = e instanceof Api.User;
  const mute = d.dialog?.notifySettings?.muteUntil ?? 0;
  return {
    input: d.inputEntity,
    entity: e,
    dto: {
      peerId: d.id.toString(),
      title: entityTitle(e) || d.title || d.name || '',
      kind: isUser ? (e.bot ? 'BOT' : 'USER') : 'GROUP',
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
  };
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
  const isGroup = dialogs.get(peerId)?.dto.kind === 'GROUP' || !(peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf);
  const by = await sentByMap(peerId, msgs.map((m) => m.id));
  const items = msgs.map((m) => toMessage(m, isGroup, by.get(m.id) ?? null)).reverse();
  const data = { items, hasMore: msgs.length === limit };
  pageCache.set(key, { at: Date.now(), data });
  return data;
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

/** Chat ochilganda: Telegram'da ham o'qilgan bo'ladi (Telegram Desktop kabi) */
export async function markRead(peerId: string) {
  const c = requireConnected();
  const d = dialogs.get(peerId);
  if (d && d.dto.unread === 0) return;
  const peer = await inputPeer(peerId);
  await tgCall(() => c.markAsRead(peer));
  if (d) d.dto.unread = 0;
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
