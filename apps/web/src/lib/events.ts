import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getAccessToken, refreshAccess } from './api';
import { clearTgTyping, patchTgDialogs, removeTgMessages, setTgReadOutbox, setTgTyping, tgKeys, upsertTgMessage } from './tgCache';
import type { AppNotification, ChatMessageEvent, TgDialog, TgMessage } from './types';

/**
 * Backend SSE (/api/events) ga ulanish. Yangi bildirishnoma kelsa: ro'yxatlar yangilanadi va callback chaqiriladi.
 * Ulanish uzilsa (token muddati), token yangilanib qayta ulanadi.
 */
export function useServerEvents(
  enabled: boolean,
  onNotification: (n: AppNotification) => void,
  onChatMessage?: (m: ChatMessageEvent) => void,
  onTgMessage?: (peerId: string, m: TgMessage) => void,
) {
  const qc = useQueryClient();
  const cb = useRef(onNotification);
  cb.current = onNotification;
  const chatCb = useRef(onChatMessage);
  chatCb.current = onChatMessage;
  const onTgMessageRef = useRef(onTgMessage);
  onTgMessageRef.current = onTgMessage;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let connectedOnce = false;

    const connect = () => {
      const token = getAccessToken();
      if (!token || closed) return;
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.addEventListener('notification', (e) => {
        const n = JSON.parse((e as MessageEvent).data) as AppNotification;
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['my-day'] });
        if (n.kind === 'TASK_TRANSFER' || n.kind === 'TASK_TRANSFER_RESULT' || n.kind === 'TASK_CANCELLED') {
          void qc.invalidateQueries({ queryKey: ['transfers'] });
          void qc.invalidateQueries({ queryKey: ['task'] });
        }
        cb.current(n);
      });
      // Chat: suhbatdoshlar ro'yxati, badge va ochiq suhbat qayta o'qiladi (~10 xodim — yengil)
      es.addEventListener('chat-message', (e) => {
        const m = JSON.parse((e as MessageEvent).data) as ChatMessageEvent;
        void qc.invalidateQueries({ queryKey: ['chat'] });
        chatCb.current?.(m);
      });
      // Xabar tahrirlandi yoki o'chirildi (ikkala tomonga)
      es.addEventListener('chat-update', () => {
        void qc.invalidateQueries({ queryKey: ['chat'] });
      });
      es.addEventListener('chat-read', () => {
        void qc.invalidateQueries({ queryKey: ['chat'] });
      });
      // Firma Telegram akkaunti (V53): faqat rahbar va buxgalterlarga keladi
      es.addEventListener('tg-message', (e) => {
        const { peerId, message } = JSON.parse((e as MessageEvent).data) as { peerId: string; message: TgMessage };
        upsertTgMessage(qc, peerId, message);
        if (!message.out) clearTgTyping(peerId);
        onTgMessageRef.current?.(peerId, message);
      });
      es.addEventListener('tg-edit', (e) => {
        const { peerId, message } = JSON.parse((e as MessageEvent).data) as { peerId: string; message: TgMessage };
        upsertTgMessage(qc, peerId, message, false);
      });
      es.addEventListener('tg-delete', (e) => {
        const { peerId, ids } = JSON.parse((e as MessageEvent).data) as { peerId: string | null; ids: number[] };
        removeTgMessages(qc, peerId, ids);
      });
      es.addEventListener('tg-read', (e) => {
        const { peerId, outboxMaxId } = JSON.parse((e as MessageEvent).data) as { peerId: string; outboxMaxId: number };
        setTgReadOutbox(qc, peerId, outboxMaxId);
      });
      es.addEventListener('tg-typing', (e) => {
        const { peerId, typing } = JSON.parse((e as MessageEvent).data) as { peerId: string; typing: boolean };
        setTgTyping(peerId, typing);
      });
      es.addEventListener('tg-dialogs', (e) => {
        const { unread } = JSON.parse((e as MessageEvent).data) as { unread?: number };
        void qc.invalidateQueries({ queryKey: tgKeys.dialogs });
        if (typeof unread === 'number') qc.setQueryData(tgKeys.unread, { count: unread });
      });
      es.addEventListener('tg-dialogs-patch', (e) => {
        const { items, unread } = JSON.parse((e as MessageEvent).data) as { items: TgDialog[]; unread: number };
        patchTgDialogs(qc, items);
        qc.setQueryData(tgKeys.unread, { count: unread });
      });
      // Qayta ulanish (internet uzilib qolgan): shu orada kelgan Telegram xabarlari o'tkazib yuborilmasin
      es.addEventListener('ready', () => {
        if (connectedOnce) void qc.invalidateQueries({ queryKey: ['tg'] });
        connectedOnce = true;
      });
      es.addEventListener('tg-folders', () => {
        void qc.invalidateQueries({ queryKey: tgKeys.folders });
      });
      es.addEventListener('tg-pinned', (e) => {
        const { peerId } = JSON.parse((e as MessageEvent).data) as { peerId: string };
        void qc.invalidateQueries({ queryKey: tgKeys.pinned(peerId) });
      });
      es.addEventListener('tg-status', () => {
        void qc.invalidateQueries({ queryKey: ['tg'] });
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        retry = setTimeout(async () => {
          await refreshAccess().catch(() => undefined);
          connect();
        }, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [enabled, qc]);
}
