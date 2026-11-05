import { useCallback, useEffect, useState } from 'react';

/**
 * Kompyuter (OS) bildirishnomasi — brauzerning Notification API'si.
 * Qaror: Web Push (service worker + VAPID) emas, oddiy Notification: CRM brauzerda ochiq tursa (boshqa oyna yoki
 * dastur ustida bo'lsa ham) xabar ekranning burchagida chiqadi. Brauzer butunlay yopiq bo'lsa — Telegram bor.
 */
export type DesktopPermission = NotificationPermission | 'unsupported';

const supported = () => typeof window !== 'undefined' && 'Notification' in window;

export function desktopPermission(): DesktopPermission {
  return supported() ? Notification.permission : 'unsupported';
}

export function useDesktopPermission() {
  const [perm, setPerm] = useState<DesktopPermission>(desktopPermission);
  // Foydalanuvchi brauzer sozlamasidan o'zgartirsa, oynaga qaytganda yangilanadi
  useEffect(() => {
    const sync = () => setPerm(desktopPermission());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);
  const request = useCallback(async () => {
    if (!supported()) return;
    try {
      setPerm(await Notification.requestPermission());
    } catch {
      setPerm(desktopPermission());
    }
  }, []);
  return { perm, request };
}

/**
 * Xabarni ko'rsatadi. sticky: foydalanuvchi o'zi yopmaguncha turadi (shoshilinch vazifa).
 * Bosilganda CRM oynasi oldinga chiqadi va onClick chaqiriladi.
 */
export function showDesktopNotification(opts: { title: string; body: string; tag: string; sticky?: boolean; onClick?: () => void }) {
  if (desktopPermission() !== 'granted') return false;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: '/favicon.svg',
      requireInteraction: !!opts.sticky,
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
    return true;
  } catch {
    // Ba'zi mobil brauzerlar faqat service worker orqali ruxsat beradi
    return false;
  }
}
