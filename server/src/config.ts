import "dotenv/config";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export type ParserMode = "mock" | "yt-dlp" | "auto";

const isProduction = process.env.NODE_ENV === "production";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  YTDLP_COOKIES_FILE: z.string().optional(),
  YTDLP_COOKIES_FROM_BROWSER: z.string().optional(),
  PYTHON_PATH: z.string().optional(),
  FFMPEG_PATH: z.string().optional(),
  WHISPER_MODEL: z.string().trim().min(1).max(40).default("tiny"),
  TRANSCRIPTION_ENABLED: z.enum(["true", "false"]).default("true"),
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(60 * 60 * 1000).default(15 * 60 * 1000),
  TRANSCRIPTION_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(2 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
  CORRECTION_MODE: z.enum(["rules", "openai", "none"]).default("rules"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_CORRECTION_MODEL: z.string().trim().min(1).max(100).default("gpt-4o-mini"),
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
const pythonPath = parsedEnv.PYTHON_PATH?.trim() || "python";
const ffmpegPath = parsedEnv.FFMPEG_PATH?.trim() || "ffmpeg";
const openAiApiKey = parsedEnv.OPENAI_API_KEY?.trim() || undefined;
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

if (ytdlpCookiesFile && ytdlpCookiesFromBrowser) {
  throw new Error("Configure only one of YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER.");
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
  ytdlpCookiesFile,
  ytdlpCookiesFromBrowser,
  pythonPath,
  ffmpegPath,
  whisperModel: parsedEnv.WHISPER_MODEL,
  transcriptionEnabled: parsedEnv.TRANSCRIPTION_ENABLED === "true",
  transcriptionTimeoutMs: parsedEnv.TRANSCRIPTION_TIMEOUT_MS,
  transcriptionMaxBytes: parsedEnv.TRANSCRIPTION_MAX_BYTES,
  correctionMode: parsedEnv.CORRECTION_MODE,
  openAiApiKey,
  openAiBaseUrl: parsedEnv.OPENAI_BASE_URL.replace(/\/+$/u, ""),
  openAiCorrectionModel: parsedEnv.OPENAI_CORRECTION_MODEL,
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
