import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { TgDialog, TgMessage } from './types';

/**
 * Firma Telegram chatlari (V53) uchun react-query keshi. Xabarlar serverda saqlanmaydi, shuning uchun SSE hodisasi
 * kelganda ochiq suhbat qayta so'ralmaydi — xabar keshga to'g'ridan-to'g'ri qo'shiladi/almashtiriladi
 * (har yangi xabarda har xodimdan Telegram'ga so'rov ketmasin).
 */

export interface TgPage {
  items: TgMessage[];
  hasMore: boolean;
}
type Pages = InfiniteData<TgPage, number | undefined>;

export const tgKeys = {
  status: ['tg', 'status'] as const,
  dialogs: ['tg', 'dialogs'] as const,
  unread: ['tg', 'unread'] as const,
  messages: (peerId: string) => ['tg', 'messages', peerId] as const,
};

/** pages[0] — eng yangi sahifa, keyingilari eskiroq. Har sahifa ichida eskidan yangiga */
export function upsertTgMessage(qc: QueryClient, peerId: string, m: TgMessage, appendIfMissing = true) {
  qc.setQueryData<Pages>(tgKeys.messages(peerId), (data) => {
    if (!data) return data;
    let found = false;
    const pages = data.pages.map((p) => ({
      ...p,
      items: p.items.map((x) => {
        if (x.id !== m.id) return x;
        found = true;
        // Telegram hodisasida muallif yo'q, CRM javobida bor: bor ma'lumot yo'qolmasin
        return { ...m, sentBy: m.sentBy ?? x.sentBy };
      }),
    }));
    if (!found && appendIfMissing && pages.length) {
      const first = pages[0];
      pages[0] = { ...first, items: [...first.items, m].sort((a, b) => a.id - b.id) };
    }
    return { ...data, pages };
  });
}

/** peerId null: shaxsiy chat/oddiy guruh (id'lar akkaunt bo'yicha yagona) — superguruhlardan tashqari hammasidan */
export function removeTgMessages(qc: QueryClient, peerId: string | null, ids: number[]) {
  const drop = new Set(ids);
  const queries = qc.getQueriesData<Pages>({ queryKey: ['tg', 'messages'] });
  for (const [key] of queries) {
    const pid = String(key[2]);
    if (peerId ? pid !== peerId : pid.startsWith('-100')) continue;
    qc.setQueryData<Pages>(key, (data) =>
      data && { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((x) => !drop.has(x.id)) })) },
    );
  }
}

/** Server faqat o'zgargan chatlarni yuboradi: ro'yxat qayta so'ralmaydi, joyida yangilanadi (Telegram tartibida) */
export function patchTgDialogs(qc: QueryClient, items: TgDialog[]) {
  qc.setQueryData<TgDialog[]>(tgKeys.dialogs, (list) => {
    if (!list) return list;
    const byId = new Map(list.map((d) => [d.peerId, d]));
    for (const d of items) byId.set(d.peerId, d);
    return [...byId.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date - a.date);
  });
}

export function setTgReadOutbox(qc: QueryClient, peerId: string, maxId: number) {
  qc.setQueryData<TgDialog[]>(tgKeys.dialogs, (list) =>
    list?.map((d) => (d.peerId === peerId ? { ...d, readOutboxMaxId: Math.max(d.readOutboxMaxId, maxId) } : d)),
  );
}

// ---------------- «yozmoqda…» (vaqtinchalik, faqat xotirada) ----------------

const typing = new Map<string, ReturnType<typeof setTimeout>>();
const typingListeners = new Set<() => void>();
let typingVersion = 0;

function notifyTyping() {
  typingVersion++;
  typingListeners.forEach((l) => l());
}

/** Telegram «yozmoqda» signalini ~6 soniyada qaytaradi: yangilanmasa o'zi o'chadi */
export function setTgTyping(peerId: string, on: boolean) {
  const old = typing.get(peerId);
  if (old) clearTimeout(old);
  if (on) {
    typing.set(
      peerId,
      setTimeout(() => {
        typing.delete(peerId);
        notifyTyping();
      }, 6000),
    );
  } else typing.delete(peerId);
  notifyTyping();
}

/** Yangi xabar kelsa «yozmoqda» darhol o'chadi */
export function clearTgTyping(peerId: string) {
  if (typing.has(peerId)) setTgTyping(peerId, false);
}

export function useTgTyping() {
  useSyncExternalStore(
    (l) => {
      typingListeners.add(l);
      return () => typingListeners.delete(l);
    },
    () => typingVersion,
  );
  return (peerId: string) => typing.has(peerId);
}

/** Uzoq ishlaganda brauzer xotirasi o'smasin: eng eski blob: URL'lar bo'shatiladi */
export function trimCache(cache: Map<string, Promise<string | null>>, max: number) {
  while (cache.size > max) {
    const [key, p] = cache.entries().next().value!;
    cache.delete(key);
    void p.then((u) => u && URL.revokeObjectURL(u)).catch(() => undefined);
  }
}
