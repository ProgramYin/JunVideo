import type { ErrorRequestHandler, Request, Response } from "express";
import { ZodError } from "zod";

export type ErrorDetails = Record<string, unknown> | undefined;

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly action?: string;
  public readonly details?: ErrorDetails;
  public readonly expose: boolean;

  public constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { action?: string; details?: ErrorDetails; expose?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.action = options.action;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }
}

export class InputValidationError extends AppError {
  public constructor(message: string, details?: ErrorDetails) {
    super(400, "INVALID_INPUT", message, { details });
    this.name = "InputValidationError";
  }
}

export class QuotaExceededError extends AppError {
  public constructor(used: number, limit: number, usageDate: string) {
    super(429, "DAILY_QUOTA_EXCEEDED", `Daily parse limit reached (${limit} accepted attempts).`, {
      action: "Try again after the configured local day changes, or use a VIP account.",
      details: { used, limit, usageDate },
    });
    this.name = "QuotaExceededError";
  }
}

export class ParserUnavailableError extends AppError {
  public constructor(message: string, details?: ErrorDetails) {
    super(503, "PARSER_UNAVAILABLE", message, {
      action: "Install yt-dlp and set YTDLP_PATH, or explicitly set PARSER_MODE=mock for development.",
      details,
    });
    this.name = "ParserUnavailableError";
  }
}

export class SourceRestrictedError extends AppError {
  public constructor(message = "This source requires login, payment, or DRM-protected access.") {
    super(422, "SOURCE_RESTRICTED", message, {
      action: "Use a public, non-DRM source that you are authorized to access. JunVideo does not bypass platform access controls.",
    });
    this.name = "SourceRestrictedError";
  }
}

export class ParserFailedError extends AppError {
  public constructor(message = "The parser could not read this URL.", details?: ErrorDetails) {
    super(422, "PARSE_FAILED", message, {
      action: "Check the URL, confirm the content is public, and try again. If the issue persists, update yt-dlp.",
      details,
    });
    this.name = "ParserFailedError";
  }
}

export class TextTrackNotFoundError extends AppError {
  public constructor(message = "No supported text subtitle track was found for this video.", details?: ErrorDetails) {
    super(422, "TEXT_TRACK_NOT_FOUND", message, {
      action: "Choose a manual or automatic text subtitle track. Audio-only speech and burned-in or bitmap subtitles require ASR/OCR and are not extracted.",
      details,
    });
    this.name = "TextTrackNotFoundError";
  }
}

export class TextExtractionUnavailableError extends AppError {
  public constructor(message: string, details?: ErrorDetails) {
    super(503, "TEXT_EXTRACTION_UNAVAILABLE", message, {
      action: "Install or configure yt-dlp so JunVideo can refresh the selected subtitle track.",
      details,
    });
    this.name = "TextExtractionUnavailableError";
  }
}

export class TextExtractionFailedError extends AppError {
  public constructor(message = "The selected subtitle track could not be converted to text.", details?: ErrorDetails) {
    super(422, "TEXT_EXTRACTION_FAILED", message, {
      action: "Select another text subtitle track or parse the source again to refresh its metadata.",
      details,
    });
    this.name = "TextExtractionFailedError";
  }
}

export class TextTrackTooLargeError extends AppError {
  public constructor(maxBytes: number, actualBytes?: number) {
    super(413, "TEXT_TRACK_TOO_LARGE", "The subtitle track exceeds the configured text-extraction limit.", {
      action: "Select a smaller subtitle track.",
      details: { maxBytes, ...(actualBytes === undefined ? {} : { actualBytes }) },
    });
    this.name = "TextTrackTooLargeError";
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError(400, "INVALID_INPUT", "Request validation failed.", {
      details: {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    });
  }

  if (error && typeof error === "object" && "type" in error && error.type === "entity.parse.failed") {
    return new AppError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }

  return new AppError(500, "INTERNAL_ERROR", "An unexpected server error occurred.", { expose: false });
}

function requestIdOf(request: Request): string | undefined {
  return request.requestId;
}

export const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const appError = asAppError(error);
  const requestId = requestIdOf(request);

  if (appError.statusCode >= 500 || !appError.expose) {
    console.error("JunVideo request failed", {
      requestId,
      error,
    });
  }

  const body: {
    error: { code: string; message: string; action?: string; details?: ErrorDetails; requestId?: string };
  } = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : "An unexpected server error occurred.",
      ...(appError.action ? { action: appError.action } : {}),
      ...(appError.details ? { details: appError.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };

  response.status(appError.statusCode).json(body);
};

export function notFoundHandler(request: Request, response: Response): void {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No route matches ${request.method} ${request.path}.`,
      ...(request.requestId ? { requestId: request.requestId } : {}),
    },
  });
}
