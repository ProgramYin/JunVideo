import { z, type ZodType } from "zod";
import { InputValidationError } from "./errors.js";
import { extractUrlFromText } from "./platform.js";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(72),
});

export const registrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(60),
});

export const urlBodySchema = z.object({
  url: z.string().max(2_048).optional(),
  sourceUrl: z.string().max(2_048).optional(),
});

export const uuidSchema = z.string().uuid();

export const transcriptionBodySchema = z.object({
  language: z.string().trim().min(1).max(40).optional(),
  model: z.enum(["tiny", "base", "small", "medium", "large", "turbo"]).optional(),
});

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new InputValidationError("Request validation failed.", {
    issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  });
}

export function rawInputFromBody(body: unknown): string {
  const parsed = parseBody(urlBodySchema, body);
  const url = parsed.url ?? parsed.sourceUrl;
  if (!url || !url.trim()) {
    throw new InputValidationError("Provide a url field containing a video link, optionally with Chinese description text.");
  }
  return url;
}

export function urlFromBody(body: unknown): string {
  return extractUrlFromText(rawInputFromBody(body));
}

export function positiveLimit(value: unknown, defaultValue: number, maximum: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new InputValidationError(`limit must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}
