import { useSyncExternalStore } from 'react';

/**
 * «Telegram» bo'limi: ovozli xabar, dumaloq video va audio pleeri (Telegram kabi).
 * - Bir vaqtda bitta narsa o'ynaydi; yangisi boshlansa eskisi to'xtaydi.
 * - Ovozli/dumaloq xabar tugasa — shu chatdagi keyingisi o'zi boshlanadi (audio — keyingi audio).
 * - Tezlik (1x / 1.5x / 2x) hamma ovozli xabarlar uchun bitta, brauzerda eslab qolinadi.
 * - Chat tepasidagi pleer paneli shu holatni ko'rsatadi.
 */

export type TrackKind = 'VOICE' | 'AUDIO' | 'VIDEO_NOTE';

export interface Track {
  key: string;
  peerId: string;
  msgId: number;
  kind: TrackKind;
  title: string;
  date: number;
  el: HTMLMediaElement;
}

interface Starter {
  peerId: string;
  msgId: number;
  kind: TrackKind;
  start: () => void;
}

const RATES = [1, 1.5, 2];
let rate = (() => {
  try {
    const v = Number(localStorage.getItem('tg-voice-rate'));
    return RATES.includes(v) ? v : 1;
  } catch {
    return 1;
  }
})();

let cur: Track | null = null;
let version = 0;
const listeners = new Set<() => void>();
const starters = new Map<string, Starter>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export const trackKey = (peerId: string, msgId: number) => `${peerId}:${msgId}`;

/** Xabar komponenti ko'rinib turganda: navbatdagi sifatida boshlash mumkin bo'lsin */
export function registerStarter(key: string, s: Starter) {
  starters.set(key, s);
  return () => {
    if (starters.get(key) === s) starters.delete(key);
  };
}

export function trackPlaying(t: Track) {
  if (cur && cur.el !== t.el) cur.el.pause();
  cur = t;
  // Musiqa tezligi o'zgarmaydi (Telegram ham faqat ovozli va dumaloq xabarda)
  t.el.playbackRate = t.kind === 'AUDIO' ? 1 : rate;
  emit();
}

/** play/pause hodisasi: panel tugmasi yangilansin */
export function trackChanged() {
  emit();
}

const sameGroup = (a: TrackKind, b: TrackKind) => (a === 'AUDIO') === (b === 'AUDIO');

/** ended — oxirigacha eshitildi: keyingisi boshlanadi */
export function trackStopped(el: HTMLMediaElement, ended: boolean) {
  if (cur?.el !== el) return;
  const prev = cur;
  cur = null;
  emit();
  if (!ended) return;
  const next = [...starters.values()]
    .filter((s) => s.peerId === prev.peerId && s.msgId > prev.msgId && sameGroup(s.kind, prev.kind))
    .sort((a, b) => a.msgId - b.msgId)[0];
  next?.start();
}

/** Video ko'ruvchida o'ynay boshlasa — ovozli xabar to'xtaydi (Telegram kabi) */
export function pauseTrack() {
  cur?.el.pause();
}

export function closeTrack() {
  if (!cur) return;
  const el = cur.el;
  cur = null;
  el.pause();
  el.currentTime = 0;
  emit();
}

export function cycleRate() {
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  try {
    localStorage.setItem('tg-voice-rate', String(rate));
  } catch {
    /* ignore */
  }
  if (cur && cur.kind !== 'AUDIO') cur.el.playbackRate = rate;
  emit();
}

export function useTgPlayer() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return { track: cur, rate, paused: cur ? cur.el.paused : true };
}
