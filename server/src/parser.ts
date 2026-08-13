import { config, type AppConfig } from "./config.js";
import { extractDouyinInfoWithBrowser } from "./douyin-browser.js";
import { extractXhsInfoWithDownloader } from "./xhs-downloader.js";
import {
  ParserFailedError,
  ParserUnavailableError,
  SourceRestrictedError,
} from "./errors.js";
import {
  isSafeRemoteHttpUrl,
  normalizeAndValidateUrl,
  type PlatformInfo,
  type UrlPreflight,
} from "./platform.js";
import { runProcess, type ProcessResult } from "./process.js";

export interface MediaFormat {
  id: string;
  url: string;
  ext: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  filesize: number | null;
  qualityLabel: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  requiresMuxing: boolean;
  /**
   * Some fallback adapters return a fresh direct URL but do not expose a
   * source URL that yt-dlp can resolve again. Those formats must be proxied
   * directly instead of being sent through the yt-dlp download path.
   */
  downloadMode?: "yt-dlp" | "direct";
  /**
   * When yt-dlp exposes separate DASH video/audio streams, this points to the
   * audio format that should be merged when the user downloads the video.
   * Keeping the format id (instead of another expiring URL) lets the download
   * request ask yt-dlp for a fresh signed URL.
   */
  audioFormatId?: string | null;
  /** Distinguishes downloadable captions from ordinary A/V streams. */
  mediaType?: "video" | "audio" | "image" | "subtitle";
  /** yt-dlp subtitle language key, retained for a fresh subtitle download. */
  language?: string | null;
  /** True when the subtitle track came from automatic_captions. */
  automatic?: boolean;
  /** Inline subtitle payload used by extractors that return data instead of a URL. */
  inlineData?: string;
  httpHeaders: Record<string, string>;
}

export interface ParseResult {
  sourceUrl: string;
  canonicalUrl: string;
  platform: PlatformInfo;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  uploader: string | null;
  durationSeconds: number | null;
  videoFormats: MediaFormat[];
  audioFormats: MediaFormat[];
  imageFormats: MediaFormat[];
  subtitleFormats: MediaFormat[];
  metadata: Record<string, unknown>;
  mock: boolean;
}

export interface ParseRequest {
  sourceUrl: string;
  canonicalUrl: string;
  platform: PlatformInfo;
}

export interface ParserAvailability {
  adapter: string;
  mode: AppConfig["parserMode"];
  available: boolean;
  message: string;
  version?: string;
  extractorCount?: number;
}

export interface ParserAdapter {
  readonly name: string;
  available(): Promise<{ available: boolean; message: string }>;
  parse(request: ParseRequest): Promise<ParseResult>;
}

const AVAILABILITY_CACHE_MS = 15_000;

export function buildYtDlpArgs(
  normalizedUrl: string,
  appConfig: Pick<AppConfig, "ytdlpCookiesFile" | "ytdlpCookiesFromBrowser" | "ytdlpRetries" | "ytdlpExtractorRetries" | "ytdlpFragmentRetries" | "ytdlpSocketTimeoutMs">,
): string[] {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--retries", String(appConfig.ytdlpRetries),
    "--extractor-retries", String(appConfig.ytdlpExtractorRetries),
    "--fragment-retries", String(appConfig.ytdlpFragmentRetries),
    "--socket-timeout", String(Math.ceil(appConfig.ytdlpSocketTimeoutMs / 1_000)),
  ];
  if (appConfig.ytdlpCookiesFile) args.push("--cookies", appConfig.ytdlpCookiesFile);
  if (appConfig.ytdlpCookiesFromBrowser) args.push("--cookies-from-browser", appConfig.ytdlpCookiesFromBrowser);
  args.push("--ignore-no-formats-error", "--dump-single-json", "--skip-download", "--", normalizedUrl);
  return args;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("yt-dlp returned empty metadata output.");
  // Keep parsing resilient to an executable wrapper that writes a short
  // diagnostic before the JSON document. yt-dlp itself writes diagnostics to
  // stderr, but this costs nothing and prevents false parse failures.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  return JSON.parse(candidate) as unknown;
}

function processErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function restrictedSource(stderr: string): boolean {
  const diagnostic = stderr.toLowerCase();
  return [
    "login required",
    "sign in",
    "private video",
    "members-only",
    "members only",
    "age-restricted",
    "paywall",
    "drm",
    "protected content",
    "authentication required",
  ].some((marker) => diagnostic.includes(marker));
}

function requiresFreshCookies(stderr: string): boolean {
  const diagnostic = stderr.toLowerCase();
  return ["fresh cookies", "cookies are needed", "cookies needed", "cookies required"].some((marker) =>
    diagnostic.includes(marker),
  );
}

function xiaohongshuCanonicalUrlFromDiagnostic(stderr: string): string | null {
  const pathMatch = stderr.match(
    /https?:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-z\d]{8,80})(?=[/?#\s)"']|$)/i,
  );
  if (pathMatch?.[1]) return `https://www.xiaohongshu.com/explore/${pathMatch[1]}`;

  const match = stderr.match(/https?:\/\/www\.xiaohongshu\.com\/explore\?[^\s]+/i);
  if (!match) return null;

  try {
    const redirected = new URL(match[0].replace(/[)'\"]+$/g, ""));
    const noteId = redirected.searchParams.get("target_note_id");
    if (!noteId || !/^[a-z\d]{8,80}$/i.test(noteId)) return null;
    return `https://www.xiaohongshu.com/explore/${noteId}`;
  } catch {
    return null;
  }
}

function safeText(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 20_000) : fallback;
}

function normalizeXiaohongshuThumbnailUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol === "http:" && (hostname === "xhscdn.com" || hostname.endsWith(".xhscdn.com"))) {
      parsed.protocol = "https:";
      return parsed.toString();
    }
  } catch {
    // Preserve the extractor value; downstream URL validation still applies.
  }
  return value;
}

function thumbnailUrlFromInfo(info: Record<string, unknown>, request: ParseRequest): string | null {
  const fallback = safeText(info.thumbnail);
  if (request.platform.id !== "xiaohongshu") return fallback;
  if (!Array.isArray(info.thumbnails)) return normalizeXiaohongshuThumbnailUrl(fallback);

  const candidates = info.thumbnails.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const url = safeText(entry.url);
    return url ? [{ id: safeText(entry.id), url }] : [];
  });
  // XHS exposes default and preview variants with identical dimensions, so
  // yt-dlp's synthesized top-level thumbnail can otherwise depend on order.
  const selected = candidates.find((candidate) => /!nd_dft(?:_|$)/iu.test(candidate.url))
    ?? (fallback ? { id: null, url: fallback } : null)
    ?? candidates.find((candidate) => candidate.id === "0")
    ?? candidates[0];

  return normalizeXiaohongshuThumbnailUrl(selected?.url ?? fallback);
}

function xiaohongshuImageIdentity(url: string): string {
  try {
    const basename = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? url;
    return basename.split("!", 1)[0]?.toLowerCase() || url;
  } catch {
    return url;
  }
}

function imageFormatEntries(info: Record<string, unknown>, request: ParseRequest): MediaFormat[] {
  if (request.platform.id !== "xiaohongshu") return [];

  const explicit = Array.isArray(info.image_formats) ? info.image_formats : [];
  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const source = explicit.length > 0
    ? explicit
    : (() => {
        const records = thumbnails.filter((value): value is Record<string, unknown> =>
          Boolean(value && typeof value === "object" && !Array.isArray(value)));
        const defaults = records.filter((entry) => /!nd_dft(?:_|$)/iu.test(safeText(entry.url) ?? ""));
        const selected = defaults.length > 0 ? defaults : records;
        // yt-dlp may reorder XHS thumbnails between requests. The asset key is
        // stable and preserves the gallery sequence when no sidecar is present.
        return [...selected].sort((left, right) => {
          const leftUrl = safeText(left.url) ?? "";
          const rightUrl = safeText(right.url) ?? "";
          const leftIdentity = xiaohongshuImageIdentity(leftUrl);
          const rightIdentity = xiaohongshuImageIdentity(rightUrl);
          return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
        });
      })();

  const seen = new Set<string>();
  const formats: MediaFormat[] = [];
  for (const value of source) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    const rawUrl = safeText(raw.url);
    const url = normalizeXiaohongshuThumbnailUrl(rawUrl);
    if (!url || !isSafeRemoteHttpUrl(url)) continue;
    const identity = xiaohongshuImageIdentity(url);
    if (seen.has(identity)) continue;
    seen.add(identity);

    const index = formats.length + 1;
    const ext = (safeText(raw.ext) ?? "jpg").toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 10) || "jpg";
    formats.push({
      id: (safeText(raw.format_id) ?? `image-${index}`).slice(0, 100),
      url,
      ext,
      mimeType: safeText(raw.mime) ?? safeText(raw.mimetype) ?? (ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`),
      width: safeNumber(raw.width, 1),
      height: safeNumber(raw.height, 1),
      fps: null,
      bitrateKbps: null,
      filesize: safeNumber(raw.filesize, 0) ?? safeNumber(raw.filesize_approx, 0),
      qualityLabel: safeText(raw.format_note) ?? `Image ${index}`,
      videoCodec: null,
      audioCodec: null,
      hasVideo: false,
      hasAudio: false,
      requiresMuxing: false,
      downloadMode: "direct",
      mediaType: "image",
      httpHeaders: safeMediaHeaders(raw.http_headers),
    });
  }
  return formats;
}

function safeNumber(value: unknown, minimum = 0): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum) return null;
  return parsed;
}

const FORWARDED_MEDIA_HEADERS: Record<string, string> = {
  accept: "Accept",
  "accept-language": "Accept-Language",
  origin: "Origin",
  referer: "Referer",
  "user-agent": "User-Agent",
};

function safeMediaHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = FORWARDED_MEDIA_HEADERS[rawName.toLowerCase()];
    if (!name || typeof rawValue !== "string") continue;
    const headerValue = rawValue.replace(/[\r\n]+/gu, " ").trim();
    if (headerValue && headerValue.length <= 2_000) headers[name] = headerValue;
  }
  return headers;
}

function inferredMimeType(ext: string | null, hasVideo: boolean, hasAudio: boolean): string | null {
  const normalizedExt = ext?.toLowerCase();
  if (!normalizedExt) return null;
  if (hasVideo) {
    const videoTypes: Record<string, string> = {
      flv: "video/x-flv",
      mkv: "video/x-matroska",
      mov: "video/quicktime",
      mp4: "video/mp4",
      webm: "video/webm",
    };
    return videoTypes[normalizedExt] ?? null;
  }
  if (hasAudio) {
    const audioTypes: Record<string, string> = {
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      opus: "audio/ogg",
      wav: "audio/wav",
      webm: "audio/webm",
    };
    return audioTypes[normalizedExt] ?? null;
  }
  return null;
}

function mediaFormatFromRaw(raw: Record<string, unknown>, index: number): MediaFormat | null {
  const rawUrl = safeText(raw.url);
  if (!rawUrl || !isSafeRemoteHttpUrl(rawUrl)) return null;

  const videoCodec = safeText(raw.vcodec);
  const audioCodec = safeText(raw.acodec);
  const videoExt = safeText(raw.video_ext);
  const audioExt = safeText(raw.audio_ext);
  const mime = safeText(raw.mime) ?? safeText(raw.mimetype);
  const hasVideo = Boolean(
    (videoCodec && videoCodec !== "none")
      || (!videoCodec && videoExt && videoExt !== "none")
      || (!videoCodec && !videoExt && mime?.toLowerCase().startsWith("video/")),
  );
  const hasAudio = Boolean(
    (audioCodec && audioCodec !== "none")
      || (!audioCodec && audioExt && audioExt !== "none")
      || (!audioCodec && !audioExt && mime?.toLowerCase().startsWith("audio/")),
  );
  if (!hasVideo && !hasAudio) return null;

  const width = safeNumber(raw.width, 1);
  const height = safeNumber(raw.height, 1);
  const fps = safeNumber(raw.fps, 0);
  const bitrate = safeNumber(raw.tbr, 0);
  const audioBitrate = safeNumber(raw.abr, 0);
  const filesize = safeNumber(raw.filesize, 0) ?? safeNumber(raw.filesize_approx, 0);
  const id = safeText(raw.format_id, `format-${index}`) ?? `format-${index}`;
  const ext = safeText(raw.ext);
  const effectiveBitrate = bitrate !== null && bitrate > 0 ? bitrate : audioBitrate;
  const formatNote = safeText(raw.format_note);
  const genericAudioNote = !formatNote || /^(?:browser )?audio(?: stream)?$/i.test(formatNote);
  const fpsLabel = hasVideo && fps !== null && fps > 0
    ? `${Number.isInteger(fps) ? fps : fps.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}fps`
    : null;
  const bitrateLabel = effectiveBitrate !== null && effectiveBitrate > 0
    ? `${Math.round(effectiveBitrate)} kbps`
    : null;
  const qualityLabel = hasVideo
    ? height !== null
      ? [`${height}p`, fpsLabel, bitrateLabel].filter(Boolean).join(" / ")
      : formatNote
    : bitrateLabel
      ? bitrateLabel
      : genericAudioNote
        ? ext
          ? ext.toUpperCase()
          : "Audio"
        : formatNote;

  return {
    id: id.slice(0, 100),
    url: rawUrl,
    ext: ext?.slice(0, 20) ?? null,
    mimeType: mime ?? inferredMimeType(ext, hasVideo, hasAudio),
    width,
    height,
    fps,
    bitrateKbps: effectiveBitrate,
    filesize,
    qualityLabel,
    videoCodec,
    audioCodec,
    hasVideo,
    hasAudio,
    // A direct muxed format is already playable. Separate video/audio formats
    // are re-resolved and merged through yt-dlp/ffmpeg at download time.
    requiresMuxing: hasVideo && !hasAudio,
    mediaType: hasVideo ? "video" : "audio",
    httpHeaders: safeMediaHeaders(raw.http_headers),
  };
}

const SUBTITLE_EXT_PRIORITY = [
  "vtt", "srt", "ass", "ssa", "ttml", "dfxp", "xml",
  "json3", "json", "srv3", "srv2", "srv1", "sbv", "lrc",
] as const;
const DISPLAY_SUBTITLE_LIMIT = 16;
const MAX_INLINE_SUBTITLE_BYTES = 8 * 1024 * 1024;

function subtitleMimeType(ext: string): string {
  if (ext === "vtt") return "text/vtt";
  if (["srt", "ass", "ssa", "sbv", "lrc"].includes(ext)) return "text/plain";
  if (["ttml", "dfxp", "xml"].includes(ext)) return "application/ttml+xml";
  return "application/json";
}

function inlineSubtitleData(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Buffer.byteLength(value, "utf8") <= MAX_INLINE_SUBTITLE_BYTES ? value : null;
}

function subtitleFormatEntries(info: Record<string, unknown>): MediaFormat[] {
  const formats: MediaFormat[] = [];

  const collect = (value: unknown, automatic: boolean): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [rawLanguage, rawTracks] of Object.entries(value as Record<string, unknown>)) {
      const language = rawLanguage.trim().slice(0, 80);
      // yt-dlp exposes non-transcript streams such as YouTube live_chat in the
      // same dictionaries. They must never be presented as spoken video text.
      if (!language
        || /^(?:live[_-]?chat|chat|comments?|danmaku|danmu)$/iu.test(language)
        || !Array.isArray(rawTracks)) continue;
      const candidates = rawTracks
        .filter((track): track is Record<string, unknown> => Boolean(track && typeof track === "object" && !Array.isArray(track)))
        .map((track) => ({
          track,
          url: safeText(track.url),
          inlineData: inlineSubtitleData(track.data),
          ext: (safeText(track.ext, "vtt") ?? "vtt").toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 12) || "vtt",
        }))
        .filter((track) => Boolean(
          (track.url && isSafeRemoteHttpUrl(track.url)) || track.inlineData,
        ))
        .sort((a, b) => {
          const aPriority = SUBTITLE_EXT_PRIORITY.indexOf(a.ext as typeof SUBTITLE_EXT_PRIORITY[number]);
          const bPriority = SUBTITLE_EXT_PRIORITY.indexOf(b.ext as typeof SUBTITLE_EXT_PRIORITY[number]);
          return (aPriority < 0 ? 999 : aPriority) - (bPriority < 0 ? 999 : bPriority);
        });
      const slug = language.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/-+/gu, "-").slice(0, 48) || "track";
      for (const selected of candidates) {
        if (!selected.url && !selected.inlineData) continue;
        const name = safeText(selected.track.name);
        formats.push({
          id: `subtitle-${automatic ? "auto" : "manual"}-${slug}-${selected.ext}-${formats.length}`.slice(0, 100),
          // The URL is ignored for inline tracks but remains structurally safe
          // for the shared media-format contract and authenticated UI.
          url: selected.url ?? `https://inline-subtitle.invalid/${slug}/${formats.length}`,
          ext: selected.ext,
          mimeType: subtitleMimeType(selected.ext),
          width: null,
          height: null,
          fps: null,
          bitrateKbps: null,
          filesize: null,
          qualityLabel: name && name.toLowerCase() !== language.toLowerCase() ? `${language} / ${name}` : language,
          videoCodec: null,
          audioCodec: null,
          hasVideo: false,
          hasAudio: false,
          requiresMuxing: false,
          downloadMode: "yt-dlp",
          mediaType: "subtitle",
          language,
          automatic,
          ...(selected.inlineData ? { inlineData: selected.inlineData } : {}),
          httpHeaders: safeMediaHeaders(selected.track.http_headers),
        });
        if (formats.length >= 200) return;
      }
    }
  };

  collect(info.subtitles, false);
  collect(info.automatic_captions, true);
  return formats;
}

function subtitleDisplayRank(format: MediaFormat): number {
  const language = format.language?.toLowerCase() ?? "";
  if (!format.automatic) return 0;
  if (/^(?:zh|zh-|en|en-|ja|ja-|ko|ko-)/u.test(language)) return 1;
  return 2;
}

function subtitleExtensionRank(format: MediaFormat): number {
  const rank = SUBTITLE_EXT_PRIORITY.indexOf(format.ext as typeof SUBTITLE_EXT_PRIORITY[number]);
  return rank < 0 ? 999 : rank;
}

export function selectDisplaySubtitleFormats(formats: MediaFormat[]): MediaFormat[] {
  const seenTracks = new Set<string>();
  return [...formats]
    .sort((a, b) => subtitleDisplayRank(a) - subtitleDisplayRank(b)
      || (a.language ?? "").localeCompare(b.language ?? "", "en")
      || subtitleExtensionRank(a) - subtitleExtensionRank(b))
    .filter((format) => {
      // Keep the full set in metadata for deterministic fallback, while the UI
      // only needs one preferred representation per manual/automatic language.
      const key = `${format.automatic ? "auto" : "manual"}:${format.language?.toLowerCase() ?? ""}`;
      if (seenTracks.has(key)) return false;
      seenTracks.add(key);
      return true;
    })
    .slice(0, DISPLAY_SUBTITLE_LIMIT);
}

function requestedFormatEntries(info: Record<string, unknown>): unknown[] {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const requestedFormats = Array.isArray(info.requested_formats) ? info.requested_formats : [];
  const requestedDownloads = Array.isArray(info.requested_downloads)
    ? info.requested_downloads.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const requested = (value as Record<string, unknown>).requested_formats;
        return Array.isArray(requested) ? requested : [value];
      })
    : [];
  return [...formats, ...requestedFormats, ...requestedDownloads];
}

function attachPreferredAudioFormat(formats: MediaFormat[]): MediaFormat[] {
  const preferredAudio = formats
    .filter((format) => format.hasAudio && !format.hasVideo)
    .sort((a, b) => (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0) || (b.filesize ?? 0) - (a.filesize ?? 0))[0];
  if (!preferredAudio) return formats;

  return formats.map((format) => format.hasVideo && !format.hasAudio
    ? { ...format, audioFormatId: preferredAudio.id }
    : format);
}

function deduplicateFormats(formats: MediaFormat[]): MediaFormat[] {
  const seen = new Set<string>();
  return formats.filter((format) => {
    const structuralKey = [
      format.hasVideo ? "video" : "audio",
      format.hasAudio ? "with-audio" : "video-only",
      format.width ?? "",
      format.height ?? "",
      format.fps ?? "",
      format.bitrateKbps ?? "",
      format.filesize ?? "",
      format.ext ?? "",
      format.videoCodec ?? "",
      format.audioCodec ?? "",
    ].join(":");
    const key = structuralKey.replace(/:/g, "") ? structuralKey : `${format.id}:${format.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareDisplayFormats(a: MediaFormat, b: MediaFormat): number {
  return (b.fps ?? -1) - (a.fps ?? -1)
    || (b.bitrateKbps ?? -1) - (a.bitrateKbps ?? -1)
    || (b.width ?? -1) - (a.width ?? -1)
    || Number(b.hasAudio) - Number(a.hasAudio)
    || (b.filesize ?? -1) - (a.filesize ?? -1);
}

/**
 * Keep the complete normalized format list for history, but show one stream
 * per resolution in the workspace. FPS is the primary selection criterion.
 */
export function selectDisplayVideoFormats(formats: MediaFormat[]): MediaFormat[] {
  const groups = new Map<string, MediaFormat[]>();
  for (const format of formats) {
    const resolutionKey = format.height === null ? "unknown" : `height:${format.height}`;
    const group = groups.get(resolutionKey) ?? [];
    group.push(format);
    groups.set(resolutionKey, group);
  }

  return [...groups.entries()]
    .map(([resolutionKey, group]) => ({
      resolutionKey,
      format: [...group].sort(compareDisplayFormats)[0],
    }))
    .sort((a, b) => {
      const aHeight = a.format.height ?? -1;
      const bHeight = b.format.height ?? -1;
      return bHeight - aHeight || compareDisplayFormats(a.format, b.format);
    })
    .map(({ format }) => format);
}

export function parseYtDlpInfo(info: Record<string, unknown>, request: ParseRequest): ParseResult {
  const directMediaOnly = info.browserFallback === true || info.directMediaOnly === true;
  const formats = attachPreferredAudioFormat(deduplicateFormats(
    requestedFormatEntries(info).flatMap((value, index) => {
      if (!value || typeof value !== "object") return [];
      const format = mediaFormatFromRaw(value as Record<string, unknown>, index);
      return format ? [format] : [];
    }),
  )).map((format) => directMediaOnly ? { ...format, downloadMode: "direct" as const } : format);

  const fallbackUrl = safeText(info.url);
  if (formats.length === 0 && fallbackUrl && isSafeRemoteHttpUrl(fallbackUrl)) {
    const fallback = mediaFormatFromRaw(
      {
        url: fallbackUrl,
        format_id: "default",
        ext: info.ext,
        mime: info.mime,
        width: info.width,
        height: info.height,
        vcodec: info.vcodec,
        acodec: info.acodec,
      },
      0,
    );
    if (fallback) formats.push(fallback);
  }

  const imageFormats = formats.length === 0 ? imageFormatEntries(info, request) : [];

  if (formats.length === 0 && imageFormats.length === 0) {
    const message =
      request.platform.id === "xiaohongshu"
        ? "Xiaohongshu returned no downloadable video, audio, or image formats. Check that the note is public; if the platform applies an access restriction, use an authorized session or configure the XHS-Downloader sidecar."
        : "The parser found metadata but no safe video or audio download formats. The source may be restricted or unsupported.";
    throw new ParserFailedError(
      message,
    );
  }

  const allVideoFormats = formats.filter((format) => format.hasVideo);
  const videoFormats = selectDisplayVideoFormats(allVideoFormats);
  const audioFormats = formats
    .filter((format) => format.hasAudio && !format.hasVideo)
    .sort((a, b) => (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0))
    .slice(0, 20);
  const allSubtitleFormats = subtitleFormatEntries(info);
  const subtitleFormats = selectDisplaySubtitleFormats(allSubtitleFormats);

  const duration = safeNumber(info.duration);

  return {
    sourceUrl: request.sourceUrl,
    canonicalUrl: request.canonicalUrl,
    platform: request.platform,
    title: safeText(info.title, "Untitled media") ?? "Untitled media",
    description: safeText(info.description),
    thumbnailUrl: imageFormats[0]?.url ?? thumbnailUrlFromInfo(info, request),
    uploader: safeText(info.uploader) ?? safeText(info.channel),
    durationSeconds: duration === null ? null : Math.round(duration),
    videoFormats,
    audioFormats,
    imageFormats,
    subtitleFormats,
    metadata: {
      extractor: safeText(info.extractor),
      extractorKey: safeText(info.extractor_key),
      webpageUrl: safeText(info.webpage_url),
      liveStatus: safeText(info.live_status),
      uploadDate: safeText(info.upload_date),
      releaseTimestamp: safeNumber(info.release_timestamp),
      viewCount: safeNumber(info.view_count),
      likeCount: safeNumber(info.like_count),
      commentCount: safeNumber(info.comment_count),
      formatCount: formats.length,
      allVideoFormatCount: allVideoFormats.length,
      displayVideoFormatCount: videoFormats.length,
      subtitleFormatCount: allSubtitleFormats.length,
      displaySubtitleFormatCount: subtitleFormats.length,
      imageFormatCount: imageFormats.length,
      mediaKind: imageFormats.length > 0 ? "image" : "video",
      formatPolicy: "highest-fps-per-resolution",
      allVideoFormats,
      allSubtitleFormats,
      subtitleFormats,
      imageFormats,
    },
    mock: false,
  };
}

/**
 * Return a yt-dlp format selector suitable for a fresh download. Separate
 * video/audio streams are merged by yt-dlp and ffmpeg at download time.
 */
export function formatSelectorFor(format: MediaFormat): string | null {
  if (!format.id || !/^[A-Za-z0-9._:-]{1,100}$/u.test(format.id)) return null;
  if (!format.hasVideo || format.hasAudio || !format.audioFormatId) return format.id;
  if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(format.audioFormatId)) return null;
  return `${format.id}+${format.audioFormatId}`;
}

export class YtDlpAdapter implements ParserAdapter {
  public readonly name = "yt-dlp";
  private availabilityCache: {
    checkedAt: number;
    available: boolean;
    message: string;
    version?: string;
    extractorCount?: number;
  } | null = null;

  public constructor(private readonly appConfig: AppConfig = config) {}

  private async parseWithXhsSidecar(normalizedUrl: string, request: ParseRequest): Promise<ParseResult | null> {
    if (request.platform.id !== "xiaohongshu" || !this.appConfig.xhsDownloaderApiUrl) return null;
    try {
      const sidecarInfo = await extractXhsInfoWithDownloader(normalizedUrl, {
        apiUrl: this.appConfig.xhsDownloaderApiUrl,
        timeoutMs: this.appConfig.xhsDownloaderTimeoutMs,
        cookie: this.appConfig.xhsDownloaderCookie,
        proxy: this.appConfig.xhsDownloaderProxy,
      });
      return parseYtDlpInfo({ ...sidecarInfo, directMediaOnly: true }, request);
    } catch {
      // The optional sidecar must never hide the primary yt-dlp diagnostic.
      return null;
    }
  }

  public async available(): Promise<{
    available: boolean;
    message: string;
    version?: string;
    extractorCount?: number;
  }> {
    if (this.availabilityCache && Date.now() - this.availabilityCache.checkedAt < AVAILABILITY_CACHE_MS) {
      const { available, message, version, extractorCount } = this.availabilityCache;
      return { available, message, version, extractorCount };
    }

    try {
      const [result, extractors] = await Promise.all([
        runProcess(this.appConfig.ytdlpPath, ["--version"], 8_000, 128 * 1024),
        runProcess(this.appConfig.ytdlpPath, ["--list-extractors"], 15_000, 2 * 1024 * 1024).catch(() => null),
      ]);
      const available = result.exitCode === 0;
      const version = available ? result.stdout.trim().slice(0, 50) || undefined : undefined;
      const extractorCount = extractors?.exitCode === 0
        ? extractors.stdout.split(/\r?\n/gu).filter((line) => line.trim()).length
        : undefined;
      const message = available
        ? `yt-dlp is available${version ? ` (${version})` : ""}${extractorCount ? ` with ${extractorCount} extractors` : ""}.`
        : "yt-dlp was found but did not return a usable version.";
      this.availabilityCache = { checkedAt: Date.now(), available, message, version, extractorCount };
      return { available, message, version, extractorCount };
    } catch (error) {
      const message = processErrorMessage(error);
      const result = {
        checkedAt: Date.now(),
        available: false,
        message: `yt-dlp is unavailable: ${message}`,
      };
      this.availabilityCache = result;
      return { available: result.available, message: result.message };
    }
  }

  public async parse(request: ParseRequest): Promise<ParseResult> {
    const normalizedUrl = normalizeAndValidateUrl(request.sourceUrl);
    const args = buildYtDlpArgs(normalizedUrl, this.appConfig);

    let result: ProcessResult;
    let sidecarUrl = normalizedUrl;
    try {
      result = await runProcess(this.appConfig.ytdlpPath, args, this.appConfig.parseTimeoutMs);
    } catch (error) {
      const message = processErrorMessage(error);
      if (/enoent|not found|cannot find/i.test(message)) {
        throw new ParserUnavailableError(`yt-dlp could not be started: ${message}`);
      }
      if (/timed out/i.test(message)) {
        throw new ParserFailedError("yt-dlp took too long to read this URL; the source may be unavailable or slow.");
      }
      throw new ParserFailedError("yt-dlp could not be started for this URL.", { cause: message.slice(0, 300) });
    }

    if (result.exitCode !== 0 && request.platform.id === "xiaohongshu") {
      const redirectedUrl = xiaohongshuCanonicalUrlFromDiagnostic(result.stderr);
      if (redirectedUrl && redirectedUrl !== normalizedUrl) {
        sidecarUrl = redirectedUrl;
        const retryArgs = [...args];
        retryArgs[retryArgs.length - 1] = redirectedUrl;
        try {
          result = await runProcess(this.appConfig.ytdlpPath, retryArgs, this.appConfig.parseTimeoutMs);
        } catch (error) {
          const message = processErrorMessage(error);
          if (/timed out/i.test(message)) {
            throw new ParserFailedError("yt-dlp took too long to read this Xiaohongshu URL; the source may be unavailable or slow.");
          }
        }
      }
    }

    if (result.exitCode !== 0) {
      const diagnostic = result.stderr.trim().slice(-4_000);
      if (request.platform.id === "xiaohongshu") {
        const sidecarResult = await this.parseWithXhsSidecar(sidecarUrl, request);
        if (sidecarResult) return sidecarResult;
      }
      if (requiresFreshCookies(diagnostic)) {
        if (request.platform.id === "douyin" && this.appConfig.douyinBrowserFallback) {
          try {
            const browserInfo = await extractDouyinInfoWithBrowser(normalizedUrl, {
              executablePath: this.appConfig.browserExecutablePath,
              timeoutMs: this.appConfig.browserFallbackTimeoutMs,
            });
            return parseYtDlpInfo(browserInfo, request);
          } catch {
            // Keep the explicit session guidance below when the isolated browser
            // is unavailable or the source presents an interactive challenge.
          }
        }
        throw new ParserFailedError(
          "This source requires a fresh authorized browser session. Configure YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER and retry.",
          { diagnostic },
        );
      }
      if (restrictedSource(diagnostic)) {
        throw new SourceRestrictedError();
      }
      if (request.platform.id === "xiaohongshu") {
        const noVideoFormats = /no video formats found/i.test(diagnostic);
        const sidecarHint = this.appConfig.xhsDownloaderApiUrl
          ? " The configured XHS-Downloader sidecar could not obtain media either, which usually means the share link is expired or the note is restricted."
          : "";
        throw new ParserFailedError(
          noVideoFormats
            ? `Xiaohongshu returned no downloadable media for this note.${sidecarHint} A 300011/300031 response means the platform has restricted or removed the note. Re-copy a fresh public share link; if the note only opens after login, configure an authorized session.`
            : `yt-dlp could not read this Xiaohongshu URL.${sidecarHint} Confirm that the note is public, then re-copy a fresh share link or configure an authorized session.`,
          { exitCode: result.exitCode, diagnostic: diagnostic || "No diagnostic was returned by yt-dlp." },
        );
      }
      throw new ParserFailedError("yt-dlp could not read this public URL.", {
        exitCode: result.exitCode,
        diagnostic: diagnostic || "No diagnostic was returned by yt-dlp.",
      });
    }

    let info: unknown;
    try {
      info = parseJsonOutput(result.stdout);
    } catch {
      throw new ParserFailedError("yt-dlp returned an invalid metadata response.");
    }
    if (!info || typeof info !== "object") {
      throw new ParserFailedError("yt-dlp returned no media metadata.");
    }
    try {
      const parsed = parseYtDlpInfo(info as Record<string, unknown>, request);
      if (request.platform.id === "xiaohongshu" && parsed.imageFormats.length > 0) {
        const sidecarResult = await this.parseWithXhsSidecar(sidecarUrl, request);
        if (sidecarResult?.imageFormats.length) {
          // The sidecar exposes higher-resolution CI originals for downloads,
          // but that host can reject browser hotlinks. Keep yt-dlp's official
          // DFT image as the visible cover while retaining the full originals.
          return {
            ...sidecarResult,
            thumbnailUrl: parsed.thumbnailUrl ?? sidecarResult.thumbnailUrl,
          };
        }
      }
      return parsed;
    } catch (error) {
      const sidecarResult = await this.parseWithXhsSidecar(sidecarUrl, request);
      if (sidecarResult) return sidecarResult;
      throw error;
    }
  }
}

export class MockParserAdapter implements ParserAdapter {
  public readonly name = "mock";

  public async available(): Promise<{ available: boolean; message: string }> {
    return { available: true, message: "Development-only mock parser is enabled; no media is fetched." };
  }

  public async parse(request: ParseRequest): Promise<ParseResult> {
    const slug = encodeURIComponent(new URL(request.sourceUrl).hostname);
    return {
      sourceUrl: request.sourceUrl,
      canonicalUrl: request.canonicalUrl,
      platform: request.platform,
      title: `Mock preview for ${request.platform.label}`,
      description: "Development-only mock metadata. Configure yt-dlp for real public-source parsing.",
      thumbnailUrl: "https://example.invalid/junvideo/mock-thumbnail.jpg",
      uploader: "JunVideo mock",
      durationSeconds: 30,
      videoFormats: [
        {
          id: "mock-video",
          url: `https://example.invalid/junvideo/${slug}/video.mp4`,
          ext: "mp4",
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          fps: 30,
          bitrateKbps: 2_000,
          filesize: null,
          qualityLabel: "720p mock",
          videoCodec: "h264",
          audioCodec: null,
          hasVideo: true,
          hasAudio: false,
          requiresMuxing: true,
          downloadMode: "direct",
          httpHeaders: {},
        },
      ],
      audioFormats: [
        {
          id: "mock-audio",
          url: `https://example.invalid/junvideo/${slug}/audio.m4a`,
          ext: "m4a",
          mimeType: "audio/mp4",
          width: null,
          height: null,
          fps: null,
          bitrateKbps: 128,
          filesize: null,
          qualityLabel: "audio mock",
          videoCodec: null,
          audioCodec: "aac",
          hasVideo: false,
          hasAudio: true,
          requiresMuxing: false,
          downloadMode: "direct",
          httpHeaders: {},
        },
      ],
      imageFormats: [],
      subtitleFormats: [],
      metadata: { parser: "mock", sourceHost: request.platform.hostname, subtitleFormats: [], allSubtitleFormats: [] },
      mock: true,
    };
  }
}

export class ParserService {
  private readonly ytDlp: YtDlpAdapter;
  private readonly mock: MockParserAdapter;

  public constructor(private readonly appConfig: AppConfig = config) {
    this.ytDlp = new YtDlpAdapter(appConfig);
    this.mock = new MockParserAdapter();
  }

  public async parse(request: ParseRequest): Promise<ParseResult> {
    if (this.appConfig.parserMode === "mock") {
      return this.mock.parse(request);
    }
    return this.ytDlp.parse(request);
  }

  public async health(): Promise<ParserAvailability> {
    if (this.appConfig.parserMode === "mock") {
      const status = await this.mock.available();
      return { adapter: this.mock.name, mode: this.appConfig.parserMode, ...status };
    }

    const status = await this.ytDlp.available();
    return { adapter: this.ytDlp.name, mode: this.appConfig.parserMode, ...status };
  }
}

export function parseRequestFromPreflight(preflight: UrlPreflight): ParseRequest {
  return {
    sourceUrl: preflight.sourceUrl,
    canonicalUrl: preflight.canonicalUrl,
    platform: preflight.platform,
  };
}
