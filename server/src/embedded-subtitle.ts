import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { AppError, TextTrackNotFoundError, TextTrackTooLargeError } from "./errors.js";
import type { MediaFormat } from "./parser.js";
import { isSafeRemoteHttpUrl } from "./platform.js";
import { runProcess, type ProcessResult } from "./process.js";
import { fetchRemoteToFile } from "./safe-remote-fetch.js";

export const MAX_EMBEDDED_MEDIA_BYTES = 256 * 1024 * 1024;
export const EMBEDDED_SUBTITLE_PROBE_TIMEOUT_MS = 30_000;
export const EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_MS = 120_000;

const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESS_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_PROBE_CANDIDATES = 3;
const PROBE_SIZE_BYTES = 8 * 1024 * 1024;
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "webvtt",
  "ass",
  "ssa",
  "mov_text",
  "text",
  "ttml",
]);
const BITMAP_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "dvb_teletext",
  "xsub",
]);
const SINGLE_FILE_CONTAINER_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "flv",
  "ts",
  "mts",
  "m2ts",
  "mpeg",
  "mpg",
  "3gp",
]);
const STREAMING_EXTENSIONS = new Set(["m3u8", "m3u", "mpd", "ism", "m4s"]);
const LANGUAGE_ALIASES: Record<string, string> = {
  chi: "zh",
  zho: "zh",
  cmn: "zh",
  eng: "en",
  jpn: "ja",
  kor: "ko",
  spa: "es",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  ita: "it",
  por: "pt",
  rus: "ru",
  ara: "ar",
  hin: "hi",
};

export interface EmbeddedSubtitleStream {
  index: number;
  codec: string;
  language: string;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
}

export interface RejectedEmbeddedSubtitleStream {
  index: number;
  codec: string;
  reason: "bitmap" | "unsupported-codec";
}

export interface EmbeddedSubtitleInventory {
  textStreams: EmbeddedSubtitleStream[];
  rejectedStreams: RejectedEmbeddedSubtitleStream[];
}

export interface PreparedEmbeddedSubtitle {
  buffer: Buffer;
  extension: "vtt";
  contentType: "text/vtt; charset=utf-8";
  language: string;
  streamIndex: number;
  streamId: string;
  sourceFormatId: string;
  sourceCodec: string;
}

export interface EmbeddedSubtitleOptions {
  language?: string;
}

type EmbeddedSubtitleConfig = Pick<
  AppConfig,
  "ffprobePath" | "ffmpegPath" | "textExtractionMaxBytes" | "textExtractionTimeoutMs"
>;

export type EmbeddedSubtitleProcessRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes?: number,
) => Promise<ProcessResult>;

interface EmbeddedSubtitleDependencies {
  processRunner?: EmbeddedSubtitleProcessRunner;
}

function normalizedExtension(format: MediaFormat): string | null {
  const declared = format.ext?.trim().toLowerCase().replace(/[^a-z0-9]/gu, "") || "";
  if (declared) return declared;
  try {
    const match = /\.([a-z0-9]{2,8})$/iu.exec(new URL(format.url).pathname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function looksLikeStreamingManifest(format: MediaFormat): boolean {
  const extension = normalizedExtension(format);
  if (extension && STREAMING_EXTENSIONS.has(extension)) return true;
  const mimeType = format.mimeType?.toLowerCase() ?? "";
  if (/mpegurl|dash\+xml|vnd\.apple\.mpegurl/u.test(mimeType)) return true;
  return /(?:\.m3u8?|\.mpd)(?:$|[?#])/iu.test(format.url);
}

function looksLikeSingleFileContainer(format: MediaFormat): boolean {
  const extension = normalizedExtension(format);
  if (extension && SINGLE_FILE_CONTAINER_EXTENSIONS.has(extension)) return true;
  const mimeType = format.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^video\/(?:mp4|quicktime|x-matroska|webm|x-msvideo|x-flv|mp2t|mpeg|3gpp)$/u.test(mimeType);
}

export function isEligibleEmbeddedSubtitleFormat(format: MediaFormat): boolean {
  if (!format.hasVideo || format.mediaType === "audio" || format.mediaType === "image" || format.mediaType === "subtitle") {
    return false;
  }
  if (format.requiresMuxing || !isSafeRemoteHttpUrl(format.url) || looksLikeStreamingManifest(format)) return false;
  if (!looksLikeSingleFileContainer(format)) return false;
  return typeof format.filesize === "number"
    && Number.isFinite(format.filesize)
    && format.filesize > 0
    && format.filesize <= MAX_EMBEDDED_MEDIA_BYTES;
}

function containerPreference(format: MediaFormat): number {
  const extension = normalizedExtension(format);
  if (extension === "mkv" || extension === "webm") return 0;
  if (extension === "mp4" || extension === "m4v" || extension === "mov") return 1;
  return 2;
}

export function rankEmbeddedMediaFormats(formats: readonly MediaFormat[]): MediaFormat[] {
  return formats
    .filter(isEligibleEmbeddedSubtitleFormat)
    .sort((a, b) =>
      containerPreference(a) - containerPreference(b)
      || Number(b.downloadMode === "direct") - Number(a.downloadMode === "direct")
      || (a.filesize as number) - (b.filesize as number)
      || a.id.localeCompare(b.id, "en"));
}

function localInputArgs(inputPath: string, timeoutMs: number): string[] {
  return [
    "-protocol_whitelist", "file",
    "-probesize", String(PROBE_SIZE_BYTES),
    "-analyzeduration", String(timeoutMs * 1_000),
    "-i", inputPath,
  ];
}

export function buildEmbeddedSubtitleProbeArgs(input: MediaFormat | string): string[] {
  const inputPath = typeof input === "string" ? input : input.url;
  if (typeof input !== "string" && !isEligibleEmbeddedSubtitleFormat(input)) {
    throw new AppError(422, "EMBEDDED_SUBTITLE_INPUT_UNSAFE", "The media format is not a bounded, safe single-file input.");
  }
  return [
    "-hide_banner",
    "-v", "error",
    "-nostdin",
    ...localInputArgs(inputPath, EMBEDDED_SUBTITLE_PROBE_TIMEOUT_MS),
    "-select_streams", "s",
    "-show_entries", "stream=index,codec_name,codec_type:stream_tags=language,title:stream_disposition=default,forced",
    "-of", "json",
  ];
}

export function buildEmbeddedSubtitleExtractArgs(
  input: MediaFormat | string,
  streamIndex: number,
  outputPath: string,
  maxOutputBytes: number,
): string[] {
  if (typeof input !== "string" && !isEligibleEmbeddedSubtitleFormat(input)) {
    throw new AppError(422, "EMBEDDED_SUBTITLE_INPUT_UNSAFE", "The media format is not a bounded, safe single-file input.");
  }
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw new AppError(422, "EMBEDDED_SUBTITLE_STREAM_INVALID", "The embedded subtitle stream index is invalid.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new AppError(500, "TEXT_EXTRACTION_LIMIT_INVALID", "The embedded subtitle output limit is invalid.", { expose: false });
  }
  return [
    "-hide_banner",
    "-v", "error",
    "-nostdin",
    ...localInputArgs(typeof input === "string" ? input : input.url, EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_MS),
    "-map", `0:${streamIndex}`,
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-vn",
    "-an",
    "-c:s", "webvtt",
    "-f", "webvtt",
    "-fs", String(maxOutputBytes + 1),
    "-y",
    outputPath,
  ];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integerOf(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function booleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function tagValue(tags: Record<string, unknown> | null, name: string): string | null {
  if (!tags) return null;
  const entry = Object.entries(tags).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" && entry[1].trim() ? entry[1].trim().slice(0, 120) : null;
}

function normalizeLanguage(value: string | null | undefined): string {
  const normalized = (value ?? "und").trim().toLowerCase().replace(/_/gu, "-") || "und";
  const [base, ...rest] = normalized.split("-");
  const aliasedBase = LANGUAGE_ALIASES[base] ?? base;
  return [aliasedBase, ...rest].join("-").slice(0, 80);
}

export function parseEmbeddedSubtitleInventory(stdout: string): EmbeddedSubtitleInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AppError(502, "EMBEDDED_SUBTITLE_PROBE_INVALID", "ffprobe returned invalid subtitle metadata.");
  }
  const root = recordOf(parsed);
  if (!root || !Array.isArray(root.streams)) {
    throw new AppError(502, "EMBEDDED_SUBTITLE_PROBE_INVALID", "ffprobe returned invalid subtitle metadata.");
  }

  const textStreams: EmbeddedSubtitleStream[] = [];
  const rejectedStreams: RejectedEmbeddedSubtitleStream[] = [];
  for (const value of root.streams) {
    const stream = recordOf(value);
    const index = integerOf(stream?.index);
    const codec = typeof stream?.codec_name === "string" ? stream.codec_name.trim().toLowerCase() : "";
    if (!stream || index === null || !codec || (stream.codec_type !== undefined && stream.codec_type !== "subtitle")) continue;
    if (!TEXT_SUBTITLE_CODECS.has(codec)) {
      rejectedStreams.push({ index, codec, reason: BITMAP_SUBTITLE_CODECS.has(codec) ? "bitmap" : "unsupported-codec" });
      continue;
    }
    const tags = recordOf(stream.tags);
    const disposition = recordOf(stream.disposition);
    textStreams.push({
      index,
      codec,
      language: normalizeLanguage(tagValue(tags, "language")),
      title: tagValue(tags, "title"),
      isDefault: booleanFlag(disposition?.default),
      isForced: booleanFlag(disposition?.forced),
    });
  }
  return { textStreams, rejectedStreams };
}

function languageRank(streamLanguage: string, requestedLanguage?: string): number {
  if (!requestedLanguage?.trim()) return 2;
  const requested = normalizeLanguage(requestedLanguage);
  if (streamLanguage === requested) return 0;
  if (streamLanguage.split("-", 1)[0] === requested.split("-", 1)[0]) return 1;
  return 3;
}

export function rankEmbeddedSubtitleStreams(
  streams: readonly EmbeddedSubtitleStream[],
  requestedLanguage?: string,
): EmbeddedSubtitleStream[] {
  return [...streams].sort((a, b) =>
    languageRank(a.language, requestedLanguage) - languageRank(b.language, requestedLanguage)
    || Number(b.isDefault) - Number(a.isDefault)
    || Number(a.isForced) - Number(b.isForced)
    || Number(a.language === "und") - Number(b.language === "und")
    || a.index - b.index);
}

function missingExecutable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /enoent|not found|cannot find/iu.test(message);
}

function diagnosticOf(result: ProcessResult): string {
  return result.stderr.trim().slice(-1_000);
}

export class EmbeddedSubtitleService {
  private readonly processRunner: EmbeddedSubtitleProcessRunner;

  public constructor(
    private readonly appConfig: EmbeddedSubtitleConfig,
    dependencies: EmbeddedSubtitleDependencies = {},
  ) {
    this.processRunner = dependencies.processRunner ?? runProcess;
  }

  public async extract(
    videoFormats: readonly MediaFormat[],
    options: EmbeddedSubtitleOptions = {},
  ): Promise<PreparedEmbeddedSubtitle> {
    const candidates = rankEmbeddedMediaFormats(videoFormats).slice(0, MAX_PROBE_CANDIDATES);
    if (candidates.length === 0) {
      throw new TextTrackNotFoundError("No bounded single-file video is available for embedded subtitle inspection.");
    }

    let successfulProbeCount = 0;
    let bitmapStreamCount = 0;
    let lastProbeDiagnostic = "";
    let textStreamCount = 0;
    for (const format of candidates) {
      const mediaWorkDir = await mkdtemp(join(tmpdir(), "junvideo-embedded-media-"));
      const localMediaPath = join(mediaWorkDir, `media.${normalizedExtension(format) ?? "bin"}`);
      try {
        await fetchRemoteToFile(format.url, localMediaPath, {
          maxBytes: MAX_EMBEDDED_MEDIA_BYTES,
          timeoutMs: Math.min(this.appConfig.textExtractionTimeoutMs * 4, EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_MS),
          idleTimeoutMs: Math.min(this.appConfig.textExtractionTimeoutMs, 30_000),
          maxRedirects: 3,
          headers: format.httpHeaders,
        });
      let probeResult: ProcessResult;
      try {
        probeResult = await this.processRunner(
          this.appConfig.ffprobePath,
          buildEmbeddedSubtitleProbeArgs(localMediaPath),
          EMBEDDED_SUBTITLE_PROBE_TIMEOUT_MS,
          MAX_PROBE_OUTPUT_BYTES,
        );
      } catch (error) {
        if (missingExecutable(error)) {
          throw new AppError(503, "EMBEDDED_SUBTITLE_PROBE_UNAVAILABLE", "ffprobe could not be started.", {
            action: "Install ffprobe and configure FFPROBE_PATH, then retry.",
          });
        }
        lastProbeDiagnostic = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        continue;
      }
      if (probeResult.exitCode !== 0) {
        lastProbeDiagnostic = diagnosticOf(probeResult);
        continue;
      }

      let inventory: EmbeddedSubtitleInventory;
      try {
        inventory = parseEmbeddedSubtitleInventory(probeResult.stdout);
      } catch (error) {
        lastProbeDiagnostic = error instanceof Error ? error.message : String(error);
        continue;
      }
      successfulProbeCount += 1;
      bitmapStreamCount += inventory.rejectedStreams.filter((stream) => stream.reason === "bitmap").length;
      const selectedStreams = rankEmbeddedSubtitleStreams(inventory.textStreams, options.language);
      textStreamCount += selectedStreams.length;
      for (const selected of selectedStreams) {
        try {
          return await this.extractStream(format, selected, localMediaPath);
        } catch (error) {
          if (error instanceof AppError && (error.statusCode === 413 || error.statusCode === 503)) throw error;
          lastProbeDiagnostic = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        }
      }
      } finally {
        await rm(mediaWorkDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (successfulProbeCount === 0) {
      throw new AppError(502, "EMBEDDED_SUBTITLE_PROBE_FAILED", "The bounded media candidates could not be inspected for subtitle streams.", {
        details: { candidateCount: candidates.length, diagnostic: lastProbeDiagnostic || undefined },
      });
    }
    if (bitmapStreamCount > 0) {
      throw new AppError(422, "EMBEDDED_SUBTITLE_BITMAP_UNSUPPORTED", "Only bitmap subtitle streams were found; they cannot be converted to text without OCR.", {
        details: { bitmapStreamCount },
      });
    }
    if (textStreamCount > 0) {
      throw new AppError(502, "EMBEDDED_SUBTITLE_EXTRACTION_FAILED", "The available embedded text subtitle streams could not be extracted.", {
        details: { textStreamCount, diagnostic: lastProbeDiagnostic || undefined },
      });
    }
    throw new TextTrackNotFoundError("No supported embedded text subtitle stream was found.");
  }

  private async extractStream(
    format: MediaFormat,
    stream: EmbeddedSubtitleStream,
    inputPath: string,
  ): Promise<PreparedEmbeddedSubtitle> {
    const workDir = await mkdtemp(join(tmpdir(), "junvideo-embedded-subtitle-"));
    const outputPath = join(workDir, "subtitle.vtt");
    try {
      let result: ProcessResult;
      try {
        result = await this.processRunner(
          this.appConfig.ffmpegPath,
          buildEmbeddedSubtitleExtractArgs(inputPath, stream.index, outputPath, this.appConfig.textExtractionMaxBytes),
          EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_MS,
          MAX_PROCESS_DIAGNOSTIC_BYTES,
        );
      } catch (error) {
        if (missingExecutable(error)) {
          throw new AppError(503, "EMBEDDED_SUBTITLE_EXTRACTION_UNAVAILABLE", "ffmpeg could not be started.", {
            action: "Install ffmpeg and configure FFMPEG_PATH, then retry.",
          });
        }
        throw new AppError(502, "EMBEDDED_SUBTITLE_EXTRACTION_FAILED", "ffmpeg could not extract the embedded text subtitle stream.", {
          details: { cause: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) },
        });
      }
      if (result.exitCode !== 0) {
        throw new AppError(502, "EMBEDDED_SUBTITLE_EXTRACTION_FAILED", "ffmpeg could not extract the embedded text subtitle stream.", {
          details: { exitCode: result.exitCode, diagnostic: diagnosticOf(result) || undefined },
        });
      }
      const outputStat = await stat(outputPath).catch(() => null);
      if (!outputStat?.isFile() || outputStat.size <= 0) {
        throw new AppError(502, "EMBEDDED_SUBTITLE_EXTRACTION_EMPTY", "ffmpeg produced no embedded subtitle text.");
      }
      if (outputStat.size > this.appConfig.textExtractionMaxBytes) {
        throw new TextTrackTooLargeError(this.appConfig.textExtractionMaxBytes, outputStat.size);
      }
      const buffer = await readFile(outputPath);
      return {
        buffer,
        extension: "vtt",
        contentType: "text/vtt; charset=utf-8",
        language: stream.language,
        streamIndex: stream.index,
        streamId: `embedded-${format.id}-${stream.index}`,
        sourceFormatId: format.id,
        sourceCodec: stream.codec,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
