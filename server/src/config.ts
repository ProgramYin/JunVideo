import "dotenv/config";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { decodeCookieEncryptionKey, materializeEncryptedCookieFile } from "./yt-dlp-cookies.js";

export type ParserMode = "mock" | "yt-dlp" | "auto";

const isProduction = process.env.NODE_ENV === "production";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  SERVE_CLIENT: z.enum(["true", "false"]).optional(),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/junvideo"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  JWT_SECRET: z.string().min(1).optional(),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
  YTDLP_RETRIES: z.coerce.number().int().min(0).max(20).default(0),
  YTDLP_EXTRACTOR_RETRIES: z.coerce.number().int().min(0).max(20).default(0),
  YTDLP_FRAGMENT_RETRIES: z.coerce.number().int().min(0).max(20).default(0),
  YTDLP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  // YouTube's logged-out defaults can return metadata without downloadable
  // formats from serverless IP ranges. Keep the Android-compatible client in
  // the default set while allowing deployments to tune extractor behavior.
  YTDLP_EXTRACTOR_ARGS: z.string().min(1).default("youtube:player_client=web_embedded,android"),
  YTDLP_JS_RUNTIMES: z.string().optional(),
  YTDLP_REMOTE_COMPONENTS: z.string().optional(),
  YTDLP_COOKIES_FILE: z.string().optional(),
  YTDLP_COOKIES_FROM_BROWSER: z.string().optional(),
  // The encrypted Netscape cookie envelope and its separate 32-byte key are
  // intended for Vercel environment secrets. The plaintext only exists in a
  // 0600 file under the runtime temp directory.
  YTDLP_COOKIES_ENCRYPTED: z.string().optional(),
  YTDLP_COOKIES_ENCRYPTION_KEY: z.string().optional(),
  TEXT_EXTRACTION_ENABLED: z.enum(["true", "false"]).default("true"),
  TEXT_EXTRACTION_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  TEXT_EXTRACTION_MAX_BYTES: z.coerce.number().int().min(65_536).max(16 * 1024 * 1024).default(8 * 1024 * 1024),
  TEXT_EXTRACTION_MAX_CUES: z.coerce.number().int().min(1).max(100_000).default(20_000),
  TEXT_EXTRACTION_MAX_CHARS: z.coerce.number().int().min(1_000).max(10_000_000).default(2_000_000),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  DOUYIN_BROWSER_FALLBACK: z.enum(["true", "false"]).default("true"),
  JUNVIDEO_BROWSER_PATH: z.string().optional(),
  BROWSER_FALLBACK_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(35_000),
  XHS_DOWNLOADER_API_URL: z.string().optional(),
  XHS_DOWNLOADER_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(120_000).default(20_000),
  XHS_DOWNLOADER_COOKIE: z.string().optional(),
  XHS_DOWNLOADER_PROXY: z.string().optional(),
  PARSER_MODE: z.enum(["mock", "yt-dlp", "auto"]).optional(),
  PARSE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(10 * 60 * 1000).default(90_000),
  MEDIA_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(6 * 60 * 60 * 1000).default(60 * 60 * 1000),
  LOCAL_TIME_ZONE: z.string().min(1).default("Asia/Shanghai"),
  DAILY_PARSE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(10),
  DEV_VIP_ENABLED: z.enum(["true", "false"]).optional(),
  CORS_ORIGIN: z.string().optional(),
});

const parsedEnv = envSchema.parse(process.env);
const jwtSecret = parsedEnv.JWT_SECRET ?? (isProduction ? "" : "junvideo-development-secret-change-me");

if (isProduction && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters in production.");
}

try {
  new Intl.DateTimeFormat("en-US", { timeZone: parsedEnv.LOCAL_TIME_ZONE }).format();
} catch {
  throw new Error(`LOCAL_TIME_ZONE is invalid: ${parsedEnv.LOCAL_TIME_ZONE}`);
}

// Real parsing is the default in every environment. Mock mode remains an
// explicit opt-in for UI-only development and never hides a missing parser.
const parserMode: ParserMode = parsedEnv.PARSER_MODE ?? "yt-dlp";
const devVipEnabled = parsedEnv.DEV_VIP_ENABLED
  ? parsedEnv.DEV_VIP_ENABLED === "true"
  : !isProduction;
const serveClient = parsedEnv.SERVE_CLIENT ? parsedEnv.SERVE_CLIENT === "true" : isProduction;
const ytdlpCookiesFile = parsedEnv.YTDLP_COOKIES_FILE?.trim() || undefined;
const ytdlpCookiesFromBrowser = parsedEnv.YTDLP_COOKIES_FROM_BROWSER?.trim() || undefined;
const ytdlpCookiesEncrypted = parsedEnv.YTDLP_COOKIES_ENCRYPTED?.trim() || undefined;
const ytdlpCookiesEncryptionKey = parsedEnv.YTDLP_COOKIES_ENCRYPTION_KEY?.trim() || undefined;
const ffmpegPath = parsedEnv.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobePath = parsedEnv.FFPROBE_PATH?.trim() || "ffprobe";
const xhsDownloaderApiUrl = parsedEnv.XHS_DOWNLOADER_API_URL?.trim() || undefined;
const xhsDownloaderCookie = parsedEnv.XHS_DOWNLOADER_COOKIE?.trim() || undefined;
const xhsDownloaderProxy = parsedEnv.XHS_DOWNLOADER_PROXY?.trim() || undefined;

if (xhsDownloaderApiUrl) {
  let parsedXhsUrl: URL;
  try {
    parsedXhsUrl = new URL(xhsDownloaderApiUrl);
  } catch {
    throw new Error("XHS_DOWNLOADER_API_URL must be a valid HTTP(S) URL.");
  }
  if (parsedXhsUrl.protocol !== "http:" && parsedXhsUrl.protocol !== "https:") {
    throw new Error("XHS_DOWNLOADER_API_URL must use HTTP or HTTPS.");
  }
}

if ([ytdlpCookiesFile, ytdlpCookiesFromBrowser, ytdlpCookiesEncrypted].filter(Boolean).length > 1) {
  throw new Error("Configure only one YTDLP cookie source: file, browser, or encrypted.");
}
if (ytdlpCookiesEncrypted && !ytdlpCookiesEncryptionKey) {
  throw new Error("YTDLP_COOKIES_ENCRYPTION_KEY is required when YTDLP_COOKIES_ENCRYPTED is configured.");
}
if (!ytdlpCookiesEncrypted && ytdlpCookiesEncryptionKey) {
  throw new Error("YTDLP_COOKIES_ENCRYPTED is required when YTDLP_COOKIES_ENCRYPTION_KEY is configured.");
}

let encryptedCookieCleanup: (() => void) | undefined;
let resolvedYtdlpCookiesFile = ytdlpCookiesFile;
if (ytdlpCookiesEncrypted && ytdlpCookiesEncryptionKey) {
  const materialized = materializeEncryptedCookieFile(
    ytdlpCookiesEncrypted,
    decodeCookieEncryptionKey(ytdlpCookiesEncryptionKey),
  );
  resolvedYtdlpCookiesFile = materialized.filePath;
  encryptedCookieCleanup = materialized.cleanup;
  process.once("exit", () => encryptedCookieCleanup?.());
}

function resolveYtdlpPath(value: string): string {
  const trimmed = value.trim();
  // Keep bare executable names on PATH. Resolve configured relative paths so
  // starting the API from another working directory does not break parsing.
  return isAbsolute(trimmed) || /[\\/]/u.test(trimmed) || trimmed.startsWith(".")
    ? resolve(process.cwd(), trimmed)
    : trimmed;
}

export const config = {
  nodeEnv: parsedEnv.NODE_ENV,
  isProduction,
  host: parsedEnv.HOST,
  port: parsedEnv.PORT,
  serveClient,
  databaseUrl: parsedEnv.DATABASE_URL,
  databasePoolMax: parsedEnv.DATABASE_POOL_MAX,
  databaseSsl: parsedEnv.DATABASE_SSL === "true",
  jwtSecret,
  jwtExpiresIn: parsedEnv.JWT_EXPIRES_IN,
  ytdlpPath: resolveYtdlpPath(parsedEnv.YTDLP_PATH),
  ytdlpRetries: parsedEnv.YTDLP_RETRIES,
  ytdlpExtractorRetries: parsedEnv.YTDLP_EXTRACTOR_RETRIES,
  ytdlpFragmentRetries: parsedEnv.YTDLP_FRAGMENT_RETRIES,
  ytdlpSocketTimeoutMs: parsedEnv.YTDLP_SOCKET_TIMEOUT_MS,
  ytdlpExtractorArgs: parsedEnv.YTDLP_EXTRACTOR_ARGS.trim(),
  ytdlpJsRuntimes: parsedEnv.YTDLP_JS_RUNTIMES?.trim() || undefined,
  ytdlpRemoteComponents: parsedEnv.YTDLP_REMOTE_COMPONENTS?.trim() || undefined,
  ytdlpCookiesFile: resolvedYtdlpCookiesFile,
  ytdlpCookiesFromBrowser,
  ytdlpCookieSession: ytdlpCookiesEncrypted
    ? "encrypted"
    : ytdlpCookiesFile
      ? "file"
      : ytdlpCookiesFromBrowser
        ? "browser"
        : "none",
  textExtractionEnabled: parsedEnv.TEXT_EXTRACTION_ENABLED === "true",
  textExtractionTimeoutMs: parsedEnv.TEXT_EXTRACTION_TIMEOUT_MS,
  textExtractionMaxBytes: parsedEnv.TEXT_EXTRACTION_MAX_BYTES,
  textExtractionMaxCues: parsedEnv.TEXT_EXTRACTION_MAX_CUES,
  textExtractionMaxChars: parsedEnv.TEXT_EXTRACTION_MAX_CHARS,
  ffmpegPath,
  ffprobePath,
  douyinBrowserFallback: parsedEnv.DOUYIN_BROWSER_FALLBACK === "true",
  browserExecutablePath: parsedEnv.JUNVIDEO_BROWSER_PATH?.trim() || undefined,
  browserFallbackTimeoutMs: parsedEnv.BROWSER_FALLBACK_TIMEOUT_MS,
  xhsDownloaderApiUrl,
  xhsDownloaderTimeoutMs: parsedEnv.XHS_DOWNLOADER_TIMEOUT_MS,
  xhsDownloaderCookie,
  xhsDownloaderProxy,
  parserMode,
  parseTimeoutMs: parsedEnv.PARSE_TIMEOUT_MS,
  mediaDownloadTimeoutMs: parsedEnv.MEDIA_DOWNLOAD_TIMEOUT_MS,
  localTimeZone: parsedEnv.LOCAL_TIME_ZONE,
  dailyParseLimit: parsedEnv.DAILY_PARSE_LIMIT,
  devVipEnabled,
  corsOrigins: (parsedEnv.CORS_ORIGIN ?? "http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;
