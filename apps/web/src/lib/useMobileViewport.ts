import { useEffect, useState } from 'react';

/** Telefon (md'dan tor) ekran */
const MQ = '(max-width: 767.98px)';

export function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(MQ).matches);
  useEffect(() => {
    const q = window.matchMedia(MQ);
    const on = () => setM(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return m;
}

/**
 * Ko'rinadigan maydon (visualViewport): klaviatura ochilganda balandlik kamayadi, iOS sahifani surganda offsetTop o'zgaradi.
 * To'liq ekranli (fixed) oynani shu maydonga qo'yish uchun: yozish maydoni to'g'ridan-to'g'ri klaviatura ustida turadi
 * (Telegram ilovasidagidek), sarlavha esa tepada qoladi.
 */
export function useVisualViewport(enabled: boolean) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setBox(null);
      return;
    }
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBox({ top: Math.max(0, vv.offsetTop), height: vv.height }));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return box;
}
