import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getAccessToken, refreshAccess } from './api';
import type { AppNotification, ChatMessageEvent } from './types';

/**
 * Backend SSE (/api/events) ga ulanish. Yangi bildirishnoma kelsa: ro'yxatlar yangilanadi va callback chaqiriladi.
 * Ulanish uzilsa (token muddati), token yangilanib qayta ulanadi.
 */
export function useServerEvents(
  enabled: boolean,
  onNotification: (n: AppNotification) => void,
  onChatMessage?: (m: ChatMessageEvent) => void,
) {
  const qc = useQueryClient();
  const cb = useRef(onNotification);
  cb.current = onNotification;
  const chatCb = useRef(onChatMessage);
  chatCb.current = onChatMessage;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const token = getAccessToken();
      if (!token || closed) return;
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.addEventListener('notification', (e) => {
        const n = JSON.parse((e as MessageEvent).data) as AppNotification;
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['my-day'] });
        if (n.kind === 'TASK_TRANSFER' || n.kind === 'TASK_TRANSFER_RESULT') {
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
