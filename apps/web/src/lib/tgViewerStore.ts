import { useSyncExternalStore } from 'react';

/** Rasm/video ko'ruvchisi (Telegram kabi CRM ichida, butun ekranda): qaysi chatning qaysi xabari ochiq */
let open: { peerId: string; msgId: number } | null = null;
const listeners = new Set<() => void>();

export function openViewer(peerId: string, msgId: number) {
  open = { peerId, msgId };
  listeners.forEach((l) => l());
}

export function closeViewer() {
  open = null;
  listeners.forEach((l) => l());
}

export function useViewer() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}
