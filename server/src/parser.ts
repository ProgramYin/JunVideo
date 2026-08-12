import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
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
}

export interface ParserAdapter {
  readonly name: string;
  available(): Promise<{ available: boolean; message: string }>;
  parse(request: ParseRequest): Promise<ParseResult>;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const MAX_YTDLP_OUTPUT_BYTES = 12 * 1024 * 1024;
const AVAILABILITY_CACHE_MS = 15_000;

function processErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runChildProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes = MAX_YTDLP_OUTPUT_BYTES,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error?: Error, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as ProcessResult);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish(new Error("yt-dlp output exceeded the configured safety limit."));
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (exitCode, signal) => {
      finish(undefined, { exitCode, signal, stdout, stderr });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(new Error(`yt-dlp timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    void timedOut;
  });
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

function safeNumber(value: unknown, minimum = 0): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return null;
  return value;
}

const FORWARDED_MEDIA_HEADERS: Record<string, string> = {
  accept: "Accept",
  "accept-language": "Accept-Language",
  referer: "Referer",
  "user-agent": "User-Agent",
};

function safeMediaHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = FORWARDED_MEDIA_HEADERS[rawName.toLowerCase()];
    if (!name || typeof rawValue !== "string") continue;
    const headerValue = rawValue.trim();
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
  const hasVideo = Boolean(videoCodec && videoCodec !== "none");
  const hasAudio = Boolean(audioCodec && audioCodec !== "none");
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
    mimeType: safeText(raw.mime) ?? inferredMimeType(ext, hasVideo, hasAudio),
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
    requiresMuxing: hasVideo && !hasAudio,
    httpHeaders: safeMediaHeaders(raw.http_headers),
  };
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

function parseYtDlpInfo(info: Record<string, unknown>, request: ParseRequest): ParseResult {
  const rawFormats = Array.isArray(info.formats) ? info.formats : [];
  const formats = deduplicateFormats(
    rawFormats.flatMap((value, index) => {
      if (!value || typeof value !== "object") return [];
      const format = mediaFormatFromRaw(value as Record<string, unknown>, index);
      return format ? [format] : [];
    }),
  );

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

  if (formats.length === 0) {
    const message =
      request.platform.id === "xiaohongshu"
        ? "Xiaohongshu returned no downloadable video or audio formats. Check that this is a public video note rather than an image note; if the platform applies an access restriction, use an authorized session or configure the XHS-Downloader sidecar."
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

  const duration = safeNumber(info.duration);

  return {
    sourceUrl: request.sourceUrl,
    canonicalUrl: request.canonicalUrl,
    platform: request.platform,
    title: safeText(info.title, "Untitled media") ?? "Untitled media",
    description: safeText(info.description),
    thumbnailUrl: safeText(info.thumbnail),
    uploader: safeText(info.uploader) ?? safeText(info.channel),
    durationSeconds: duration === null ? null : Math.round(duration),
    videoFormats,
    audioFormats,
    metadata: {
      extractor: safeText(info.extractor),
      webpageUrl: safeText(info.webpage_url),
      liveStatus: safeText(info.live_status),
      formatCount: formats.length,
      allVideoFormatCount: allVideoFormats.length,
      displayVideoFormatCount: videoFormats.length,
      formatPolicy: "highest-fps-per-resolution",
      allVideoFormats,
    },
    mock: false,
  };
}

export class YtDlpAdapter implements ParserAdapter {
  public readonly name = "yt-dlp";
  private availabilityCache: { checkedAt: number; available: boolean; message: string } | null = null;

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
      return parseYtDlpInfo(sidecarInfo, request);
    } catch {
      // The optional sidecar must never hide the primary yt-dlp diagnostic.
      return null;
    }
  }

  public async available(): Promise<{ available: boolean; message: string }> {
    if (this.availabilityCache && Date.now() - this.availabilityCache.checkedAt < AVAILABILITY_CACHE_MS) {
      return this.availabilityCache;
    }

    try {
      const result = await runChildProcess(this.appConfig.ytdlpPath, ["--version"], 5_000, 128 * 1024);
      const available = result.exitCode === 0;
      const message = available
        ? `yt-dlp is available${result.stdout.trim() ? ` (${result.stdout.trim().slice(0, 50)})` : ""}.`
        : "yt-dlp was found but did not return a usable version.";
      this.availabilityCache = { checkedAt: Date.now(), available, message };
      return this.availabilityCache;
    } catch (error) {
      const message = processErrorMessage(error);
      const result = {
        checkedAt: Date.now(),
        available: false,
        message: `yt-dlp is unavailable: ${message}`,
      };
      this.availabilityCache = result;
      return result;
    }
  }

  public async parse(request: ParseRequest): Promise<ParseResult> {
    const normalizedUrl = normalizeAndValidateUrl(request.sourceUrl);
    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
    ];
    if (this.appConfig.ytdlpCookiesFile) {
      args.push("--cookies", this.appConfig.ytdlpCookiesFile);
    }
    if (this.appConfig.ytdlpCookiesFromBrowser) {
      args.push("--cookies-from-browser", this.appConfig.ytdlpCookiesFromBrowser);
    }
    args.push(
      "--dump-single-json",
      "--skip-download",
      "--",
      normalizedUrl,
    );

    let result: ProcessResult;
    let sidecarUrl = normalizedUrl;
    try {
      result = await runChildProcess(this.appConfig.ytdlpPath, args, this.appConfig.parseTimeoutMs);
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
          result = await runChildProcess(this.appConfig.ytdlpPath, retryArgs, this.appConfig.parseTimeoutMs);
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
          ? " The configured XHS-Downloader sidecar could not obtain media either, which usually means this short link is expired, restricted, or points to an image note."
          : "";
        throw new ParserFailedError(
          noVideoFormats
            ? `Xiaohongshu returned no video stream for this note.${sidecarHint} A 300011/300031 response means the platform has restricted or removed the note. Re-copy a fresh public video-note share link; if the note only opens after login, configure an authorized session.`
            : `yt-dlp could not read this Xiaohongshu URL.${sidecarHint} Confirm that it is a public video note rather than an image note, then re-copy a fresh share link or configure an authorized session.`,
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
      info = JSON.parse(result.stdout.trim());
    } catch {
      throw new ParserFailedError("yt-dlp returned an invalid metadata response.");
    }
    if (!info || typeof info !== "object") {
      throw new ParserFailedError("yt-dlp returned no media metadata.");
    }
    try {
      return parseYtDlpInfo(info as Record<string, unknown>, request);
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
          httpHeaders: {},
        },
      ],
      metadata: { parser: "mock", sourceHost: request.platform.hostname },
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
