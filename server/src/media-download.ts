import { readdir, rm, stat, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "./errors.js";
import { formatSelectorFor, type MediaFormat } from "./parser.js";
import { runProcess } from "./process.js";
import type { AppConfig } from "./config.js";

export interface PreparedMediaFile {
  filePath: string;
  workDir: string;
  contentType: string;
  extension: string;
}

type YtDlpDownloadConfig = Pick<
  AppConfig,
  | "ytdlpCookiesFile"
  | "ytdlpCookiesFromBrowser"
  | "ytdlpRetries"
  | "ytdlpExtractorRetries"
  | "ytdlpFragmentRetries"
  | "ytdlpSocketTimeoutMs"
  | "ffmpegPath"
>;

function downloadCommonArgs(appConfig: YtDlpDownloadConfig): string[] {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--no-progress",
    "--retries", String(appConfig.ytdlpRetries),
    "--extractor-retries", String(appConfig.ytdlpExtractorRetries),
    "--fragment-retries", String(appConfig.ytdlpFragmentRetries),
    "--socket-timeout", String(Math.ceil(appConfig.ytdlpSocketTimeoutMs / 1_000)),
  ];
  if (appConfig.ytdlpCookiesFile) args.push("--cookies", appConfig.ytdlpCookiesFile);
  if (appConfig.ytdlpCookiesFromBrowser) args.push("--cookies-from-browser", appConfig.ytdlpCookiesFromBrowser);
  return args;
}

export function buildYtDlpDownloadArgs(
  sourceUrl: string,
  format: MediaFormat,
  outputTemplate: string,
  appConfig: YtDlpDownloadConfig,
  kind: "video" | "audio" = "video",
): string[] {
  const selector = formatSelectorFor(format);
  if (!selector) {
    throw new AppError(
      422,
      kind === "video" ? "MEDIA_MUX_UNAVAILABLE" : "AUDIO_FORMAT_UNAVAILABLE",
      kind === "video"
        ? "This video has separate streams, but no safe companion audio format was retained."
        : "The parsed result does not contain a safe audio format selector.",
      { action: "Run the parse again so JunVideo can obtain a fresh media selection." },
    );
  }

  const postProcessArgs = kind === "video"
    ? ["--merge-output-format", "mp4", "--ffmpeg-location", appConfig.ffmpegPath]
    : [];

  return [
    ...downloadCommonArgs(appConfig),
    "--format", selector,
    ...postProcessArgs,
    "--no-part",
    "--no-mtime",
    "--output", outputTemplate,
    "--", sourceUrl,
  ];
}

async function removeWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Re-resolve and download a video through yt-dlp instead of trusting the
 * expiring stream URL returned by the metadata request. yt-dlp can select a
 * muxed format directly or merge separate video/audio formats with ffmpeg.
 */
async function downloadMediaWithYtDlp(
  sourceUrl: string,
  format: MediaFormat,
  appConfig: AppConfig,
  kind: "video" | "audio",
): Promise<PreparedMediaFile> {
  if (kind === "video" && !format.hasVideo) {
    throw new AppError(422, "VIDEO_STREAM_NOT_FOUND", "The selected media format does not contain a video stream.");
  }
  if (kind === "audio" && !format.hasAudio) {
    throw new AppError(422, "AUDIO_STREAM_NOT_FOUND", "The selected media format does not contain an audio stream.");
  }

  const workDir = await mkdtemp(join(tmpdir(), "junvideo-download-"));
  const outputTemplate = join(workDir, "media.%(ext)s");
  const args = buildYtDlpDownloadArgs(sourceUrl, format, outputTemplate, appConfig, kind);

  try {
    let result;
    try {
      result = await runProcess(
        appConfig.ytdlpPath,
        args,
        appConfig.mediaDownloadTimeoutMs,
        8 * 1024 * 1024,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/enoent|not found|cannot find/i.test(message)) {
        throw new AppError(503, "MEDIA_DOWNLOAD_UNAVAILABLE", `yt-dlp could not be started for this ${kind} download: ${message}`, {
          action: "Install yt-dlp and configure YTDLP_PATH, then retry.",
        });
      }
      throw new AppError(502, "MEDIA_DOWNLOAD_FAILED", `yt-dlp could not download this ${kind}.`, {
        action: "Run the parse again to obtain a fresh media selection and retry.",
        details: { cause: message.slice(0, 500) },
      });
    }

    if (result.exitCode !== 0) {
      const diagnostic = result.stderr.trim().slice(-2_000);
      if (kind === "video" && /ffmpeg.*(?:not found|not available|could not be found)/i.test(diagnostic)) {
        throw new AppError(503, "MEDIA_MUX_UNAVAILABLE", "ffmpeg is required to merge the selected video and audio streams.", {
          action: "Install ffmpeg and set FFMPEG_PATH, then retry.",
        });
      }
      throw new AppError(502, "MEDIA_DOWNLOAD_FAILED", kind === "video"
        ? "yt-dlp could not download and merge this video."
        : "yt-dlp could not download the audio stream.", {
        action: "Run the parse again to obtain a fresh media selection and retry.",
        details: { exitCode: result.exitCode, diagnostic: diagnostic || "No diagnostic was returned by yt-dlp." },
      });
    }

    const files = await readdir(workDir);
    const candidates: Array<{ path: string; size: number }> = [];
    for (const file of files) {
      if (file.endsWith(".part") || file.endsWith(".ytdl")) continue;
      const filePath = join(workDir, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (fileStat?.isFile() && fileStat.size > 0) candidates.push({ path: filePath, size: fileStat.size });
    }
    const output = candidates.sort((a, b) => b.size - a.size)[0];
    if (!output) {
      throw new AppError(502, "MEDIA_DOWNLOAD_EMPTY", "yt-dlp completed without producing a media file.", {
        action: "Run the parse again and retry the download.",
      });
    }

    return {
      filePath: output.path,
      workDir,
      contentType: kind === "video"
        ? "video/mp4"
        : (format.mimeType?.startsWith("audio/") ? format.mimeType : "audio/mp4"),
      extension: kind === "video" ? "mp4" : output.path.split(".").pop()?.toLowerCase() || "audio",
    };
  } catch (error) {
    await removeWorkDir(workDir);
    throw error;
  }
}

export function downloadVideoWithYtDlp(
  sourceUrl: string,
  format: MediaFormat,
  appConfig: AppConfig,
): Promise<PreparedMediaFile> {
  return downloadMediaWithYtDlp(sourceUrl, format, appConfig, "video");
}

export function downloadAudioWithYtDlp(
  sourceUrl: string,
  format: MediaFormat,
  appConfig: AppConfig,
): Promise<PreparedMediaFile> {
  return downloadMediaWithYtDlp(sourceUrl, format, appConfig, "audio");
}

// Kept as a small compatibility alias for callers that used the initial
// separate-stream implementation name.
export const downloadMuxedVideo = downloadVideoWithYtDlp;

export async function cleanupPreparedMedia(file: PreparedMediaFile): Promise<void> {
  await removeWorkDir(file.workDir);
}
