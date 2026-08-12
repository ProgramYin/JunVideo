import type { ApiHealth, Locale, ParseJob, Usage, User } from './types';

const API_BASE = '/api';
const TOKEN_KEY = 'junvideo_token';

type ApiEnvelope<T> = T | { data: T } | { user: User; token: string } | { job: ParseJob };

export class ApiError extends Error {
  status: number;
  code?: string;
  payload?: unknown;

  constructor(message: string, status = 0, code?: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function unwrap<T>(payload: ApiEnvelope<T>): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export function getToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('无法连接到 JunVideo 服务，请确认 API 已启动。');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const apiError = payload?.error;
    const message = typeof apiError === 'object' && apiError !== null
      ? apiError.message
      : payload?.message ?? (typeof apiError === 'string' ? apiError : `请求失败（${response.status}）`);
    const code = typeof apiError === 'object' && apiError !== null ? apiError.code : payload?.code;
    throw new ApiError(String(message), response.status, code, payload);
  }
  return unwrap<T>(payload as ApiEnvelope<T>);
}

function normalizeUser(payload: unknown): User {
  const value = ((payload as { user?: Record<string, unknown> })?.user ?? payload) as Record<string, unknown>;
  const email = String(value.email ?? '');
  const isVip = Boolean(value.isVip ?? value.is_vip ?? value.plan === 'vip');
  return {
    id: String(value.id ?? ''),
    email,
    name: String(value.name ?? (email.includes('@') ? email.split('@')[0] : 'JunVideo')),
    plan: isVip ? 'vip' : 'free',
    vipExpiresAt: isVip ? String(value.vipExpiresAt ?? '2999-12-31T23:59:59.000Z') : null,
    locale: value.locale === 'en' ? 'en' : 'zh',
  };
}

function normalizeStatus(value: unknown): ParseJob['status'] {
  if (value === 'succeeded' || value === 'completed') return 'completed';
  if (value === 'failed' || value === 'rejected') return 'failed';
  if (value === 'queued') return 'queued';
  return 'processing';
}

function normalizeJob(payload: unknown): ParseJob {
  const raw = ((payload as { job?: Record<string, unknown> })?.job ?? payload) as Record<string, unknown>;
  const videoFormats = Array.isArray(raw.videoFormats) ? raw.videoFormats : [];
  const audioFormats = Array.isArray(raw.audioFormats) ? raw.audioFormats : [];
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? raw.metadata as Record<string, unknown>
    : {};
  const thumbnailUrl = raw.thumbnailUrl == null && raw.thumbnail_url == null
    ? null
    : String(raw.thumbnailUrl ?? raw.thumbnail_url);
  const toOption = (format: Record<string, unknown>, type: 'video' | 'audio') => ({
    id: String(format.id ?? `${type}-${Math.random().toString(36).slice(2)}`),
    label: String(format.qualityLabel ?? (typeof format.height === 'number' && format.height > 0 ? `${format.height}p` : type === 'video' ? 'Video' : 'Audio')),
    type,
    ext: format.ext ? String(format.ext) : undefined,
    quality: format.qualityLabel
      ? String(format.qualityLabel)
      : typeof format.height === 'number' && format.height > 0
        ? `${format.height}p`
        : typeof format.bitrateKbps === 'number' && format.bitrateKbps > 0
          ? `${Math.round(format.bitrateKbps)} kbps`
          : undefined,
    size: format.filesize ? String(format.filesize) : null,
    url: format.url ? String(format.url) : undefined,
  });
  const error = raw.error as Record<string, unknown> | null | undefined;
  return {
    id: String(raw.id ?? ''),
    sourceUrl: String(raw.sourceUrl ?? raw.source_url ?? ''),
    canonicalUrl: raw.canonicalUrl ? String(raw.canonicalUrl) : undefined,
    platform: String(raw.platform ?? 'other'),
    platformLabel: raw.platformLabel ? String(raw.platformLabel) : undefined,
    status: normalizeStatus(raw.status),
    title: raw.title == null ? null : String(raw.title),
    author: raw.uploader == null ? null : String(raw.uploader),
    thumbnailUrl,
    durationSeconds: typeof raw.durationSeconds === 'number' ? raw.durationSeconds : null,
    createdAt: String(raw.createdAt ?? raw.acceptedAt ?? new Date().toISOString()),
    completedAt: raw.completedAt ? String(raw.completedAt) : null,
    errorCode: error?.code ? String(error.code) : raw.errorCode ? String(raw.errorCode) : null,
    errorMessage: error?.message ? String(error.message) : raw.errorMessage ? String(raw.errorMessage) : null,
    metadata,
    options: [
      ...videoFormats.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')).map((value) => toOption(value, 'video')),
      ...audioFormats.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')).map((value) => toOption(value, 'audio')),
      ...(thumbnailUrl ? [{
        id: 'thumbnail',
        label: 'Cover image',
        type: 'image' as const,
        ext: 'jpg',
        quality: 'cover',
        size: null,
        url: thumbnailUrl,
      }] : []),
    ],
  };
}

export async function register(input: { name: string; email: string; password: string }) {
  const payload = await request<{ user: User; token: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setToken(payload.token);
  return { user: normalizeUser(payload), token: payload.token };
}

export async function login(input: { email: string; password: string }) {
  const payload = await request<{ user: User; token: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setToken(payload.token);
  return { user: normalizeUser(payload), token: payload.token };
}

export async function me() {
  const payload = await request<{ user: User }>('/auth/me');
  return normalizeUser(payload);
}

export async function usage() {
  const payload = await request<Usage>('/usage');
  return ((payload as unknown as { usage?: Usage }).usage ?? payload) as Usage;
}

export async function parseUrl(url: string) {
  try {
    const payload = await request<ParseJob | { job: ParseJob }>('/parse', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    return normalizeJob(payload);
  } catch (error) {
    if (error instanceof ApiError && error.payload && typeof error.payload === 'object' && 'job' in error.payload) {
      return normalizeJob(error.payload);
    }
    throw error;
  }
}

export async function history() {
  const payload = await request<ParseJob[] | { items: ParseJob[]; jobs?: ParseJob[] }>('/history?limit=20');
  const items = (payload as { items?: ParseJob[]; jobs?: ParseJob[] }).items ?? (payload as { jobs?: ParseJob[] }).jobs ?? payload;
  return (items as ParseJob[]).map(normalizeJob);
}

export async function activateVip() {
  const payload = await request<{ user: User }>('/dev/vip/activate', {
    method: 'POST',
    body: JSON.stringify({ plan: 'monthly' }),
  });
  return normalizeUser(payload);
}

export async function health() {
  const payload = await request<Record<string, unknown>>('/health');
  const database = payload.database as Record<string, unknown> | undefined;
  const parser = payload.parser as Record<string, unknown> | undefined;
  return {
    ok: payload.ok === true || payload.status === 'ok',
    database: database?.status === 'up' ? 'ok' : database ? 'unavailable' : 'not_configured',
    parser: parser ? {
      mode: String(parser.mode ?? 'unknown'),
      available: Boolean(parser.available),
      binary: parser.message ? String(parser.message) : null,
    } : undefined,
  } satisfies ApiHealth;
}

export function downloadUrl(job: ParseJob, optionId: string) {
  const option = job.options?.find((item) => item.id === optionId);
  const kind = option?.type === 'audio' ? 'audio' : option?.type === 'image' ? 'image' : 'video';
  return `${API_BASE}/proxy/${encodeURIComponent(job.id)}/${kind}?formatId=${encodeURIComponent(optionId)}`;
}

export async function downloadMedia(job: ParseJob, optionId: string) {
  const token = getToken();
  const response = await fetch(downloadUrl(job, optionId), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const apiError = payload?.error;
    const message = typeof apiError === 'object' && apiError !== null
      ? apiError.message
      : payload?.message ?? '下载流暂时不可用，请重新解析后重试。';
    throw new ApiError(String(message), response.status, apiError?.code, payload);
  }
  const contentDisposition = response.headers.get('content-disposition') ?? '';
  const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
  const quotedName = /filename="([^"]+)"/i.exec(contentDisposition)?.[1];
  const filename = encodedName ? decodeURIComponent(encodedName) : quotedName ?? undefined;
  return { blob: await response.blob(), filename };
}

export async function saveLocale(locale: Locale) {
  window.localStorage.setItem('junvideo_locale', locale);
}
