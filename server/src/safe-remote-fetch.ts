import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { once } from "node:events";
import { AppError } from "./errors.js";

export interface SafeRemoteFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  headers?: Record<string, string>;
  overwrite?: boolean;
  signal?: AbortSignal;
}

export interface SafeRemoteFileResult {
  bytes: number;
  contentType?: string;
  statusCode: number;
  finalUrl: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_HEADER_NAMES = new Set(["accept", "accept-language", "origin", "referer", "user-agent"]);

function remoteError(statusCode: number, code: string, message: string): AppError {
  return new AppError(statusCode, code, message, {
    action: code === "REMOTE_TOO_LARGE"
      ? "Select a smaller text track or media container."
      : "Parse the source again and retry with a public media URL.",
  });
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => /^\d{1,3}$/u.test(part) ? Number(part) : -1);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null;
}

function isPublicIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (!bytes) return false;
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Bytes(address: string): number[] | null {
  let normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  if (normalized.includes(".")) {
    const boundary = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4(normalized.slice(boundary + 1));
    if (boundary < 0 || !ipv4) return null;
    normalized = `${normalized.slice(0, boundary)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if ((normalized.match(/::/gu) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = normalized.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ((normalized.includes("::") && left.length + right.length >= 8)
    || (!normalized.includes("::") && left.length !== 8)) return null;
  const groups = normalized.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  // IPv4-mapped IPv6 must inherit the embedded address classification.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12).join("."));
  }
  // Accept only global-unicast space, then remove documentation/transition ranges.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address.replace(/^\[|\]$/gu, ""));
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function validatedUrl(value: string, allowedPorts: readonly number[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media URL is invalid.");
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) {
    throw remoteError(502, "REMOTE_FETCH_FAILED", "Only credential-free HTTP(S) media URLs are supported.");
  }
  const effectivePort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!allowedPorts.includes(effectivePort)) {
    throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media URL uses a blocked port.");
  }
  return url;
}

function sanitizedHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const output: Record<string, string> = { "Accept-Encoding": "identity" };
  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (!ALLOWED_HEADER_NAMES.has(name)
      || !/^[a-z0-9-]{1,64}$/u.test(name)
      || typeof rawValue !== "string"
      || rawValue.length > 2_048
      || /[\r\n\0]/u.test(rawValue)) continue;
    output[name] = rawValue.trim();
  }
  return output;
}

async function resolvePublic(hostname: string, timeoutMs: number): Promise<LookupAddress> {
  const host = hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host)) {
    if (!isPublicIpAddress(host)) throw remoteError(502, "REMOTE_DNS_BLOCKED", "The remote hostname resolves to a blocked network address.");
    return { address: host, family: isIP(host) } as LookupAddress;
  }
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(remoteError(504, "REMOTE_TIMEOUT", "Resolving the remote media host timed out.")), timeoutMs);
    dnsLookup(host, { all: true, verbatim: true }, (error, values) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(values);
    });
  }).catch((error: unknown) => {
    if (error instanceof AppError) throw error;
    throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media host could not be resolved.");
  });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw remoteError(502, "REMOTE_DNS_BLOCKED", "The remote hostname resolves to a blocked network address.");
  }
  return [...addresses].sort((a, b) => a.family - b.family || a.address.localeCompare(b.address, "en"))[0]!;
}

function responseHeaders(response: IncomingMessage): { contentType?: string; contentLength?: number; encoding?: string } {
  const contentType = typeof response.headers["content-type"] === "string"
    ? response.headers["content-type"].slice(0, 200)
    : undefined;
  const rawLength = response.headers["content-length"];
  const contentLength = typeof rawLength === "string" && /^\d+$/u.test(rawLength) ? Number(rawLength) : undefined;
  const encoding = typeof response.headers["content-encoding"] === "string"
    ? response.headers["content-encoding"].trim().toLowerCase()
    : undefined;
  return { contentType, contentLength, encoding };
}

interface RemoteBody {
  response: IncomingMessage;
  finalUrl: string;
  statusCode: number;
  contentType?: string;
  cleanup: () => void;
}

async function openRemoteBody(urlValue: string, options: SafeRemoteFetchOptions): Promise<RemoteBody> {
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 3, 5));
  const allowedPorts = options.allowedPorts?.filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535) ?? [80, 443];
  const deadline = Date.now() + options.timeoutMs;
  let current = validatedUrl(urlValue, allowedPorts);
  let headers = sanitizedHeaders(options.headers);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options.signal?.aborted) throw remoteError(504, "REMOTE_TIMEOUT", "The remote media request was cancelled.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw remoteError(504, "REMOTE_TIMEOUT", "The remote media request timed out.");
    const pinned = await resolvePublic(current.hostname, remaining);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));

    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const requestOptions: RequestOptions = {
          protocol: current.protocol,
          hostname: current.hostname,
          port: current.port || undefined,
          path: `${current.pathname}${current.search}`,
          method: "GET",
          headers,
          signal: controller.signal,
          maxHeaderSize: 32 * 1024,
          lookup: (_hostname, _lookupOptions, callback) => callback(null, pinned.address, pinned.family),
        };
        const request = (current.protocol === "https:" ? httpsRequest : httpRequest)(requestOptions, resolve);
        request.setTimeout(Math.min(options.idleTimeoutMs ?? 15_000, Math.max(1, deadline - Date.now())), () => {
          request.destroy(new Error("REMOTE_IDLE_TIMEOUT"));
        });
        request.on("error", reject);
        request.end();
      });
      const statusCode = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(statusCode)) {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
        const location = response.headers.location;
        response.destroy();
        if (!location || hop >= maxRedirects) {
          throw remoteError(502, "REMOTE_REDIRECT_BLOCKED", "The remote media redirect chain is invalid or too long.");
        }
        const next = validatedUrl(new URL(location, current).toString(), allowedPorts);
        if (next.origin !== current.origin) {
          const { origin: _origin, referer: _referer, ...remainingHeaders } = headers;
          headers = remainingHeaders;
        }
        current = next;
        continue;
      }
      if (statusCode < 200 || statusCode >= 300 || statusCode === 206) {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
        response.destroy();
        throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media server did not return a complete successful response.");
      }
      const metadata = responseHeaders(response);
      if (metadata.encoding && metadata.encoding !== "identity") {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
        response.destroy();
        throw remoteError(502, "REMOTE_FETCH_FAILED", "Compressed remote media responses are not accepted.");
      }
      if (metadata.contentLength !== undefined && metadata.contentLength > options.maxBytes) {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
        response.destroy();
        throw remoteError(413, "REMOTE_TOO_LARGE", "The remote media exceeds the configured byte limit.");
      }
      return {
        response,
        finalUrl: current.toString(),
        statusCode,
        contentType: metadata.contentType,
        cleanup: () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abortFromCaller);
        },
      };
    } catch (error) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted || /timeout/iu.test(error instanceof Error ? error.message : String(error))) {
        throw remoteError(504, "REMOTE_TIMEOUT", "The remote media request timed out.");
      }
      throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media request failed.");
    }
  }
  throw remoteError(502, "REMOTE_REDIRECT_BLOCKED", "The remote media redirect chain is too long.");
}

export async function fetchRemoteBuffer(url: string, options: SafeRemoteFetchOptions): Promise<Buffer> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw remoteError(500, "REMOTE_FETCH_CONFIG_INVALID", "The remote fetch limits are invalid.");
  }
  const remote = await openRemoteBody(url, options);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of remote.response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        remote.response.destroy();
        throw remoteError(413, "REMOTE_TOO_LARGE", "The remote media exceeds the configured byte limit.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media response ended unexpectedly.");
  } finally {
    remote.cleanup();
  }
}

export async function fetchRemoteToFile(
  url: string,
  destinationPath: string,
  options: SafeRemoteFetchOptions,
): Promise<SafeRemoteFileResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw remoteError(500, "REMOTE_FETCH_CONFIG_INVALID", "The remote fetch limits are invalid.");
  }
  const remote = await openRemoteBody(url, options);
  const output = createWriteStream(destinationPath, {
    flags: options.overwrite ? "w" : "wx",
    mode: 0o600,
  });
  let bytes = 0;
  try {
    await once(output, "open");
    for await (const value of remote.response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        remote.response.destroy();
        throw remoteError(413, "REMOTE_TOO_LARGE", "The remote media exceeds the configured byte limit.");
      }
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
    return {
      bytes,
      contentType: remote.contentType,
      statusCode: remote.statusCode,
      finalUrl: remote.finalUrl,
    };
  } catch (error) {
    output.destroy();
    remote.response.destroy();
    await rm(destinationPath, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw remoteError(502, "REMOTE_FETCH_FAILED", "The remote media response could not be stored safely.");
  } finally {
    remote.cleanup();
  }
}
