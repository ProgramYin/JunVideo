import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Router, type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { findUserByEmail, sendAuthResponse, toPublicUser, verifyPassword, createUser, requireAuth, authenticatedUser } from "./auth.js";
import { checkDatabase, pool, query, withTransaction } from "./db.js";
import { AppError, QuotaExceededError, asAppError } from "./errors.js";
import { EmbeddedSubtitleService } from "./embedded-subtitle.js";
import { asyncHandler } from "./http.js";
import {
  parseResultToColumns,
  safeDownloadFilename,
  selectMediaFormat,
  subtitleFormatsForExtraction,
  toParseJobView,
  videoFormatsForTextInspection,
  type ParseJobRow,
} from "./jobs.js";
import { ParserService, parseRequestFromPreflight } from "./parser.js";
import {
  cleanupPreparedMedia,
  downloadAudioWithYtDlp,
  downloadSubtitleWithYtDlp,
  downloadVideoWithYtDlp,
  type PreparedMediaFile,
} from "./media-download.js";
import { extractUrlFromText, isSafeRemoteHttpUrl, platformCatalog, preflightUrl } from "./platform.js";
import { SubtitleTextService } from "./subtitle-text.js";
import { extractVideoText } from "./text-extraction.js";
import { getUsageSnapshot, reserveParseAttempt } from "./usage.js";
import {
  credentialsSchema,
  parseBody,
  positiveLimit,
  rawInputFromBody,
  registrationSchema,
  textExtractionBodySchema,
  uuidSchema,
} from "./validation.js";

function ownedJobQuery(): string {
  return `SELECT id, user_id, source_url, canonical_url, platform, status, title, description,
                 thumbnail_url, uploader, duration_seconds, video_formats, audio_formats,
                 metadata, error_code, error_message, error_action, accepted_at, created_at,
                 updated_at, completed_at
            FROM parse_jobs`;
}

async function findOwnedJob(jobId: string, userId: string): Promise<ParseJobRow> {
  const result = await query<ParseJobRow>(`${ownedJobQuery()} WHERE id = $1 AND user_id = $2 LIMIT 1`, [jobId, userId]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, "PARSE_JOB_NOT_FOUND", "The parse job was not found.");
  return row;
}

function jobIdFromRequest(request: Request): string {
  const parsed = uuidSchema.safeParse(request.params.jobId);
  if (!parsed.success) throw new AppError(400, "INVALID_JOB_ID", "jobId must be a valid UUID.");
  return parsed.data;
}

function mediaKind(value: unknown): "video" | "audio" | "image" | "subtitle" {
  if (value === "video" || value === "audio" || value === "image" || value === "subtitle") return value;
  throw new AppError(400, "INVALID_MEDIA_KIND", "kind must be video, audio, image, or subtitle.");
}

function requestedFormatId(request: Request): string | undefined {
  const value = request.query.formatId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw new AppError(400, "INVALID_FORMAT_ID", "formatId contains unsupported characters.");
  }
  return value;
}

function errorBody(error: unknown, request: Request): { error: Record<string, unknown> } {
  const appError = asAppError(error);
  return {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : "An unexpected server error occurred.",
      ...(appError.action ? { action: appError.action } : {}),
      ...(appError.details && appError.code !== "PARSE_FAILED" ? { details: appError.details } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
    },
  };
}

async function markJobSucceeded(jobId: string, result: ReturnType<typeof parseResultToColumns>): Promise<ParseJobRow> {
  const updated = await query<ParseJobRow>(
    `UPDATE parse_jobs
        SET status = 'succeeded',
            title = $2,
            description = $3,
            thumbnail_url = $4,
            uploader = $5,
            duration_seconds = $6,
            video_formats = $7::jsonb,
            audio_formats = $8::jsonb,
            metadata = $9::jsonb,
            error_code = NULL,
            error_message = NULL,
            error_action = NULL,
            updated_at = NOW(),
            completed_at = NOW()
      WHERE id = $1
      RETURNING id, user_id, source_url, canonical_url, platform, status, title, description,
                thumbnail_url, uploader, duration_seconds, video_formats, audio_formats,
                metadata, error_code, error_message, error_action, accepted_at, created_at,
                updated_at, completed_at`,
    [
      jobId,
      result.title,
      result.description,
      result.thumbnailUrl,
      result.uploader,
      result.durationSeconds,
      JSON.stringify(result.videoFormats),
      JSON.stringify(result.audioFormats),
      JSON.stringify(result.metadata),
    ],
  );
  if (!updated.rows[0]) throw new AppError(500, "PARSE_JOB_UPDATE_FAILED", "The parse result could not be saved.", { expose: false });
  return updated.rows[0];
}

async function markJobFailed(jobId: string, error: AppError): Promise<ParseJobRow> {
  const updated = await query<ParseJobRow>(
    `UPDATE parse_jobs
        SET status = 'failed',
            error_code = $2,
            error_message = $3,
            error_action = $4,
            updated_at = NOW(),
            completed_at = NOW()
      WHERE id = $1
      RETURNING id, user_id, source_url, canonical_url, platform, status, title, description,
                thumbnail_url, uploader, duration_seconds, video_formats, audio_formats,
                metadata, error_code, error_message, error_action, accepted_at, created_at,
                updated_at, completed_at`,
    [jobId, error.code, error.message, error.action ?? null],
  );
  if (!updated.rows[0]) throw new AppError(500, "PARSE_JOB_UPDATE_FAILED", "The parse failure could not be saved.", { expose: false });
  return updated.rows[0];
}

function contentDisposition(filename: string): string {
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function mergedVideoFilename(job: ParseJobRow, format: ReturnType<typeof selectMediaFormat>): string {
  return safeDownloadFilename(job.title, "video", { ...format, ext: "mp4", mimeType: "video/mp4" });
}

function preparedAudioFilename(job: ParseJobRow, format: ReturnType<typeof selectMediaFormat>): string {
  return safeDownloadFilename(job.title, "audio", format);
}

function preparedSubtitleFilename(job: ParseJobRow, format: ReturnType<typeof selectMediaFormat>): string {
  const language = format.language?.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 40);
  const title = language ? `${job.title ?? "junvideo"}-${language}` : job.title;
  return safeDownloadFilename(title, "subtitle", format);
}

function streamPreparedMedia(
  prepared: PreparedMediaFile,
  response: Response,
  next: NextFunction,
  filename: string,
): void {
  response.setHeader("Content-Type", prepared.contentType);
  response.setHeader("Content-Disposition", contentDisposition(filename));
  response.setHeader("Cache-Control", "private, no-store");

  const stream = createReadStream(prepared.filePath);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    void cleanupPreparedMedia(prepared);
  };
  response.once("finish", cleanup);
  response.once("close", cleanup);
  stream.once("error", (error) => {
    cleanup();
    if (!response.headersSent) next(new AppError(502, "MEDIA_STREAM_FAILED", "The prepared media file could not be read."));
    else response.destroy(error);
  });
  stream.pipe(response);
}

async function fetchRemoteMedia(initialUrl: string, forwardedHeaders: Record<string, string> = {}): Promise<{
  response: globalThis.Response;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
}> {
  if (typeof fetch !== "function") {
    throw new AppError(503, "MEDIA_PROXY_UNAVAILABLE", "The server runtime does not provide a media proxy.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let currentUrl = initialUrl;

  try {
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      let response: globalThis.Response | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "JunVideo/1.0", ...forwardedHeaders },
        });

        if (response.ok || (response.status >= 300 && response.status < 400) || !isTransientMediaStatus(response.status) || attempt === 2) {
          break;
        }

        // CDN edges occasionally return a short-lived 5xx/429 while the
        // signed URL is still valid. Retry the same URL briefly before asking
        // the user to re-parse the source. Do not retry permanent 4xx errors.
        await response.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }

      if (!response) {
        throw new AppError(502, "MEDIA_FETCH_FAILED", "The media URL expired or could not be fetched.");
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new AppError(502, "MEDIA_REDIRECT_INVALID", "The media server returned an invalid redirect.");
        let redirectedUrl: string;
        try {
          redirectedUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new AppError(502, "MEDIA_REDIRECT_INVALID", "The media server returned an invalid redirect.");
        }
        if (!isSafeRemoteHttpUrl(redirectedUrl)) {
          throw new AppError(502, "MEDIA_REDIRECT_BLOCKED", "The media redirect was blocked by the proxy safety policy.");
        }
        currentUrl = redirectedUrl;
        continue;
      }

      if (!response.ok || !response.body) {
        throw new AppError(502, "MEDIA_FETCH_FAILED", "The media URL expired or could not be fetched.", {
          action: "Run the parse again to obtain a fresh, authorized media URL.",
        });
      }
      // The timeout protects connection/redirect setup only. Keeping it
      // armed during the body stream would abort legitimate large downloads
      // (for example, a 200MB+ Bilibili video on a slower connection).
      clearTimeout(timeout);
      return { response, controller, timeout };
    }
    throw new AppError(502, "MEDIA_REDIRECT_LIMIT", "The media server returned too many redirects.");
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AppError(504, "MEDIA_FETCH_TIMEOUT", "The media server took too long to respond.");
    }
    if (error instanceof AppError) throw error;
    throw new AppError(502, "MEDIA_FETCH_FAILED", "The media URL expired or could not be fetched.", {
      action: "Run the parse again to obtain a fresh, authorized media URL.",
    });
  }
}

export function isTransientMediaStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function createApiRouter(
  parser = new ParserService(),
  subtitleTextService = new SubtitleTextService(config),
  embeddedSubtitleService = new EmbeddedSubtitleService(config),
): Router {
  const router = Router();

  const healthHandler = asyncHandler(async (_request, response) => {
    const [database, parserStatus] = await Promise.all([checkDatabase(), parser.health()]);
    const healthy = database.ok && parserStatus.available;
    // Health is an observability endpoint: return the component statuses even
    // when the service is degraded, so the UI and smoke checks can explain
    // whether PostgreSQL or yt-dlp needs attention.
    response.status(200).json({
      ok: healthy,
      status: healthy ? "ok" : "degraded",
      service: "junvideo-api",
      timestamp: new Date().toISOString(),
      database: database.ok
        ? { status: "up", latencyMs: database.latencyMs }
        : { status: "down", message: "Database unavailable." },
      parser: parserStatus,
      features: {
        textExtraction: config.textExtractionEnabled,
        transcription: false,
        devVip: config.devVipEnabled,
        subtitles: true,
      },
    });
  });
  router.get("/health", healthHandler);
  router.get("/healthz", healthHandler);

  router.post("/auth/register", asyncHandler(async (request, response) => {
    const body = parseBody(registrationSchema, request.body);
    const user = await createUser(body.name, body.email, body.password);
    sendAuthResponse(response, user, 201);
  }));

  router.post("/auth/login", asyncHandler(async (request, response) => {
    const body = parseBody(credentialsSchema, request.body);
    const user = await findUserByEmail(body.email);
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    sendAuthResponse(response, user);
  }));

  router.post("/auth/logout", requireAuth, asyncHandler(async (_request, response) => {
    response.json({ ok: true, message: "Signed out. Remove the stateless access token on the client." });
  }));

  router.get("/auth/me", requireAuth, asyncHandler(async (request, response) => {
    response.json({ user: authenticatedUser(request) });
  }));

  router.get("/usage", requireAuth, asyncHandler(async (request, response) => {
    const user = authenticatedUser(request);
    const usage = await getUsageSnapshot(pool, { userId: user.id, isVip: user.isVip });
    response.json({ usage });
  }));
  router.get("/usage/daily", requireAuth, asyncHandler(async (request, response) => {
    const user = authenticatedUser(request);
    const usage = await getUsageSnapshot(pool, { userId: user.id, isVip: user.isVip });
    response.json({ usage });
  }));

  router.get("/platforms", (_request, response) => {
    response.json({ platforms: platformCatalog().map(({ id, label, domains }) => ({ id, label, domains })) });
  });

  router.post("/parse/preflight", requireAuth, asyncHandler(async (request, response) => {
    const input = rawInputFromBody(request.body);
    const preflight = preflightUrl(extractUrlFromText(input));
    response.json({
      sourceUrl: input,
      canonicalUrl: preflight.canonicalUrl,
      platform: preflight.platform,
      parserMode: config.parserMode,
      notice: "Only public content that you are authorized to access is supported; DRM and paywall bypass is not provided.",
    });
  }));

  router.post("/parse", requireAuth, asyncHandler(async (request, response) => {
    const user = authenticatedUser(request);
    const input = rawInputFromBody(request.body);
    const preflight = preflightUrl(extractUrlFromText(input));
    const parseRequest = parseRequestFromPreflight(preflight);

    const job = await withTransaction(async (client) => {
      const reservation = await reserveParseAttempt(client, { userId: user.id, isVip: user.isVip });
      if (!reservation.accepted) {
        throw new QuotaExceededError(reservation.used, reservation.limit ?? config.dailyParseLimit, reservation.usageDate);
      }

      const inserted = await client.query<ParseJobRow>(
        `INSERT INTO parse_jobs (user_id, source_url, canonical_url, platform, status)
         VALUES ($1, $2, $3, $4, 'processing')
         RETURNING id, user_id, source_url, canonical_url, platform, status, title, description,
                   thumbnail_url, uploader, duration_seconds, video_formats, audio_formats,
                   metadata, error_code, error_message, error_action, accepted_at, created_at,
                   updated_at, completed_at`,
        [user.id, input, preflight.canonicalUrl, preflight.platform.id],
      );
      return inserted.rows[0];
    });

    try {
      const result = await parser.parse(parseRequest);
      const savedJob = await markJobSucceeded(job.id, parseResultToColumns(result));
      const usage = await getUsageSnapshot(pool, { userId: user.id, isVip: user.isVip });
      response.status(201).json({
        job: toParseJobView(savedJob),
        usage,
        notice: result.mock
          ? "Development-only mock result; configure yt-dlp before treating download options as real media."
          : "Only public, authorized content is supported. Download links may expire.",
      });
    } catch (error) {
      const appError = asAppError(error);
      let failedJob: ParseJobRow;
      try {
        failedJob = await markJobFailed(job.id, appError);
      } catch (saveError) {
        throw saveError;
      }
      const usage = await getUsageSnapshot(pool, { userId: user.id, isVip: user.isVip });
      response.status(appError.statusCode).json({ ...errorBody(appError, request), job: toParseJobView(failedJob), usage });
    }
  }));

  const extractTextHandler = asyncHandler(async (request, response) => {
    const user = authenticatedUser(request);
    const job = await findOwnedJob(jobIdFromRequest(request), user.id);
    if (job.status !== "succeeded") {
      throw new AppError(409, "PARSE_JOB_NOT_READY", "Parse the source successfully before extracting subtitle text.");
    }
    const options = parseBody(textExtractionBodySchema, request.body ?? {});
    const formats = subtitleFormatsForExtraction(job);
    const transcript = await extractVideoText({
      sourceUrl: job.canonical_url,
      subtitleFormats: formats,
      videoFormats: videoFormatsForTextInspection(job),
      options,
    }, subtitleTextService, embeddedSubtitleService);
    response.status(200).json({ transcript });
  });

  router.post("/extract-text/:jobId", requireAuth, extractTextHandler);
  // Backward-compatible route name; behavior and validation are identical and
  // never invoke audio extraction, ASR, Python, or an external AI service.
  router.post("/transcribe/:jobId", requireAuth, extractTextHandler);

  router.get("/history", requireAuth, asyncHandler(async (request, response) => {
    const user = authenticatedUser(request);
    const limit = positiveLimit(request.query.limit, 20, 100);
    const result = await query<ParseJobRow>(
      `${ownedJobQuery()} WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [user.id, limit],
    );
    response.json({ jobs: result.rows.map(toParseJobView), limit });
  }));

  router.get("/history/:jobId", requireAuth, asyncHandler(async (request, response) => {
    const user = authenticatedUser(request);
    const job = await findOwnedJob(jobIdFromRequest(request), user.id);
    response.json({ job: toParseJobView(job) });
  }));

  router.get("/download/:jobId/:kind", requireAuth, asyncHandler(async (request, response, next: NextFunction) => {
    const user = authenticatedUser(request);
    const job = await findOwnedJob(jobIdFromRequest(request), user.id);
    if (job.status !== "succeeded") {
      throw new AppError(409, "PARSE_JOB_NOT_READY", "This parse job does not have downloadable media yet.");
    }
    const kind = mediaKind(request.params.kind);
    const format = selectMediaFormat(job, kind, requestedFormatId(request));
    response.setHeader("Cache-Control", "private, no-store");
    if (kind === "video" && format.downloadMode !== "direct") {
      const prepared = await downloadVideoWithYtDlp(job.canonical_url, format, config);
      streamPreparedMedia(prepared, response, next, mergedVideoFilename(job, format));
      return;
    }
    if (kind === "audio" && format.downloadMode !== "direct") {
      const prepared = await downloadAudioWithYtDlp(job.canonical_url, format, config);
      streamPreparedMedia(prepared, response, next, preparedAudioFilename(job, format));
      return;
    }
    if (kind === "subtitle" && format.downloadMode !== "direct") {
      const prepared = await downloadSubtitleWithYtDlp(job.canonical_url, format, config);
      streamPreparedMedia(prepared, response, next, preparedSubtitleFilename(job, format));
      return;
    }
    response.redirect(302, format.url);
  }));

  router.get("/proxy/:jobId/:kind", requireAuth, asyncHandler(async (request, response, next: NextFunction) => {
    const user = authenticatedUser(request);
    const job = await findOwnedJob(jobIdFromRequest(request), user.id);
    if (job.status !== "succeeded") {
      throw new AppError(409, "PARSE_JOB_NOT_READY", "This parse job does not have downloadable media yet.");
    }
    const kind = mediaKind(request.params.kind);
    const format = selectMediaFormat(job, kind, requestedFormatId(request));
    if (kind === "video" && format.downloadMode !== "direct") {
      const prepared = await downloadVideoWithYtDlp(job.canonical_url, format, config);
      streamPreparedMedia(prepared, response, next, mergedVideoFilename(job, format));
      return;
    }
    if (kind === "audio" && format.downloadMode !== "direct") {
      const prepared = await downloadAudioWithYtDlp(job.canonical_url, format, config);
      streamPreparedMedia(prepared, response, next, preparedAudioFilename(job, format));
      return;
    }
    if (kind === "subtitle" && format.downloadMode !== "direct") {
      const prepared = await downloadSubtitleWithYtDlp(job.canonical_url, format, config);
      streamPreparedMedia(prepared, response, next, preparedSubtitleFilename(job, format));
      return;
    }
    const remote = await fetchRemoteMedia(format.url, format.httpHeaders);
    const filename = safeDownloadFilename(job.title, kind, format);
    const contentType = (format.mimeType ?? remote.response.headers.get("content-type") ?? "application/octet-stream")
      .split(";", 1)[0]
      .trim();
    if (/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) {
      response.setHeader("Content-Type", contentType);
    }
    const contentLength = remote.response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength)) response.setHeader("Content-Length", contentLength);
    response.setHeader("Content-Disposition", contentDisposition(filename));
    response.setHeader("Cache-Control", "private, no-store");

    const stream = Readable.fromWeb(remote.response.body as unknown as import("node:stream/web").ReadableStream);
    const cleanup = (): void => clearTimeout(remote.timeout);
    stream.once("close", cleanup);
    stream.once("error", (error) => {
      cleanup();
      if (!response.headersSent) next(new AppError(502, "MEDIA_STREAM_FAILED", "The media stream ended unexpectedly."));
      else response.destroy(error);
    });
    response.once("close", () => remote.controller.abort());
    stream.pipe(response);
  }));

  router.post("/dev/vip/activate", requireAuth, asyncHandler(async (request, response) => {
    if (!config.devVipEnabled) {
      throw new AppError(404, "DEV_VIP_DISABLED", "Development-only VIP activation is disabled.");
    }
    const currentUser = authenticatedUser(request);
    const result = await query<{
      id: string;
      name: string;
      email: string;
      password_hash: string;
      is_vip: boolean;
      vip_activated_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `UPDATE users
          SET is_vip = TRUE,
              vip_activated_at = COALESCE(vip_activated_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, email, password_hash, is_vip, vip_activated_at, created_at, updated_at`,
      [currentUser.id],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, "USER_NOT_FOUND", "The account was not found.");
    response.json({
      developmentOnly: true,
      message: "VIP was activated for local development only; this is not a production payment flow.",
      user: toPublicUser(row),
    });
  }));

  return router;
}
