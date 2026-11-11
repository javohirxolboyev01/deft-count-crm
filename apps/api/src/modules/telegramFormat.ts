/**
 * Telegram xabarlari HTML formatda (parse_mode: 'HTML'). Qaror: Markdown emas, HTML — ekranlash faqat 3 belgi
 * (& < >), mijoz nomlaridagi `_`, `*`, `.` va h.k. xabarni buzmaydi. Har bir dinamik qiymat `esc` orqali o'tadi,
 * aks holda Telegram 400 qaytaradi va bildirishnoma yetkazilmaydi.
 */
export const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const b = (v: unknown) => `<b>${esc(v)}</b>`;
export const i = (v: unknown) => `<i>${esc(v)}</i>`;
export const code = (v: unknown) => `<code>${esc(v)}</code>`;
export const link = (url: string, text: string) => `<a href="${esc(url)}">${esc(text)}</a>`;

export interface PostRow {
  icon: string;
  label: string;
  value: unknown;
  /** Qiymat qalin (muddat kabi muhim maydon) */
  strong?: boolean;
}

/**
 * Bir xil "post" ko'rinishi:
 *   🚨 SARLAVHA
 *   Vazifa nomi (qalin)
 *
 *   🏢 Mijoz: …
 *   ⏰ Muddat: …
 *   ┃ iqtibos (sabab / izoh)
 *   kursiv izoh (keyingi qadam)
 * `quote` va `footer` — tayyor HTML emas, oddiy matn (ekranlanadi). `extra` — tayyor HTML (ro'yxat, havola).
 */
export function post(p: {
  icon: string;
  title: string;
  subject?: unknown;
  rows?: (PostRow | null | false | undefined)[];
  quote?: string | null;
  extra?: string | null;
  footer?: string | null;
}) {
  const parts: string[] = [`${p.icon} ${b(p.title)}`];
  if (p.subject != null && p.subject !== '') parts[0] += `\n${b(p.subject)}`;
  const rows = (p.rows ?? []).filter((r): r is PostRow => !!r);
  if (rows.length) {
    parts.push(rows.map((r) => `${r.icon} ${esc(r.label)}: ${r.strong ? b(r.value) : esc(r.value)}`).join('\n'));
  }
  if (p.quote) parts.push(`<blockquote>${esc(p.quote)}</blockquote>`);
  if (p.extra) parts.push(p.extra);
  if (p.footer) parts.push(i(p.footer));
  return parts.join('\n\n');
}
