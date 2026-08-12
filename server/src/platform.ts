import { InputValidationError } from "./errors.js";

export type PlatformId =
  | "douyin"
  | "xiaohongshu"
  | "bilibili"
  | "youtube"
  | "tiktok"
  | "instagram"
  | "facebook"
  | "x"
  | "weibo"
  | "kuaishou"
  | "vimeo"
  | "dailymotion"
  | "twitch"
  | "reddit"
  | "qqvideo"
  | "ixigua"
  | "zhihu"
  | "pinterest"
  | "soundcloud"
  | "other";

export interface PlatformInfo {
  id: PlatformId;
  label: string;
  hostname: string;
  recognized: boolean;
}

export interface UrlPreflight {
  sourceUrl: string;
  canonicalUrl: string;
  platform: PlatformInfo;
}

interface PlatformRule {
  id: Exclude<PlatformId, "other">;
  label: string;
  domains: readonly string[];
}

const PLATFORM_RULES: readonly PlatformRule[] = [
  { id: "douyin", label: "Douyin", domains: ["douyin.com", "iesdouyin.com", "douyinvideo.net"] },
  { id: "xiaohongshu", label: "Xiaohongshu", domains: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"] },
  { id: "bilibili", label: "Bilibili", domains: ["bilibili.com", "b23.tv"] },
  { id: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
  { id: "tiktok", label: "TikTok", domains: ["tiktok.com"] },
  { id: "instagram", label: "Instagram", domains: ["instagram.com"] },
  { id: "facebook", label: "Facebook", domains: ["facebook.com", "fb.watch"] },
  { id: "x", label: "X / Twitter", domains: ["x.com", "twitter.com", "t.co"] },
  { id: "weibo", label: "Weibo", domains: ["weibo.com", "weibo.cn"] },
  { id: "kuaishou", label: "Kuaishou", domains: ["kuaishou.com", "gifshow.com"] },
  { id: "vimeo", label: "Vimeo", domains: ["vimeo.com"] },
  { id: "dailymotion", label: "Dailymotion", domains: ["dailymotion.com", "dai.ly"] },
  { id: "twitch", label: "Twitch", domains: ["twitch.tv"] },
  { id: "reddit", label: "Reddit", domains: ["reddit.com", "redd.it"] },
  { id: "qqvideo", label: "Tencent Video", domains: ["v.qq.com", "qq.com"] },
  { id: "ixigua", label: "Xigua Video", domains: ["ixigua.com"] },
  { id: "zhihu", label: "Zhihu", domains: ["zhihu.com", "zhimg.com"] },
  { id: "pinterest", label: "Pinterest", domains: ["pinterest.com", "pin.it"] },
  { id: "soundcloud", label: "SoundCloud", domains: ["soundcloud.com"] },
];

const EXPLICIT_URL_PATTERN = /(?:https?:\/\/|\/\/)[^\s<>"'`()\[\]{}]+/giu;
const BARE_URL_PATTERN = /(?:^|[\s([\{【「《])((?:www\.)?(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"'`()\[\]{}【】（）《》，。！？；：、]*)?)/giu;

function trimExtractedUrl(value: string): string {
  return value
    .trim()
    .replace(/^[\[({【「《]+/u, "")
    .replace(/[\]})】」》>,，。！？；：、]+$/gu, "");
}

function trimUrlMarkup(value: string): string {
  return value
    .trim()
    .replace(/^[\[({<]+/u, "")
    .replace(/[\]})>.,，。！？!?；;：:、]+$/u, "");
}

/**
 * Extract the first URL from pasted prose, Markdown, or platform share text.
 * The caller still performs the full HTTP(S), credential, and private-network
 * validation after extraction.
 */
export function extractUrlFromText(value: unknown): string {
  if (typeof value !== "string") return "";
  const input = value.trim();
  if (!input) return "";

  const candidates = [
    ...(input.match(EXPLICIT_URL_PATTERN) ?? []),
    ...Array.from(input.matchAll(BARE_URL_PATTERN), (match) => match[1]),
  ]
    .map((candidate) => trimUrlMarkup(trimExtractedUrl(candidate)))
    .filter(Boolean);

  return candidates[0] ?? input;
}

export function normalizeAndValidateUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new InputValidationError("url must be a string.");
  }

  const input = extractUrlFromText(value);
  if (!input || input.length > 2_048) {
    throw new InputValidationError("url must be a non-empty HTTP(S) URL no longer than 2048 characters.");
  }

  // Users frequently copy a host/path without the visible scheme from a
  // platform share sheet. Treat that shorthand as HTTPS while still letting
  // explicit non-HTTP schemes fail below.
  const candidate = input.startsWith("//")
    ? `https:${input}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(input)
      ? input
      : `https://${input}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InputValidationError("url must be a valid absolute HTTP(S) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InputValidationError("Only http:// and https:// URLs are accepted.");
  }
  if (parsed.username || parsed.password) {
    throw new InputValidationError("URLs containing embedded credentials are not accepted.");
  }
  if (!parsed.hostname || parsed.hostname.length > 253 || /\s/.test(parsed.hostname)) {
    throw new InputValidationError("url contains an invalid hostname.");
  }
  if (!isSafeRemoteHttpUrl(parsed.toString())) {
    throw new InputValidationError("Private-network, localhost, and embedded-credential URLs are not accepted.");
  }

  parsed.hash = "";
  return parsed.toString();
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectPlatform(value: string | URL): PlatformInfo {
  const parsed = typeof value === "string" ? new URL(normalizeAndValidateUrl(value)) : value;
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

  for (const rule of PLATFORM_RULES) {
    if (rule.domains.some((domain) => matchesDomain(hostname, domain))) {
      return { id: rule.id, label: rule.label, hostname, recognized: true };
    }
  }

  return { id: "other", label: "Other platform", hostname, recognized: false };
}

export function preflightUrl(value: unknown): UrlPreflight {
  const sourceUrl = normalizeAndValidateUrl(value);
  const parsed = new URL(sourceUrl);
  return {
    sourceUrl,
    canonicalUrl: sourceUrl,
    platform: detectPlatform(parsed),
  };
}

function normalizedHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isSafeRemoteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const hostname = normalizedHostname(value);
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  ) {
    return false;
  }
  return !isPrivateIpv4(hostname);
}

export function platformCatalog(): readonly PlatformRule[] {
  return PLATFORM_RULES;
}
