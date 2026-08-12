import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { MediaFormat } from "./parser.js";
import { config, type AppConfig } from "./config.js";
import { TranscriptionFailedError, TranscriptionUnavailableError } from "./errors.js";
import { runProcess } from "./process.js";
import { cleanupPreparedMedia, downloadAudioWithYtDlp, type PreparedMediaFile } from "./media-download.js";

export interface TranscriptResult {
  rawText: string;
  correctedText: string;
  language: string;
  model: string;
  correctionMode: "rules" | "openai" | "none";
}

export function resolveTranscriptionLanguage(value?: string): string {
  return value?.trim() || "auto";
}

const CORRECTION_RULES: ReadonlyArray<readonly [string, string]> = [
  ["克服", "客服"],
  ["富盘", "复盘"],
  ["利益变", "裂变"],
  ["绛夊悓", "抖音"],
  ["等于", "抖音"],
];

export function correctTranscript(text: string): string {
  let corrected = text.trim();
  for (const [wrong, right] of CORRECTION_RULES) corrected = corrected.split(wrong).join(right);
  return corrected.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

async function correctWithOpenAi(text: string, appConfig: AppConfig): Promise<string> {
  if (!appConfig.openAiApiKey) {
    throw new TranscriptionUnavailableError("CORRECTION_MODE=openai requires OPENAI_API_KEY.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(appConfig.transcriptionTimeoutMs, 120_000));
  try {
    const response = await fetch(`${appConfig.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appConfig.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: appConfig.openAiCorrectionModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "你是中文口播稿校对器。只修正明显的同音字、错别字、断句和重复空格，保留原意、语气、顺序和口语表达。只输出校正后的正文，不要解释。",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Correction API returned HTTP ${response.status}.`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const corrected = stringValue(payload.choices?.[0]?.message?.content);
    if (!corrected) throw new Error("Correction API returned empty text.");
    return corrected;
  } catch (error) {
    if (error instanceof TranscriptionUnavailableError) throw error;
    throw new TranscriptionFailedError("AI correction failed after transcription completed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

export function buildFfmpegArgs(format: MediaFormat, outputPath: string): string[] {
  const headers = Object.entries(format.httpHeaders)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return buildFfmpegInputArgs(format.url, outputPath, headers);
}

export function buildFfmpegFileArgs(inputPath: string, outputPath: string): string[] {
  return buildFfmpegInputArgs(inputPath, outputPath);
}

export function buildWhisperArgs(
  scriptPath: string,
  audioPath: string,
  model: string,
  language: string,
  ffmpegPath: string,
): string[] {
  return [
    scriptPath,
    "--audio", audioPath,
    "--model", model,
    "--language", language,
    "--ffmpeg-path", ffmpegPath,
  ];
}

function buildFfmpegInputArgs(inputPath: string, outputPath: string, headers = ""): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    ...(headers ? ["-headers", `${headers}\r\n`] : []),
    "-i", inputPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    "-y",
    outputPath,
  ];
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Whisper returned no JSON transcript.");
  const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Whisper returned invalid transcript data.");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class TranscriptService {
  public constructor(private readonly appConfig: AppConfig = config) {}

  public async transcribeFormat(
    format: MediaFormat,
    options: { language?: string; model?: string } = {},
    sourceUrl?: string,
  ): Promise<TranscriptResult> {
    if (!this.appConfig.transcriptionEnabled) {
      throw new TranscriptionUnavailableError("Transcription is disabled by TRANSCRIPTION_ENABLED=false.");
    }

    // Let Whisper detect the language unless the caller explicitly selects
    // one. This keeps an English video from being forced through Chinese
    // decoding while preserving explicit language control for the API.
    const language = resolveTranscriptionLanguage(options.language);
    const model = options.model?.trim() || this.appConfig.whisperModel;
    const workDir = join(tmpdir(), `junvideo-transcribe-${randomUUID()}`);
    const audioPath = join(workDir, "audio.wav");
    const scriptPath = join(process.cwd(), "scripts", "transcribe_audio.py");
    let preparedAudio: PreparedMediaFile | undefined;
    await mkdir(workDir, { recursive: true });

    try {
      if (sourceUrl) preparedAudio = await downloadAudioWithYtDlp(sourceUrl, format, this.appConfig);
      let audioResult;
      try {
        audioResult = await runProcess(
          this.appConfig.ffmpegPath,
          preparedAudio ? buildFfmpegFileArgs(preparedAudio.filePath, audioPath) : buildFfmpegArgs(format, audioPath),
          this.appConfig.transcriptionTimeoutMs,
          2 * 1024 * 1024,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/enoent|not found|cannot find/i.test(message)) {
          throw new TranscriptionUnavailableError(`ffmpeg could not be started: ${message}`);
        }
        throw new TranscriptionFailedError("ffmpeg could not extract audio from this media URL.", { cause: message.slice(0, 500) });
      }
      if (audioResult.exitCode !== 0) {
        throw new TranscriptionFailedError("ffmpeg could not extract audio from this media URL.", {
          diagnostic: audioResult.stderr.trim().slice(-2_000),
        });
      }
      const audioStats = await stat(audioPath).catch(() => null);
      if (!audioStats || audioStats.size <= 0) {
        throw new TranscriptionFailedError("ffmpeg produced an empty audio stream.");
      }
      if (audioStats.size > this.appConfig.transcriptionMaxBytes) {
        throw new TranscriptionFailedError("The extracted audio is larger than the configured transcription limit.", {
          maxBytes: this.appConfig.transcriptionMaxBytes,
        });
      }

      let whisperResult;
      try {
        whisperResult = await runProcess(
          this.appConfig.pythonPath,
          buildWhisperArgs(scriptPath, audioPath, model, language, this.appConfig.ffmpegPath),
          this.appConfig.transcriptionTimeoutMs,
          4 * 1024 * 1024,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/enoent|not found|cannot find/i.test(message)) {
          throw new TranscriptionUnavailableError(`Python could not be started: ${message}`);
        }
        throw new TranscriptionFailedError("Whisper could not transcribe this audio.", { cause: message.slice(0, 500) });
      }
      if (whisperResult.exitCode !== 0) {
        if (/no module named ['\"]?whisper|modulenotfounderror/i.test(whisperResult.stderr)) {
          throw new TranscriptionUnavailableError("Python package openai-whisper is not installed.");
        }
        throw new TranscriptionFailedError("Whisper could not transcribe this audio.", {
          diagnostic: whisperResult.stderr.trim().slice(-2_000),
        });
      }

      let payload: Record<string, unknown>;
      try {
        payload = parseJsonOutput(whisperResult.stdout);
      } catch (error) {
        throw new TranscriptionFailedError("Whisper returned an invalid transcript.", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      const rawText = stringValue(payload.text);
      if (!rawText) throw new TranscriptionFailedError("No spoken text was detected in this video.");
      const detectedLanguage = stringValue(payload.language) || language;
      let correctedText = rawText;
      let correctionMode: TranscriptResult["correctionMode"] = "none";
      if (this.appConfig.correctionMode === "rules") {
        correctedText = correctTranscript(rawText);
        correctionMode = "rules";
      } else if (this.appConfig.correctionMode === "openai") {
        correctedText = await correctWithOpenAi(rawText, this.appConfig);
        correctionMode = "openai";
      }
      return { rawText, correctedText, language: detectedLanguage, model, correctionMode };
    } finally {
      if (preparedAudio) await cleanupPreparedMedia(preparedAudio);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
