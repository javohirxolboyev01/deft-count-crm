import type { TgDialog, TgFolder } from './types';

/**
 * Telegram jildlari (papkalar) qoidasi — Telegram ilovasidagidek:
 * qo'lda qo'shilgan/qadalgan chat har doim kiradi, chiqarilgani hech qachon; qolganlari turi bo'yicha
 * (kontakt, kontakt emas, guruh, kanal, bot) va «o'qilganlar / ovozsizlar / arxiv kirmasin» filtrlari bilan.
 * Serverdan faqat qoidalar keladi: o'qilmaganlar o'zgarganda ro'yxat qayta so'ralmaydi.
 */
export function inFolder(d: TgDialog, f: TgFolder, keep?: string | null) {
  if (f.exclude.includes(d.peerId)) return false;
  if (f.pinned.includes(d.peerId) || f.include.includes(d.peerId)) return true;
  if (f.excludeArchived && d.archived) return false;
  if (f.excludeMuted && d.muted) return false;
  // «Faqat o'qilmaganlar» jildi: ochiq chat o'qilgan bo'lsa ham ro'yxatdan sakrab ketmasin (Telegram kabi)
  if (f.excludeRead && d.unread === 0 && d.peerId !== keep) return false;
  switch (d.kind) {
    case 'USER':
      return d.contact ? f.contacts : f.nonContacts;
    case 'BOT':
      return f.bots;
    case 'GROUP':
      return f.groups;
    case 'CHANNEL':
      return f.broadcasts;
  }
}

/** Jild ichidagi tartib: jildda qadalganlar (o'z tartibida) tepada, keyin oxirgi xabar vaqti bo'yicha */
export function folderDialogs(dialogs: TgDialog[], f: TgFolder, keep?: string | null) {
  const pin = new Map(f.pinned.map((id, i) => [id, i]));
  return dialogs
    .filter((d) => inFolder(d, f, keep))
    .map((d) => ({ ...d, pinned: pin.has(d.peerId) }))
    .sort((a, b) => {
      const pa = pin.get(a.peerId);
      const pb = pin.get(b.peerId);
      if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity);
      return b.date - a.date;
    });
}

/** Jild belgisidagi son — Telegram'dagidek o'qilmagan chatlar soni; hammasi ovozsiz bo'lsa kulrang */
export function folderBadge(list: TgDialog[]) {
  let n = 0;
  let loud = 0;
  for (const d of list) {
    if (d.unread <= 0) continue;
    n++;
    if (!d.muted) loud++;
  }
  return { n, muted: n > 0 && loud === 0 };
}
