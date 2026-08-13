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
  type: 'video' | 'audio' | 'image' | 'subtitle' | 'unknown';
  /** One-based position within an image-note gallery. */
  imageIndex?: number;
  ext?: string;
  quality?: string;
  size?: string | null;
  language?: string;
  automatic?: boolean;
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
  description?: string | null;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
  createdAt: string;
  completedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  options?: DownloadOption[];
  /** Full text-track inventory; download options remain intentionally compact. */
  textTracks?: DownloadOption[];
}

export interface SubtitleTextCue {
  startMs: number;
  endMs: number | null;
  text: string;
}

export interface ExtractedTextResult {
  text: string;
  language: string;
  source: 'manual-subtitle' | 'automatic-caption' | 'embedded-subtitle' | string;
  cueCount: number;
  trackId?: string;
  format?: string;
  segments?: SubtitleTextCue[];
  timestampedText?: string;
  /** Optional compatibility fields for responses during a rolling deployment. */
  rawText?: string;
  correctedText?: string;
}

export interface ApiHealth {
  ok: boolean;
  database: 'ok' | 'unavailable' | 'not_configured';
  parser?: {
    mode: string;
    available: boolean;
    binary?: string | null;
    version?: string | null;
    extractorCount?: number | null;
  };
  features?: {
    textExtraction: boolean;
    transcription?: boolean;
    devVip: boolean;
    subtitles: boolean;
  };
}
