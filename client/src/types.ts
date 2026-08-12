export type Locale = 'zh' | 'en';

export type ViewName = 'workspace' | 'history' | 'vip';

export interface User {
  id: string;
  email: string;
  name: string;
  plan: 'free' | 'vip';
  vipExpiresAt?: string | null;
  locale?: Locale;
}

export interface Usage {
  used: number;
  limit: number | null;
  remaining: number | null;
  isVip: boolean;
  plan: 'free' | 'vip';
  resetAt?: string;
}

export interface DownloadOption {
  id: string;
  label: string;
  type: 'video' | 'audio' | 'image' | 'unknown';
  ext?: string;
  quality?: string;
  size?: string | null;
  url?: string;
  downloadUrl?: string;
}

export interface ParseJob {
  id: string;
  sourceUrl: string;
  canonicalUrl?: string;
  platform: string;
  platformLabel?: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  title?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
  createdAt: string;
  completedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  options?: DownloadOption[];
}

export interface ApiHealth {
  ok: boolean;
  database: 'ok' | 'unavailable' | 'not_configured';
  parser?: { mode: string; available: boolean; binary?: string | null };
}
