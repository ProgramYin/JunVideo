import "dotenv/config";
import { z } from "zod";

export type ParserMode = "mock" | "yt-dlp" | "auto";

const isProduction = process.env.NODE_ENV === "production";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/junvideo"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  JWT_SECRET: z.string().min(1).optional(),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
  YTDLP_COOKIES_FILE: z.string().optional(),
  YTDLP_COOKIES_FROM_BROWSER: z.string().optional(),
  DOUYIN_BROWSER_FALLBACK: z.enum(["true", "false"]).default("true"),
  JUNVIDEO_BROWSER_PATH: z.string().optional(),
  BROWSER_FALLBACK_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(35_000),
  XHS_DOWNLOADER_API_URL: z.string().optional(),
  XHS_DOWNLOADER_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(120_000).default(20_000),
  XHS_DOWNLOADER_COOKIE: z.string().optional(),
  XHS_DOWNLOADER_PROXY: z.string().optional(),
  PARSER_MODE: z.enum(["mock", "yt-dlp", "auto"]).optional(),
  PARSE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(10 * 60 * 1000).default(90_000),
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

const parserMode: ParserMode = parsedEnv.PARSER_MODE ?? (isProduction ? "yt-dlp" : "mock");
const devVipEnabled = parsedEnv.DEV_VIP_ENABLED
  ? parsedEnv.DEV_VIP_ENABLED === "true"
  : !isProduction;
const ytdlpCookiesFile = parsedEnv.YTDLP_COOKIES_FILE?.trim() || undefined;
const ytdlpCookiesFromBrowser = parsedEnv.YTDLP_COOKIES_FROM_BROWSER?.trim() || undefined;
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

export const config = {
  nodeEnv: parsedEnv.NODE_ENV,
  isProduction,
  port: parsedEnv.PORT,
  databaseUrl: parsedEnv.DATABASE_URL,
  databasePoolMax: parsedEnv.DATABASE_POOL_MAX,
  databaseSsl: parsedEnv.DATABASE_SSL === "true",
  jwtSecret,
  jwtExpiresIn: parsedEnv.JWT_EXPIRES_IN,
  ytdlpPath: parsedEnv.YTDLP_PATH,
  ytdlpCookiesFile,
  ytdlpCookiesFromBrowser,
  douyinBrowserFallback: parsedEnv.DOUYIN_BROWSER_FALLBACK === "true",
  browserExecutablePath: parsedEnv.JUNVIDEO_BROWSER_PATH?.trim() || undefined,
  browserFallbackTimeoutMs: parsedEnv.BROWSER_FALLBACK_TIMEOUT_MS,
  xhsDownloaderApiUrl,
  xhsDownloaderTimeoutMs: parsedEnv.XHS_DOWNLOADER_TIMEOUT_MS,
  xhsDownloaderCookie,
  xhsDownloaderProxy,
  parserMode,
  parseTimeoutMs: parsedEnv.PARSE_TIMEOUT_MS,
  localTimeZone: parsedEnv.LOCAL_TIME_ZONE,
  dailyParseLimit: parsedEnv.DAILY_PARSE_LIMIT,
  devVipEnabled,
  corsOrigins: (parsedEnv.CORS_ORIGIN ?? "http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;
