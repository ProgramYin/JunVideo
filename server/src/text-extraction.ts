import { AppError, TextExtractionUnavailableError, TextTrackNotFoundError } from "./errors.js";
import type { EmbeddedSubtitleService } from "./embedded-subtitle.js";
import type { MediaFormat } from "./parser.js";
import type {
  ExtractedTextResult,
  SubtitleSelectionOptions,
  SubtitleTextService,
} from "./subtitle-text.js";

export interface VideoTextExtractionInput {
  sourceUrl: string;
  subtitleFormats: readonly MediaFormat[];
  videoFormats: readonly MediaFormat[];
  options?: SubtitleSelectionOptions;
  enabled?: boolean;
}

export function serializeExtractedTextResult(
  result: ExtractedTextResult,
  options: { legacy?: boolean; includeTimestamps?: boolean } = {},
): Record<string, unknown> {
  const {
    rawText,
    correctedText,
    model,
    correctionMode,
    segments,
    timestampedText,
    ...modern
  } = result;
  return {
    ...modern,
    ...(options.legacy ? { rawText, correctedText, model, correctionMode } : {}),
    ...(options.includeTimestamps ? { segments, timestampedText } : {}),
  };
}

type SubtitleExtractor = Pick<SubtitleTextService, "extract" | "extractEmbedded">;
type EmbeddedExtractor = Pick<EmbeddedSubtitleService, "extract">;

function mayTryEmbeddedAfter(error: unknown): boolean {
  return error instanceof AppError
    && (error.code === "TEXT_EXTRACTION_FAILED"
      || error.code === "TEXT_TRACK_NOT_FOUND"
      || error.statusCode === 413
      || (error.statusCode === 503 && error.code !== "TEXT_EXTRACTION_UNAVAILABLE"));
}

/**
 * Platform-general, deterministic extraction order:
 * provider text tracks first, then an embedded text stream. Explicit track
 * selection never changes source behind the caller's back.
 */
export async function extractVideoText(
  input: VideoTextExtractionInput,
  subtitleExtractor: SubtitleExtractor,
  embeddedExtractor: EmbeddedExtractor,
): Promise<ExtractedTextResult> {
  if (input.enabled === false) {
    throw new TextExtractionUnavailableError("Deterministic text-track extraction is disabled on this server.");
  }
  const options = input.options ?? {};
  const explicitTrackId = (options.trackId ?? options.formatId)?.trim();
  let externalFailure: unknown;

  if (input.subtitleFormats.length > 0) {
    try {
      return await subtitleExtractor.extract(input.sourceUrl, input.subtitleFormats, options);
    } catch (error) {
      if (explicitTrackId || !mayTryEmbeddedAfter(error)) throw error;
      externalFailure = error;
    }
  } else if (explicitTrackId) {
    throw new TextTrackNotFoundError("The requested subtitle track is not available for this parse job.", {
      requestedTrackId: explicitTrackId,
    });
  }

  try {
    const prepared = await embeddedExtractor.extract(input.videoFormats, { language: options.language });
    return subtitleExtractor.extractEmbedded(prepared);
  } catch (error) {
    // If provider tracks existed but all were stale or malformed, preserve that
    // more actionable failure when the container simply has no text stream.
    if (externalFailure && error instanceof AppError && error.code === "TEXT_TRACK_NOT_FOUND") {
      throw externalFailure;
    }
    throw error;
  }
}
