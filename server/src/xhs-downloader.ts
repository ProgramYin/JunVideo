import { isSafeRemoteHttpUrl } from "./platform.js";

export class XhsDownloaderAdapterError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XhsDownloaderAdapterError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => asRecord(current)[key], value);
}

function firstString(value: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const candidate = asString(pathValue(value, path));
    if (candidate) return candidate;
  }
  return null;
}

function safeUrl(value: unknown): string | null {
  const candidate = asString(value);
  return candidate && isSafeRemoteHttpUrl(candidate) ? candidate : null;
}

function urlsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => urlsFromValue(item));
  const direct = safeUrl(value);
  return direct ? [direct] : [];
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = asString(item);
    return text ? [text] : [];
  });
}

function endpointFromConfig(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new XhsDownloaderAdapterError("XHS_DOWNLOADER_API_URL is not a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new XhsDownloaderAdapterError("XHS_DOWNLOADER_API_URL must use HTTP or HTTPS.");
  }
  return /\/xhs\/detail$/iu.test(parsed.pathname)
    ? parsed.toString()
    : `${trimmed}/xhs/detail`;
}

function findNote(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const note = findNote(item, depth + 1);
      if (note) return note;
    }
    return null;
  }

  const record = asRecord(value);
  const type = asString(record.type)?.toLowerCase();
  const looksLikeNote = (type === "video" || type === "normal") &&
    (record.video !== undefined || Array.isArray(record.imageList) || record.noteId !== undefined);
  const looksLikeLocalizedNote = firstString(record, ["作品ID", "作品类型"]) !== null
    && Array.isArray(record["下载地址"]);
  if (looksLikeNote || looksLikeLocalizedNote) return record;

  for (const child of Object.values(record)) {
    const note = findNote(child, depth + 1);
    if (note) return note;
  }
  return null;
}

function imageUrlFromItem(value: unknown): string | null {
  const item = asRecord(value);
  const source = firstString(item, ["urlDefault", "url", "urlPre", "urlPrePath"]);
  if (!source) return null;
  const direct = safeUrl(source);
  if (direct) return direct;

  const match = source.match(/(?:https?:)?\/\/[^/]*xhscdn\.com\/\d+\/[0-9a-z]+\/([^!\s]+)!/iu);
  return match?.[1]
    ? `https://ci.xiaohongshu.com/${match[1]}?imageView2/format/jpeg`
    : null;
}

function videoStreamRecords(note: Record<string, unknown>): Record<string, unknown>[] {
  const stream = asRecord(pathValue(note, "video.media.stream"));
  return Object.values(stream).flatMap((value) => Array.isArray(value) ? value.map(asRecord) : [asRecord(value)])
    .filter((value) => Object.keys(value).length > 0);
}

function videoRawFormats(note: Record<string, unknown>): Record<string, unknown>[] {
  const video = asRecord(note.video);
  const rawFormats: Record<string, unknown>[] = [];
  const originKey = asString(pathValue(note, "video.consumer.originVideoKey"));
  if (originKey) {
    rawFormats.push({
      url: `https://sns-video-bd.xhscdn.com/${originKey}`,
      format_id: "xhs-original",
      ext: "mp4",
      mime: "video/mp4",
      format_note: "Original",
      vcodec: "h264",
      acodec: "aac",
    });
  }

  const streams = videoStreamRecords(note);
  streams.forEach((stream, index) => {
    const url = safeUrl(stream.backupUrls instanceof Array ? stream.backupUrls[0] : undefined)
      ?? safeUrl(stream.masterUrl)
      ?? safeUrl(stream.url);
    if (!url) return;
    const rawBitrate = asNumber(stream.videoBitrate) ?? asNumber(stream.bitrate);
    const bitrateKbps = rawBitrate === null ? null : rawBitrate > 10_000 ? rawBitrate / 1_000 : rawBitrate;
    rawFormats.push({
      url,
      format_id: `xhs-stream-${index}`,
      ext: "mp4",
      mime: "video/mp4",
      width: asNumber(stream.width),
      height: asNumber(stream.height),
      fps: asNumber(stream.fps),
      ...(bitrateKbps !== null ? { tbr: bitrateKbps } : {}),
      filesize: asNumber(stream.size),
      format_note: asString(stream.qualityType) ?? "XHS video stream",
      vcodec: "h264",
      acodec: "aac",
    });
  });

  const directVideoValues = [
    video.url,
    video.playUrl,
    video.play_url,
    video.originUrl,
    video.origin_url,
    pathValue(note, "video.consumer.url"),
  ];
  for (const [index, url] of directVideoValues.flatMap((value) => urlsFromValue(value)).entries()) {
    rawFormats.push({
      url,
      format_id: `xhs-video-${index}`,
      ext: "mp4",
      mime: "video/mp4",
      width: asNumber(video.width),
      height: asNumber(video.height),
      vcodec: "h264",
      acodec: "aac",
      format_note: "XHS video stream",
    });
  }


  if (firstString(note, ["作品类型"]) === "视频") {
    const urls = stringValues(note["下载地址"])
      .map(safeUrl)
      .filter((value): value is string => Boolean(value));
    for (const [index, url] of urls.entries()) {
      rawFormats.push({
        url,
        format_id: `xhs-video-${index}`,
        ext: "mp4",
        mime: "video/mp4",
        vcodec: "h264",
        acodec: "aac",
        format_note: "XHS video stream",
      });
    }
  }
  return rawFormats;
}

function imageRawFormats(note: Record<string, unknown>): Record<string, unknown>[] {
  const imageList = Array.isArray(note.imageList) ? note.imageList : [];
  const nested: Array<{ url: string; width: number | null; height: number | null }> = imageList.flatMap((value) => {
    const item = asRecord(value);
    const url = imageUrlFromItem(item);
    return url ? [{
      url,
      width: asNumber(item.width),
      height: asNumber(item.height),
    }] : [];
  });
  const localized: Array<{ url: string; width: number | null; height: number | null }> = firstString(note, ["作品类型"]) === "图文"
    ? stringValues(note["下载地址"])
        .map(safeUrl)
        .filter((value): value is string => Boolean(value))
        .map((url) => ({ url, width: null, height: null }))
    : [];
  const source = localized.length > 0 ? localized : nested;
  const seen = new Set<string>();
  return source.flatMap((item, index) => {
    if (seen.has(item.url)) return [];
    seen.add(item.url);
    return [{
      url: item.url,
      format_id: `image-${index + 1}`,
      ext: "jpg",
      mime: "image/jpeg",
      width: item.width,
      height: item.height,
      format_note: `Image ${index + 1}`,
    }];
  });
}

function audioRawFormats(note: Record<string, unknown>): Record<string, unknown>[] {
  const audioSources = [note.audio, note.music, pathValue(note, "video.audio"), pathValue(note, "video.music")];
  const urls = audioSources.flatMap((value) => {
    const record = asRecord(value);
    return [record.url, record.playUrl, record.play_url, record.urlList, record.url_list]
      .flatMap((candidate) => urlsFromValue(candidate));
  });
  return urls.map((url, index) => ({
    url,
    format_id: `xhs-audio-${index}`,
    ext: url.toLowerCase().includes(".mp3") ? "mp3" : "m4a",
    mime: url.toLowerCase().includes(".mp3") ? "audio/mpeg" : "audio/mp4",
    vcodec: "none",
    acodec: "aac",
    format_note: "XHS audio stream",
  }));
}

function buildYtDlpInfo(payload: unknown, pageUrl: string): Record<string, unknown> {
  const note = findNote(payload) ?? asRecord(payload);
  const title = firstString(note, ["title", "displayTitle", "作品标题", "desc", "作品描述"]) ?? "Xiaohongshu note";
  const imageFormats = imageRawFormats(note);
  const thumbnail = safeUrl(imageFormats[0]?.url)
    ?? (Array.isArray(note.imageList)
      ? note.imageList.map((item) => imageUrlFromItem(item)).find(Boolean) ?? null
      : firstString(note, ["cover", "coverUrl", "image"]));
  const durationRaw = firstString(note, ["video.duration", "duration"]);
  const durationNumber = durationRaw === null ? asNumber(pathValue(note, "video.duration")) ?? asNumber(note.duration) : Number(durationRaw);
  const duration = durationNumber !== null && Number.isFinite(durationNumber)
    ? durationNumber > 1_000 ? durationNumber / 1_000 : durationNumber
    : null;

  return {
    id: firstString(note, ["noteId", "id", "作品ID"]) ?? "unknown",
    title,
    description: asString(note.desc) ?? asString(note.description) ?? asString(note["作品描述"]),
    uploader: firstString(note, ["user.nickname", "user.nickName", "author.nickname", "author.nickName", "作者昵称"]),
    duration,
    thumbnail,
    webpage_url: pageUrl,
    extractor: "xhs-downloader-api",
    formats: [...videoRawFormats(note), ...audioRawFormats(note)],
    image_formats: imageFormats,
    xhsDownloader: true,
  };
}

export async function extractXhsInfoWithDownloader(
  pageUrl: string,
  options: { apiUrl: string; timeoutMs: number; cookie?: string; proxy?: string },
): Promise<Record<string, unknown>> {
  const endpoint = endpointFromConfig(options.apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "JunVideo/1.0",
      },
      body: JSON.stringify({
        url: pageUrl,
        download: false,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.proxy ? { proxy: options.proxy } : {}),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new XhsDownloaderAdapterError(`XHS-Downloader API returned HTTP ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new XhsDownloaderAdapterError("XHS-Downloader API returned invalid JSON.");
    }
    const info = buildYtDlpInfo(payload, pageUrl);
    const hasFormats = Array.isArray(info.formats) && info.formats.length > 0;
    const hasImages = Array.isArray(info.image_formats) && info.image_formats.length > 0;
    if (!hasFormats && !hasImages) {
      throw new XhsDownloaderAdapterError("XHS-Downloader returned no safe media URLs.");
    }
    return info;
  } catch (error) {
    if (error instanceof XhsDownloaderAdapterError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new XhsDownloaderAdapterError(`XHS-Downloader API timed out after ${options.timeoutMs}ms.`);
    }
    throw new XhsDownloaderAdapterError(
      `XHS-Downloader API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
