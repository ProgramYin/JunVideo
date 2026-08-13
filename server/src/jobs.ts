import { AppError } from "./errors.js";
import { isSafeRemoteHttpUrl } from "./platform.js";
import type { MediaFormat, ParseResult } from "./parser.js";

export type ParseJobStatus = "processing" | "succeeded" | "failed" | "rejected";

export interface ParseJobRow {
  id: string;
  user_id: string;
  source_url: string;
  canonical_url: string;
  platform: string;
  status: ParseJobStatus;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  uploader: string | null;
  duration_seconds: number | null;
  video_formats: unknown;
  audio_formats: unknown;
  metadata: unknown;
  error_code: string | null;
  error_message: string | null;
  error_action: string | null;
  accepted_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

export interface ParseJobView {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  platform: string;
  status: ParseJobStatus;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  uploader: string | null;
  durationSeconds: number | null;
  videoFormats: MediaFormat[];
  audioFormats: MediaFormat[];
  imageFormats: MediaFormat[];
  subtitleFormats: MediaFormat[];
  metadata: Record<string, unknown>;
  error: { code: string; message: string; action?: string } | null;
  acceptedAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function arrayValue<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function withoutInlineSubtitleData(format: MediaFormat): MediaFormat {
  if (format.inlineData === undefined) return format;
  const { inlineData: _inlineData, ...publicFormat } = format;
  return publicFormat;
}

export function toParseJobView(row: ParseJobRow): ParseJobView {
  const storedMetadata = objectValue(row.metadata);
  const metadata: Record<string, unknown> = {
    ...storedMetadata,
    ...(Array.isArray(storedMetadata.subtitleFormats) ? {
      subtitleFormats: arrayValue<MediaFormat>(storedMetadata.subtitleFormats).map(withoutInlineSubtitleData),
    } : {}),
    ...(Array.isArray(storedMetadata.allSubtitleFormats) ? {
      allSubtitleFormats: arrayValue<MediaFormat>(storedMetadata.allSubtitleFormats).map(withoutInlineSubtitleData),
    } : {}),
  };
  const error = row.error_code && row.error_message
    ? {
        code: row.error_code,
        message: row.error_message,
        ...(row.error_action ? { action: row.error_action } : {}),
      }
    : null;

  return {
    id: row.id,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    platform: row.platform,
    status: row.status,
    title: row.title,
    description: row.description,
    thumbnailUrl: row.thumbnail_url,
    uploader: row.uploader,
    durationSeconds: row.duration_seconds,
    videoFormats: arrayValue<MediaFormat>(row.video_formats),
    audioFormats: arrayValue<MediaFormat>(row.audio_formats),
    imageFormats: arrayValue<MediaFormat>(metadata.imageFormats),
    subtitleFormats: arrayValue<MediaFormat>(metadata.subtitleFormats),
    metadata,
    error,
    acceptedAt: iso(row.accepted_at) as string,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    completedAt: iso(row.completed_at),
  };
}

export function formatExtension(format: MediaFormat, fallback: string): string {
  const ext = format.ext?.replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase();
  return ext || fallback;
}

export function safeDownloadFilename(title: string | null, kind: "video" | "audio" | "image" | "subtitle", format: MediaFormat): string {
  const fallback = `junvideo-${kind}`;
  const cleaned = (title ?? fallback)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 150);
  const imageSuffix = kind === "image" && format.id !== "thumbnail"
    ? `-${format.id.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 40)}`
    : "";
  const base = `${cleaned || fallback}${imageSuffix}`;
  return `${base}.${formatExtension(format, kind === "video" ? "mp4" : kind === "audio" ? "m4a" : kind === "subtitle" ? "vtt" : "jpg")}`;
}

function thumbnailFormat(row: ParseJobRow): MediaFormat {
  const thumbnailUrl = row.thumbnail_url;
  if (!thumbnailUrl || !isSafeRemoteHttpUrl(thumbnailUrl)) {
    throw new AppError(404, "THUMBNAIL_NOT_FOUND", "This parse result does not contain a safe cover image.");
  }

  let ext = "jpg";
  try {
    const pathname = new URL(thumbnailUrl).pathname;
    const match = pathname.match(/\.([a-z\d]{2,5})$/i);
    if (match && /^(avif|gif|jpeg|jpg|png|webp)$/i.test(match[1])) ext = match[1].toLowerCase();
  } catch {
    // The safety check above already rejected malformed URLs.
  }

  const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return {
    id: "thumbnail",
    url: thumbnailUrl,
    ext,
    mimeType,
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    filesize: null,
    qualityLabel: "cover",
    videoCodec: null,
    audioCodec: null,
    hasVideo: false,
    hasAudio: false,
    requiresMuxing: false,
    httpHeaders: {},
  };
}

export function selectMediaFormat(
  row: ParseJobRow,
  kind: "video" | "audio" | "image" | "subtitle",
  requestedId?: string,
): MediaFormat {
  if (kind === "image") {
    const images = arrayValue<MediaFormat>(objectValue(row.metadata).imageFormats);
    const format = requestedId === "thumbnail"
      ? images[0] ?? thumbnailFormat(row)
      : requestedId
        ? images.find((candidate) => candidate.id === requestedId)
        : images[0] ?? thumbnailFormat(row);
    if (!format) throw new AppError(404, "FORMAT_NOT_FOUND", "No image format is available for this parse job.");
    if (!isSafeRemoteHttpUrl(format.url)) {
      throw new AppError(502, "UNSAFE_MEDIA_URL", "The parser returned a media URL that cannot be proxied safely.", {
        action: "Run the parse again or choose another format.",
      });
    }
    return format;
  }
  const formats = kind === "subtitle"
    ? [...arrayValue<MediaFormat>(objectValue(row.metadata).allSubtitleFormats)]
    : [...arrayValue<MediaFormat>(kind === "video" ? row.video_formats : row.audio_formats)];
  if (kind === "video") {
    const remembered = arrayValue<MediaFormat>(objectValue(row.metadata).allVideoFormats);
    const displayedIds = new Set(formats.map((format) => format.id));
    formats.push(...remembered.filter((format) => !displayedIds.has(format.id)));
  }
  const format = requestedId ? formats.find((candidate) => candidate.id === requestedId) : formats[0];
  if (!format) {
    throw new AppError(404, "FORMAT_NOT_FOUND", `No ${kind} format is available for this parse job.`);
  }
  if (!isSafeRemoteHttpUrl(format.url)) {
    throw new AppError(502, "UNSAFE_MEDIA_URL", "The parser returned a media URL that cannot be proxied safely.", {
      action: "Run the parse again or choose another format.",
    });
  }
  return format;
}

/**
 * Returns every persisted text-track candidate, including alternative file
 * representations that are intentionally hidden from the compact UI list.
 * Older rows may only contain subtitleFormats, so keep that as a migration-free
 * fallback. The extractor performs final format support/ranking checks.
 */
export function subtitleFormatsForExtraction(row: ParseJobRow): MediaFormat[] {
  const metadata = objectValue(row.metadata);
  const remembered = arrayValue<MediaFormat>(metadata.allSubtitleFormats);
  const displayed = arrayValue<MediaFormat>(metadata.subtitleFormats);
  const source = remembered.length > 0 ? remembered : displayed;
  const seen = new Set<string>();
  return source.filter((format) => {
    if (!format || format.mediaType !== "subtitle" || !format.id || !format.language) return false;
    if (!isSafeRemoteHttpUrl(format.url) || seen.has(format.id)) return false;
    seen.add(format.id);
    return true;
  });
}

/** Includes remembered non-displayed video formats for embedded-text probing. */
export function videoFormatsForTextInspection(row: ParseJobRow): MediaFormat[] {
  const displayed = arrayValue<MediaFormat>(row.video_formats);
  const remembered = arrayValue<MediaFormat>(objectValue(row.metadata).allVideoFormats);
  const seen = new Set<string>();
  return [...displayed, ...remembered].filter((format) => {
    if (!format || !format.id || !format.hasVideo || seen.has(format.id)) return false;
    if (!isSafeRemoteHttpUrl(format.url)) return false;
    seen.add(format.id);
    return true;
  });
}

export function parseResultToColumns(result: ParseResult): {
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  uploader: string | null;
  durationSeconds: number | null;
  videoFormats: MediaFormat[];
  audioFormats: MediaFormat[];
  metadata: Record<string, unknown>;
} {
  return {
    title: result.title,
    description: result.description,
    thumbnailUrl: result.thumbnailUrl,
    uploader: result.uploader,
    durationSeconds: result.durationSeconds,
    videoFormats: result.videoFormats,
    audioFormats: result.audioFormats,
    metadata: {
      ...result.metadata,
      // Keep inline payloads only in the full server-side inventory. The
      // compact display list is returned frequently and must stay lightweight.
      subtitleFormats: result.subtitleFormats.map(withoutInlineSubtitleData),
      allSubtitleFormats: result.metadata.allSubtitleFormats ?? result.subtitleFormats,
      imageFormats: result.imageFormats,
      mock: result.mock,
    },
  };
}
