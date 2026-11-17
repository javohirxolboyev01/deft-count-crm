import type { Request, Response } from 'express';
import { userFromToken } from '../common/auth';

// Qaror: real vaqt uchun SSE (bir tomonlama oqim yetarli, WebSocket shart emas).
// Ilova bitta instansiyada ishlaydi (~10 xodim), shuning uchun ulanishlar xotirada saqlanadi.
// Bir nechta instansiya bo'lsa: PostgreSQL LISTEN/NOTIFY orqali tarqatish kerak bo'ladi.
const connections = new Map<number, Set<Response>>();

export async function sseHandler(req: Request, res: Response) {
  // EventSource sarlavha yubora olmaydi: access token query'da (qisqa muddatli)
  const user = await userFromToken(String(req.query.token ?? ''));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: {}\n\n`);
  let set = connections.get(user.id);
  if (!set) connections.set(user.id, (set = new Set()));
  set.add(res);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on('close', () => {
    clearInterval(ping);
    set!.delete(res);
    if (set!.size === 0) connections.delete(user.id);
  });
}

export function emitToUser(userId: number, event: string, data: unknown) {
  const set = connections.get(userId);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

export function emitToUsers(userIds: Iterable<number>, event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of userIds) for (const res of connections.get(id) ?? []) res.write(msg);
}

export function closeAllStreams() {
  for (const set of connections.values()) for (const res of set) res.end();
  connections.clear();
}
