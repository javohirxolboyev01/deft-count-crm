import { config } from '../config';
import type { Role } from '../common/auth';
import { one, pool, q } from '../db';
import { telegramTexts } from './messages';
import { botUserByChat, commandsFor, runCommand } from './telegramCommands';

const api = (method: string) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

export const telegramEnabled = () => Boolean(config.telegram.token);

export async function sendTelegram(chatId: number | string, text: string) {
  const r = await fetch(api('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

async function callTelegram(method: string, body: object) {
  const r = await fetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Telegram ${method} ${r.status}: ${await r.text()}`);
}

/**
 * Har chatga o'z roli menyusi (scope: chat) — rahbar buyruqlari buxgalter menyusida ko'rinmaydi.
 * Bu faqat qulaylik: ruxsat baribir har buyruqda serverda tekshiriladi (runCommand).
 */
export async function syncChatCommands(chatId: number, role: Role, lang: 'uz' | 'ru') {
  if (!telegramEnabled()) return;
  await callTelegram('setMyCommands', { commands: commandsFor(role, lang), scope: { type: 'chat', chat_id: chatId } });
}

/** Bog'lash uzilganda chat menyusi standartga (faqat /help) qaytadi */
export async function clearChatCommands(chatId: number) {
  if (!telegramEnabled()) return;
  await callTelegram('deleteMyCommands', { scope: { type: 'chat', chat_id: chatId } }).catch(() => undefined);
}

/**
 * Xodimning roli/tili/faolligi o'zgargach chat menyusini moslash (javobni kutmaydi, xato jim — menyu faqat qulaylik).
 * Faolsizlantirilgan xodim chatida menyu standartga qaytadi; buyruqlarga baribir javob berilmaydi (botUserByChat).
 */
export function refreshUserCommands(userId: number) {
  if (!telegramEnabled()) return;
  void one<{ chatId: string | null; role: Role; language: 'uz' | 'ru'; ok: boolean }>(
    pool,
    `SELECT telegram_chat_id AS "chatId", role, language, (active AND deleted_at IS NULL) AS ok FROM app_user WHERE id = $1`,
    [userId],
  )
    .then((u) => {
      if (!u?.chatId) return;
      return u.ok ? syncChatCommands(Number(u.chatId), u.role, u.language) : clearChatCommands(Number(u.chatId));
    })
    .catch((e) => console.error('Telegram menyu:', e.message));
}

/** Ishga tushganda: standart menyu + bog'langan har xodimga o'z roli menyusi (rol o'zgargan bo'lsa ham to'g'rilanadi) */
async function syncAllCommands() {
  await callTelegram('setMyCommands', { commands: [{ command: 'help', description: 'Yordam / Помощь' }] });
  const users = await q<{ chatId: string; role: Role; language: 'uz' | 'ru' }>(
    pool,
    `SELECT telegram_chat_id AS "chatId", role, language FROM app_user
     WHERE telegram_chat_id IS NOT NULL AND active AND deleted_at IS NULL`,
  );
  for (const u of users) await syncChatCommands(Number(u.chatId), u.role, u.language).catch(() => undefined);
}

/**
 * Bot kirishi: /start <kod> — xodimning telegram_chat_id sini bog'lash; bog'langan chatda buyruqlar (rolga qarab).
 * Mijozlarga bot xabar yubormaydi; bog'lanmagan chatga hech qanday ma'lumot berilmaydi.
 */
export async function handleTelegramText(chatId: number, text: string) {
  const m = /^\/start(?:\s+(\S+))?/.exec(text.trim());
  if (m?.[1]) {
    await linkByCode(chatId, m[1].toUpperCase());
    return;
  }
  const u = await botUserByChat(chatId);
  if (!u) {
    await sendTelegram(chatId, `${telegramTexts.help.uz}\n\n${telegramTexts.help.ru}`);
    return;
  }
  // "/urgent@BotName" ham qabul qilinadi; buyruq bo'lmagan matnga yordam
  const cmd = /^\/([a-z_]+)(?:@\S+)?/i.exec(text.trim())?.[1]?.toLowerCase() ?? 'help';
  await sendTelegram(chatId, await runCommand(u, cmd));
}

async function linkByCode(chatId: number, code: string) {
  const sql = `UPDATE app_user SET telegram_chat_id = $1, telegram_link_code = NULL, telegram_link_expires_at = NULL
     WHERE telegram_link_code = $2 AND telegram_link_expires_at > now() AND active AND deleted_at IS NULL
     RETURNING id, role, language, full_name AS "fullName"`;
  type Linked = { id: number; role: Role; language: 'uz' | 'ru'; fullName: string };
  const u = await one<Linked>(pool, sql, [chatId, code]).catch(async (e) => {
    // Bitta Telegram — bitta xodim (UNIQUE): shu chat boshqa xodimga bog'langan bo'lsa, o'shanisidan uziladi
    if (e.code === '23505') {
      await pool.query('UPDATE app_user SET telegram_chat_id = NULL WHERE telegram_chat_id = $1', [chatId]);
      return one<Linked>(pool, sql, [chatId, code]);
    }
    throw e;
  });
  if (!u) {
    await sendTelegram(chatId, `${telegramTexts.badCode.uz}\n\n${telegramTexts.badCode.ru}`);
    return;
  }
  await syncChatCommands(chatId, u.role, u.language).catch((e) => console.error('Telegram menyu:', e.message));
  await sendTelegram(chatId, `${telegramTexts.linked[u.language]}\n\n${await runCommand(u, 'help')}`);
}

let stopped = false;

/** Long polling (webhook uchun ochiq domen shart emas) */
export async function startTelegramPolling() {
  if (!telegramEnabled()) return;
  let offset = 0;
  console.log('Telegram bot: long polling boshlandi');
  await syncAllCommands().catch((e) => console.error('Telegram menyu:', (e as Error).message));
  while (!stopped) {
    try {
      const r = await fetch(api('getUpdates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 30, allowed_updates: ['message'] }),
        signal: AbortSignal.timeout(40000),
      });
      const data: any = await r.json();
      for (const upd of data.result ?? []) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (msg?.chat?.type === 'private' && typeof msg.text === 'string') {
          await handleTelegramText(msg.chat.id, msg.text).catch((e) => console.error('Telegram:', e.message));
        }
      }
    } catch (e) {
      if (!stopped) {
        console.error('Telegram polling xatosi:', (e as Error).message);
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  }
}

export function stopTelegramPolling() {
  stopped = true;
}
