import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error", listener: (event: { data?: unknown }) => void): void;
}

type SocketConstructor = new (url: string) => SocketLike;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
}

interface CdpResponseBody {
  body: string;
  base64Encoded?: boolean;
}

interface BrowserTabState {
  href: string;
  title: string;
  userAgent: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

export class DouyinBrowserFallbackError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DouyinBrowserFallbackError";
  }
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(message: CdpMessage) => void>();
  private readonly socket: SocketLike;

  private constructor(socket: SocketLike) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        return;
      }

      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message ?? "Chrome DevTools request failed."));
          else pending.resolve(message.result);
        }
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  public static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const Socket = (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket;
    if (!Socket) throw new DouyinBrowserFallbackError("The local runtime does not provide a WebSocket client for the browser fallback.");

    const socket = new Socket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools.")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Chrome DevTools closed the browser connection."));
      });
    });
    return new CdpConnection(socket);
  }

  public onMessage(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools request timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  public close(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.socket.close();
  }
}

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not reserve a local browser debugging port.");
  return port;
}

function executableOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveBrowserExecutable(explicitPath?: string): string | null {
  const candidates = [
    explicitPath,
    process.env.JUNVIDEO_BROWSER_PATH,
    process.platform === "win32" && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "win32" && process.env["PROGRAMFILES(X86)"]
      ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "win32" && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
      : undefined,
    executableOnPath(process.platform === "win32" ? "chrome.exe" : "google-chrome"),
    executableOnPath(process.platform === "win32" ? "msedge.exe" : "chromium"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function urlList(value: unknown): string[] {
  const urls = asRecord(value).url_list;
  if (!Array.isArray(urls)) return [];
  return urls.flatMap((candidate) => {
    const url = asString(candidate);
    if (!url) return [];
    try {
      const normalized = new URL(url.startsWith("//") ? `https:${url}` : url);
      return normalized.protocol === "http:" || normalized.protocol === "https:" ? [normalized.toString()] : [];
    } catch {
      return [];
    }
  });
}

function directMediaUrls(value: unknown): string[] {
  return urlList(value).filter((url) => {
    try {
      return new URL(url).hostname.toLowerCase() !== "www.douyin.com";
    } catch {
      return false;
    }
  });
}

function firstUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const urls = directMediaUrls(value);
    if (urls[0]) return urls[0];
  }
  return null;
}

function pageStateFromRuntime(value: unknown): BrowserTabState | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      href: asString(parsed.href) ?? "",
      title: asString(parsed.title) ?? "",
      userAgent: asString(parsed.userAgent) ?? DEFAULT_USER_AGENT,
      videoUrl: asString(parsed.videoUrl),
      thumbnailUrl: asString(parsed.thumbnailUrl),
    };
  } catch {
    return null;
  }
}

async function readPageState(connection: CdpConnection, sessionId: string): Promise<BrowserTabState | null> {
  const result = await connection.send(
    "Runtime.evaluate",
    {
      expression: `JSON.stringify({
        href: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        videoUrl: [...document.querySelectorAll("video")]
          .map((video) => video.currentSrc || video.src)
          .find((url) => url && !url.includes("uuu_265.mp4")) || null,
        thumbnailUrl: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || null,
      })`,
      returnByValue: true,
    },
    sessionId,
  ) as { result?: { value?: unknown } };
  return pageStateFromRuntime(result.result?.value);
}

function addVideoFormats(
  formats: Record<string, unknown>[],
  source: unknown,
  sourceName: string,
  video: Record<string, unknown>,
  pageUrl: string,
  userAgent: string,
): void {
  const sourceRecord = asRecord(source);
  const urls = directMediaUrls(sourceRecord);
  const width = asNumber(sourceRecord.width) ?? asNumber(video.width);
  const height = asNumber(sourceRecord.height) ?? asNumber(video.height);
  const fps = asNumber(sourceRecord.fps) ?? asNumber(video.fps);
  const filesize = asNumber(sourceRecord.data_size);
  const rawBitrate = asNumber(video.bit_rate) ?? asNumber(video.bitrate);
  const bitrateKbps = rawBitrate !== null ? rawBitrate > 10_000 ? rawBitrate / 1_000 : rawBitrate : null;
  const codec = video.is_h265 === true ? "h265" : "h264";
  urls.forEach((url, index) => {
    formats.push({
      url,
      format_id: `browser-${sourceName}-${index}`,
      ext: "mp4",
      mime: "video/mp4",
      width,
      height,
      ...(fps !== null ? { fps } : {}),
      filesize,
      ...(bitrateKbps !== null ? { tbr: bitrateKbps } : {}),
      format_note: sourceName === "download" ? "Browser download stream" : "Browser playback stream",
      vcodec: codec,
      acodec: "aac",
      http_headers: { Referer: pageUrl, "User-Agent": userAgent },
    });
  });
}

function addAudioFormats(
  formats: Record<string, unknown>[],
  source: unknown,
  sourceName: string,
  pageUrl: string,
  userAgent: string,
): void {
  directMediaUrls(source).forEach((url, index) => {
    formats.push({
      url,
      format_id: `browser-${sourceName}-${index}`,
      ext: url.includes(".mp3") ? "mp3" : "m4a",
      mime: url.includes(".mp3") ? "audio/mpeg" : "audio/mp4",
      format_note: "Browser audio stream",
      vcodec: "none",
      acodec: url.includes(".mp3") ? "mp3" : "aac",
      http_headers: { Referer: pageUrl, "User-Agent": userAgent },
    });
  });
}

function buildYtDlpInfo(
  detail: Record<string, unknown>,
  pageUrl: string,
  pageState: BrowserTabState | null,
): Record<string, unknown> {
  const video = asRecord(detail.video);
  const author = asRecord(detail.author);
  const music = asRecord(detail.music);
  const formats: Record<string, unknown>[] = [];
  const userAgent = pageState?.userAgent ?? DEFAULT_USER_AGENT;
  addVideoFormats(formats, video.play_addr, "play", video, pageUrl, userAgent);
  addVideoFormats(formats, video.play_addr_h264, "h264", video, pageUrl, userAgent);
  addVideoFormats(formats, video.download_addr, "download", video, pageUrl, userAgent);
  const bitRates = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  bitRates.forEach((value, index) => {
    const bitrate = asRecord(value);
    addVideoFormats(formats, bitrate.play_addr, `quality-${index}`, { ...video, ...bitrate }, pageUrl, userAgent);
  });
  addAudioFormats(formats, video.audio, "audio", pageUrl, userAgent);
  addAudioFormats(formats, music.play_url, "music", pageUrl, userAgent);

  const durationRaw = asNumber(video.duration) ?? asNumber(detail.duration);
  const thumbnailUrl = firstUrl(video.cover, video.origin_cover, video.dynamic_cover) ?? pageState?.thumbnailUrl ?? null;
  const videoId = asString(detail.aweme_id) ?? pageUrl.match(/\/video\/(\d+)/)?.[1] ?? "unknown";
  const title = asString(detail.desc) ?? pageState?.title ?? `Douyin video ${videoId}`;

  if (pageState?.videoUrl && formats.length === 0) {
    formats.push({
      url: pageState.videoUrl,
      format_id: "browser-dom-video",
      ext: "mp4",
      mime: "video/mp4",
      width: asNumber(video.width),
      height: asNumber(video.height),
      format_note: "Browser playback stream",
      vcodec: "h264",
      acodec: "aac",
      http_headers: { Referer: pageUrl, "User-Agent": userAgent },
    });
  }

  return {
    id: videoId,
    title,
    description: asString(detail.desc),
    uploader: asString(author.nickname) ?? asString(author.unique_id),
    duration: durationRaw === null ? null : durationRaw > 1_000 ? durationRaw / 1_000 : durationRaw,
    thumbnail: thumbnailUrl,
    webpage_url: pageUrl,
    extractor: "douyin-browser-cdp",
    formats,
    browserFallback: true,
  };
}

async function waitForDevtools(port: number, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const value = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof value.webSocketDebuggerUrl === "string") return { webSocketDebuggerUrl: value.webSocketDebuggerUrl };
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chrome did not expose its local DevTools endpoint in time.");
}

export async function extractDouyinInfoWithBrowser(
  pageUrl: string,
  options: { executablePath?: string; timeoutMs: number },
): Promise<Record<string, unknown>> {
  const executablePath = resolveBrowserExecutable(options.executablePath);
  if (!executablePath) {
    throw new DouyinBrowserFallbackError(
      "No Chrome or Edge executable was found for the optional Douyin browser fallback. Configure JUNVIDEO_BROWSER_PATH to enable it.",
    );
  }

  const userDataDir = await mkdtemp(join(tmpdir(), "junvideo-douyin-"));
  const port = await reserveLocalPort();
  let browserProcess: ChildProcess | null = null;
  let connection: CdpConnection | null = null;
  let sessionId: string | null = null;
  let removeListener: (() => void) | null = null;

  try {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ];
    if (process.platform !== "win32") args.push("--no-sandbox");
    browserProcess = spawn(executablePath, args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });

    const devtools = await waitForDevtools(port, Math.min(options.timeoutMs, 10_000));
    connection = await CdpConnection.connect(devtools.webSocketDebuggerUrl, Math.min(options.timeoutMs, 10_000));
    const target = await connection.send("Target.createTarget", { url: "about:blank" }) as { targetId?: string };
    if (!target.targetId) throw new Error("Chrome did not create a page target.");
    const attached = await connection.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }) as { sessionId?: string };
    sessionId = attached.sessionId ?? null;
    if (!sessionId) throw new Error("Chrome did not attach the page target.");

    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send("Network.enable", {}, sessionId);

    const detailResponses = new Map<string, { requestId: string; url: string; status: number }>();
    const completedRequests = new Set<string>();
    removeListener = connection.onMessage((message) => {
      if (message.sessionId !== sessionId || !message.method) return;
      const params = message.params ?? {};
      if (message.method === "Network.responseReceived") {
        const response = asRecord(params.response);
        const url = asString(response.url);
        const requestId = asString(params.requestId);
        if (url?.includes("/aweme/v1/web/aweme/detail/") && requestId) {
          detailResponses.set(requestId, {
            requestId,
            url,
            status: asNumber(response.status) ?? 0,
          });
        }
      } else if (message.method === "Network.loadingFinished") {
        const requestId = asString(params.requestId);
        if (requestId) completedRequests.add(requestId);
      }
    });

    await connection.send("Page.navigate", { url: pageUrl }, sessionId);
    const deadline = Date.now() + options.timeoutMs;
    let pageState: BrowserTabState | null = null;
    let detail: Record<string, unknown> | null = null;

    while (Date.now() < deadline) {
      for (const [requestId, response] of detailResponses) {
        if (!completedRequests.has(requestId)) continue;
        try {
          const body = await connection.send("Network.getResponseBody", { requestId }, sessionId) as CdpResponseBody;
          const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const candidate = asRecord(parsed.aweme_detail);
          if (candidate.aweme_id || candidate.video) {
            detail = candidate;
            break;
          }
        } catch {
          // The page can issue more than one detail request. Try the next completed response.
        }
      }

      pageState = await readPageState(connection, sessionId).catch(() => pageState);
      if (detail && (directMediaUrls(asRecord(detail.video).play_addr).length > 0 || pageState?.videoUrl)) break;
      if (pageState?.videoUrl && detail) break;
      await sleep(400);
    }

    if (!detail) {
      throw new DouyinBrowserFallbackError(
        "The public Douyin page opened, but no media metadata response was available. The page may be temporarily restricted or require an interactive verification step.",
      );
    }
    const normalizedPageState = pageState ?? { href: pageUrl, title: "", userAgent: DEFAULT_USER_AGENT, videoUrl: null, thumbnailUrl: null };
    const info = buildYtDlpInfo(detail, normalizedPageState.href || pageUrl, normalizedPageState);
    const formatList = Array.isArray(info.formats) ? info.formats : [];
    if (formatList.length === 0) {
      throw new DouyinBrowserFallbackError("The public Douyin page loaded, but it exposed no safe video or audio stream.");
    }
    return info;
  } catch (error) {
    if (error instanceof DouyinBrowserFallbackError) throw error;
    throw new DouyinBrowserFallbackError(
      `The optional Douyin browser fallback could not read this page: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    removeListener?.();
    if (connection && sessionId) await connection.send("Browser.close").catch(() => undefined);
    connection?.close();
    browserProcess?.kill();
    await sleep(100);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
