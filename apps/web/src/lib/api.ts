// Fetch o'ramasi: access token xotirada (XSS'da localStorage'dan o'g'irlanmasin),
// refresh token httpOnly cookie'da. 401 bo'lsa bir marta /auth/refresh qilib qayta uriniladi.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;
export const setOnAuthLost = (fn: () => void) => {
  onAuthLost = fn;
};

let refreshPromise: Promise<any | null> | null = null;

async function doRefresh(attempt = 0): Promise<any | null> {
  const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (r.ok) {
    const data = await r.json();
    accessToken = data.accessToken;
    return data;
  }
  const err = await r.json().catch(() => ({}));
  // Boshqa tab tokenni hozirgina aylantirgan: yangi cookie bilan bir marta qayta urinamiz
  if (err.code === 'REFRESH_RACE' && attempt === 0) {
    await new Promise((res) => setTimeout(res, 300));
    return doRefresh(1);
  }
  accessToken = null;
  return null;
}

/** Bir vaqtda faqat bitta refresh so'rovi (parallel so'rovlar bitta natijani kutadi) */
export function refreshAccess(): Promise<any | null> {
  if (!refreshPromise) refreshPromise = doRefresh().finally(() => (refreshPromise = null));
  return refreshPromise;
}

async function tryRefresh() {
  return !!(await refreshAccess());
}

type Body = BodyInit | Record<string, unknown> | unknown[] | undefined;

async function request<T>(method: string, url: string, body?: Body, retry = true): Promise<T> {
  const isForm = body instanceof FormData;
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const r = await fetch(`/api${url}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (r.status === 401 && retry && !url.startsWith('/auth/')) {
    if (await tryRefresh()) return request<T>(method, url, body, false);
    onAuthLost?.();
  }
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.code ?? 'HTTP_' + r.status, data.message ?? r.statusText, data.details);
  return data as T;
}

/** Faylni yuklab olish (Authorization sarlavhasi kerak, shuning uchun oddiy <a href> emas) */
async function download(url: string, filename: string, retry = true): Promise<void> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const r = await fetch(`/api${url}`, { headers, credentials: 'same-origin' });
  if (r.status === 401 && retry) {
    if (await tryRefresh()) return download(url, filename, false);
    onAuthLost?.();
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new ApiError(r.status, data.code ?? 'HTTP_' + r.status, data.message ?? r.statusText, data.details);
  }
  const href = URL.createObjectURL(await r.blob());
  Object.assign(document.createElement('a'), { href, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Fayl mazmuni Blob sifatida (Authorization kerak — <img src> to'g'ridan-to'g'ri ishlamaydi) */
async function blob(url: string, retry = true): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const r = await fetch(`/api${url}`, { headers, credentials: 'same-origin' });
  if (r.status === 401 && retry) {
    if (await tryRefresh()) return blob(url, false);
    onAuthLost?.();
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new ApiError(r.status, data.code ?? 'HTTP_' + r.status, data.message ?? r.statusText, data.details);
  }
  return r.blob();
}

export const api = {
  download,
  blob,
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: Body) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body?: Body) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: Body) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

/** Query string yig'ish (bo'sh qiymatlar tashlab ketiladi) */
export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
