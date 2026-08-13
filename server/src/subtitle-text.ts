import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import {
  AppError,
  TextExtractionFailedError,
  TextExtractionUnavailableError,
  TextTrackNotFoundError,
} from "./errors.js";
import {
  cleanupPreparedMedia,
  type PreparedMediaFile,
} from "./media-download.js";
import type { MediaFormat } from "./parser.js";
import { fetchRemoteBuffer } from "./safe-remote-fetch.js";

export interface SubtitleCue {
  startMs: number;
  endMs: number | null;
  text: string;
}

export interface ExtractedTextResult {
  text: string;
  /** Compatibility with the former transcription response. */
  rawText: string;
  /** No correction is performed; this is intentionally identical to rawText. */
  correctedText: string;
  language: string;
  model: "subtitle-track";
  correctionMode: "none";
  method: "subtitle-track";
  source: "manual-subtitle" | "automatic-caption" | "embedded-subtitle";
  trackId: string;
  format: string;
  cueCount: number;
  segments: SubtitleCue[];
  timestampedText: string;
}

export interface SubtitleSelectionOptions {
  /** Preferred public name. */
  trackId?: string;
  /** Compatibility alias for callers that already use media format ids. */
  formatId?: string;
  language?: string;
}

export interface SubtitleParseLimits {
  maxBytes: number;
  maxCues: number;
  maxChars: number;
}

export interface SubtitleParseOptions {
  automatic?: boolean;
  limits?: Partial<SubtitleParseLimits>;
}

export const DEFAULT_SUBTITLE_PARSE_LIMITS: Readonly<SubtitleParseLimits> = {
  maxBytes: 8 * 1024 * 1024,
  maxCues: 20_000,
  maxChars: 2_000_000,
};

type SubtitleLimitKind = "bytes" | "cues" | "characters";

/** A stable, non-AI resource-limit error suitable for an HTTP 413 response. */
export class SubtitleTextLimitError extends AppError {
  public constructor(kind: SubtitleLimitKind, maximum: number, actual: number) {
    super(413, "TEXT_TRACK_TOO_LARGE", `The subtitle track exceeds the configured ${kind} limit.`, {
      action: "Select a smaller text subtitle track.",
      details: { limitType: kind, maximum, actual },
    });
    this.name = "SubtitleTextLimitError";
  }
}

const EXTENSION_PRIORITY = [
  "vtt",
  "srt",
  "ass",
  "ssa",
  "ttml",
  "dfxp",
  "srv3",
  "srv2",
  "srv1",
  "json3",
  "json",
  "sbv",
  "lrc",
] as const;

const EXCLUDED_TRACK_PATTERN = /(?:^|[-_.\s])(live[-_.\s]?chat|comments?|commentary|danmaku|bullet[-_.\s]?comments?)(?:$|[-_.\s])/iu;

function normalizedExtension(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./u, "")
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 20);
}

function normalizedLanguage(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/gu, "-")
    .replace(/-+/gu, "-");
}

function languageBase(value: string): string {
  return value.split("-", 1)[0] ?? value;
}

function isExcludedTrack(format: MediaFormat): boolean {
  if (format.mediaType !== "subtitle") return true;
  const identity = [format.id, format.language, format.qualityLabel].filter(Boolean).join(" ");
  return EXCLUDED_TRACK_PATTERN.test(identity);
}

function languageRank(format: MediaFormat, requestedLanguage: string): number {
  if (!requestedLanguage) return 0;
  const candidate = normalizedLanguage(format.language);
  if (candidate === requestedLanguage) return 0;
  const requestedBase = languageBase(requestedLanguage);
  const candidateBase = languageBase(candidate);
  if (candidate && candidateBase === requestedBase) return 1;
  return 2;
}

function extensionRank(format: MediaFormat): number {
  const rank = EXTENSION_PRIORITY.indexOf(normalizedExtension(format.ext) as typeof EXTENSION_PRIORITY[number]);
  return rank < 0 ? EXTENSION_PRIORITY.length + 1 : rank;
}

/**
 * Returns all usable candidates in deterministic fallback order.
 * Explicit track selection never silently falls back to a different track.
 */
export function rankSubtitleFormats(
  formats: readonly MediaFormat[],
  options: SubtitleSelectionOptions = {},
): MediaFormat[] {
  const explicitId = (options.trackId ?? options.formatId)?.trim();
  const requestedLanguage = normalizedLanguage(options.language);

  return formats
    .map((format, index) => ({ format, index }))
    .filter(({ format }) => !isExcludedTrack(format))
    .filter(({ format }) => !explicitId || format.id === explicitId)
    .sort((left, right) => {
      const languageDifference = languageRank(left.format, requestedLanguage) - languageRank(right.format, requestedLanguage);
      if (languageDifference !== 0) return languageDifference;
      const sourceDifference = Number(Boolean(left.format.automatic)) - Number(Boolean(right.format.automatic));
      if (sourceDifference !== 0) return sourceDifference;
      const extensionDifference = extensionRank(left.format) - extensionRank(right.format);
      if (extensionDifference !== 0) return extensionDifference;
      const languageDifferenceStable = normalizedLanguage(left.format.language)
        .localeCompare(normalizedLanguage(right.format.language), "en");
      if (languageDifferenceStable !== 0) return languageDifferenceStable;
      return left.index - right.index;
    })
    .map(({ format }) => format);
}

export function selectSubtitleFormat(
  formats: readonly MediaFormat[],
  options: SubtitleSelectionOptions = {},
): MediaFormat | null {
  return rankSubtitleFormats(formats, options)[0] ?? null;
}

function resolvedLimits(limits: Partial<SubtitleParseLimits> | undefined): SubtitleParseLimits {
  return {
    maxBytes: positiveLimit(limits?.maxBytes, DEFAULT_SUBTITLE_PARSE_LIMITS.maxBytes),
    maxCues: positiveLimit(limits?.maxCues, DEFAULT_SUBTITLE_PARSE_LIMITS.maxCues),
    maxChars: positiveLimit(limits?.maxChars, DEFAULT_SUBTITLE_PARSE_LIMITS.maxChars),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function utf16BeToString(bytes: Buffer): string {
  const evenLength = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped.toString("utf16le");
}

function likelyUtf16(bytes: Buffer): "le" | "be" | null {
  const inspectedLength = Math.min(bytes.length - (bytes.length % 2), 512);
  if (inspectedLength < 8) return null;
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let index = 0; index < inspectedLength; index += 2) {
    if (bytes[index] === 0) zeroEven += 1;
    if (bytes[index + 1] === 0) zeroOdd += 1;
  }
  const pairs = inspectedLength / 2;
  if (zeroOdd / pairs > 0.35 && zeroEven / pairs < 0.1) return "le";
  if (zeroEven / pairs > 0.35 && zeroOdd / pairs < 0.1) return "be";
  return null;
}

/** Decodes UTF-8/UTF-16 subtitle bytes without invoking an external service. */
export function decodeSubtitleBytes(
  input: Buffer | Uint8Array,
  maxBytes = DEFAULT_SUBTITLE_PARSE_LIMITS.maxBytes,
): string {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const resolvedMaximum = positiveLimit(maxBytes, DEFAULT_SUBTITLE_PARSE_LIMITS.maxBytes);
  if (bytes.byteLength > resolvedMaximum) {
    throw new SubtitleTextLimitError("bytes", resolvedMaximum, bytes.byteLength);
  }

  let decoded: string;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    decoded = bytes.subarray(3).toString("utf8");
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoded = bytes.subarray(2).toString("utf16le");
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoded = utf16BeToString(bytes.subarray(2));
  } else {
    const encoding = likelyUtf16(bytes);
    decoded = encoding === "le"
      ? bytes.toString("utf16le")
      : encoding === "be"
        ? utf16BeToString(bytes)
        : bytes.toString("utf8");
  }

  return decoded.replace(/^\uFEFF/u, "").replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n");
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    ndash: "–",
    quot: "\"",
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu, (entity, rawName: string) => {
    if (rawName.startsWith("#")) {
      const hexadecimal = rawName[1]?.toLowerCase() === "x";
      const numberText = rawName.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(numberText, hexadecimal ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return String.fromCodePoint(codePoint);
      }
      return "";
    }
    return namedEntities[rawName.toLowerCase()] ?? entity;
  });
}

/** Conservative markup/whitespace cleanup shared by every parser. */
export function cleanSubtitleText(value: string): string {
  const cleaned = decodeHtmlEntities(
    value
      .replace(/\{\\[^}]*\}/gu, "")
      .replace(/\\[Nn]/gu, "\n")
      .replace(/\\h/gu, " ")
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/gu, "")
      .replace(/<(?:br|BR)\s*\/?\s*>/gu, "\n")
      .replace(/<[^>]*>/gu, ""),
  )
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, "")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return cleaned.normalize("NFC");
}

function parseFraction(value: string | undefined): number {
  if (!value) return 0;
  return Number.parseInt(`${value}000`.slice(0, 3), 10);
}

function parseClockTimestamp(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secondsPart = parts.at(-1)?.match(/^(\d{1,2})(?:\.(\d{1,9}))?$/u);
  if (!secondsPart) return null;
  const seconds = Number.parseInt(secondsPart[1] ?? "0", 10);
  const minutes = Number.parseInt(parts.at(-2) ?? "", 10);
  const hours = parts.length === 3 ? Number.parseInt(parts[0] ?? "", 10) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite) || seconds >= 60 || minutes >= 60) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + parseFraction(secondsPart[2]);
}

function parseTtmlTimestamp(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  const clock = parseClockTimestamp(normalized);
  if (clock !== null) return clock;
  const unit = normalized.match(/^(-?\d+(?:\.\d+)?)(h|m|s|ms)$/u);
  if (!unit) return null;
  const amount = Number(unit[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const multiplier = unit[2] === "h" ? 3_600_000 : unit[2] === "m" ? 60_000 : unit[2] === "s" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function validCue(startMs: number | null, endMs: number | null, text: string): SubtitleCue | null {
  const cleaned = cleanSubtitleText(text);
  if (startMs === null || !Number.isSafeInteger(startMs) || startMs < 0 || !cleaned) return null;
  if (endMs !== null && (!Number.isSafeInteger(endMs) || endMs <= startMs)) return null;
  return { startMs, endMs, text: cleaned };
}

function parseArrowTimedText(text: string): SubtitleCue[] {
  const lines = text.split("\n");
  const cues: SubtitleCue[] = [];
  let index = 0;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (/^(?:WEBVTT|X-TIMESTAMP-MAP\b)/iu.test(trimmed)) {
      index += 1;
      continue;
    }
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/iu.test(trimmed)) {
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim()) index += 1;
      continue;
    }

    let timingIndex = trimmed.includes("-->") ? index : index + 1;
    if (!(lines[timingIndex] ?? "").includes("-->")) {
      index += 1;
      continue;
    }
    const timing = (lines[timingIndex] ?? "").split("-->", 2);
    const startMs = parseClockTimestamp(timing[0] ?? "");
    const endToken = (timing[1] ?? "").trim().split(/\s+/u, 1)[0] ?? "";
    const endMs = parseClockTimestamp(endToken);
    index = timingIndex + 1;
    const content: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim()) {
      // A few malformed exports omit the blank line between cues.
      if ((lines[index] ?? "").includes("-->") && content.length > 0) break;
      content.push(lines[index] ?? "");
      index += 1;
    }
    const cue = validCue(startMs, endMs, content.join("\n"));
    if (cue) cues.push(cue);
  }
  return cues;
}

function splitAssFields(value: string, count: number): string[] {
  if (count <= 1) return [value];
  const fields: string[] = [];
  let remainder = value;
  for (let index = 0; index < count - 1; index += 1) {
    const comma = remainder.indexOf(",");
    if (comma < 0) break;
    fields.push(remainder.slice(0, comma));
    remainder = remainder.slice(comma + 1);
  }
  fields.push(remainder);
  return fields;
}

function parseAss(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  let inEvents = !/^\s*\[/mu.test(text);
  for (const line of text.split("\n")) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (section) {
      inEvents = section[1]?.trim().toLowerCase() === "events";
      continue;
    }
    if (!inEvents) continue;
    const format = line.match(/^\s*Format\s*:\s*(.+)$/iu);
    if (format) {
      const parsedFields = (format[1] ?? "").split(",").map((field) => field.trim().toLowerCase());
      if (parsedFields.includes("start") && parsedFields.includes("text")) fields = parsedFields;
      continue;
    }
    const dialogue = line.match(/^\s*Dialogue\s*:\s*(.*)$/iu);
    if (!dialogue) continue;
    const values = splitAssFields(dialogue[1] ?? "", fields.length);
    const startIndex = fields.indexOf("start");
    const endIndex = fields.indexOf("end");
    const textIndex = fields.indexOf("text");
    const cue = validCue(
      parseClockTimestamp(values[startIndex] ?? ""),
      parseClockTimestamp(values[endIndex] ?? ""),
      values[textIndex] ?? "",
    );
    if (cue) cues.push(cue);
  }
  return cues;
}

function xmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const expression = /(?:^|\s)([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  for (const match of value.matchAll(expression)) {
    const name = (match[1] ?? "").toLowerCase().split(":").at(-1);
    if (name) attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function youtubeMilliseconds(value: string | undefined): number | null {
  if (!value || !/^-?\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

function youtubeSeconds(value: string | undefined): number | null {
  if (!value || !/^-?\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 1_000) : null;
}

function parseXmlTimedText(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const paragraphExpression = /<(?:[\w.-]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?p\s*>/giu;
  for (const match of text.matchAll(paragraphExpression)) {
    const attributes = xmlAttributes(match[1] ?? "");
    const startMs = attributes.begin !== undefined
      ? parseTtmlTimestamp(attributes.begin)
      : youtubeMilliseconds(attributes.t);
    const explicitEnd = attributes.end !== undefined ? parseTtmlTimestamp(attributes.end) : null;
    const duration = attributes.dur !== undefined
      ? parseTtmlTimestamp(attributes.dur)
      : youtubeMilliseconds(attributes.d);
    const endMs = explicitEnd ?? (startMs !== null && duration !== null ? startMs + duration : null);
    const cue = validCue(startMs, endMs, match[2] ?? "");
    if (cue) cues.push(cue);
  }

  const textExpression = /<text\b([^>]*)>([\s\S]*?)<\/text\s*>/giu;
  for (const match of text.matchAll(textExpression)) {
    const attributes = xmlAttributes(match[1] ?? "");
    const startMs = youtubeSeconds(attributes.start);
    const duration = youtubeSeconds(attributes.dur);
    const cue = validCue(startMs, startMs !== null && duration !== null ? startMs + duration : null, match[2] ?? "");
    if (cue) cues.push(cue);
  }
  return cues.sort((left, right) => left.startMs - right.startMs);
}

function finiteMilliseconds(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function parseJson3(text: string): SubtitleCue[] {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TextExtractionFailedError("The JSON3 subtitle track is not valid JSON.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];
  const events = (document as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const cues: SubtitleCue[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const entry = event as Record<string, unknown>;
    const startMs = finiteMilliseconds(entry.tStartMs);
    const duration = finiteMilliseconds(entry.dDurationMs);
    const segments = Array.isArray(entry.segs) ? entry.segs : [];
    const content = segments.map((segment) => {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) return "";
      const utf8 = (segment as Record<string, unknown>).utf8;
      return typeof utf8 === "string" ? utf8 : "";
    }).join("");
    const cue = validCue(startMs, startMs !== null && duration !== null ? startMs + duration : null, content);
    if (cue) cues.push(cue);
  }
  return cues;
}

function parseLrc(text: string): SubtitleCue[] {
  const offsetMatch = text.match(/^\s*\[offset\s*:\s*(-?\d+)\]\s*$/imu);
  const offset = offsetMatch ? Number.parseInt(offsetMatch[1] ?? "0", 10) : 0;
  const cues: SubtitleCue[] = [];
  for (const line of text.split("\n")) {
    const timestamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu)];
    if (timestamps.length === 0) continue;
    const content = line.replace(/\[(?:\d{1,3}):(?:\d{2})(?:[.:]\d{1,3})?\]/gu, "")
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/gu, "");
    for (const timestamp of timestamps) {
      const minutes = Number.parseInt(timestamp[1] ?? "0", 10);
      const seconds = Number.parseInt(timestamp[2] ?? "0", 10);
      if (seconds >= 60) continue;
      const startMs = Math.max(0, (minutes * 60 + seconds) * 1_000 + parseFraction(timestamp[3]) + offset);
      const cue = validCue(startMs, null, content);
      if (cue) cues.push(cue);
    }
  }
  cues.sort((left, right) => left.startMs - right.startMs);
  return cues.map((cue, index) => ({ ...cue, endMs: cues[index + 1]?.startMs ?? null }));
}

function parseSbv(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n\s*\n/gu)) {
    const lines = block.split("\n");
    const timing = (lines.shift() ?? "").split(",", 2);
    if (timing.length !== 2) continue;
    const cue = validCue(parseClockTimestamp(timing[0] ?? ""), parseClockTimestamp(timing[1] ?? ""), lines.join("\n"));
    if (cue) cues.push(cue);
  }
  return cues;
}

function detectSubtitleFormat(text: string): string | null {
  const trimmed = text.trimStart();
  if (/^WEBVTT(?:\s|$)/iu.test(trimmed)) return "vtt";
  if (/^(?:\{|\[)/u.test(trimmed) && /"events"\s*:/u.test(trimmed.slice(0, 10_000))) return "json3";
  if (/\[(?:Script Info|Events)\]/iu.test(trimmed) || /^\s*Dialogue\s*:/imu.test(trimmed)) return "ass";
  if (/^\s*<(?:\?xml\b|tt\b|timedtext\b)/iu.test(trimmed)) return "ttml";
  if (/^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/mu.test(trimmed)) return "lrc";
  if (/^\s*\d{1,3}:\d{2}:\d{2}[.,]\d+\s*,\s*\d{1,3}:\d{2}:\d{2}[.,]\d+/mu.test(trimmed)) return "sbv";
  if (trimmed.includes("-->")) return "srt";
  return null;
}

function parseByFormat(text: string, extension: string): SubtitleCue[] {
  const normalized = normalizedExtension(extension);
  const detected = detectSubtitleFormat(text);
  const format = normalized || detected;
  if (format === "vtt" || format === "srt") return parseArrowTimedText(text);
  if (format === "ass" || format === "ssa") return parseAss(text);
  if (["ttml", "dfxp", "xml", "srv1", "srv2", "srv3"].includes(format ?? "")) return parseXmlTimedText(text);
  if (format === "json" || format === "json3") return parseJson3(text);
  if (format === "lrc") return parseLrc(text);
  if (format === "sbv") return parseSbv(text);
  if (detected && detected !== format) return parseByFormat(text, detected);
  throw new TextExtractionFailedError(`Unsupported text subtitle format: ${normalized || "unknown"}.`, {
    extension: normalized || null,
  });
}

function sameTimeWindow(left: SubtitleCue, right: SubtitleCue): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

function normalizeCueList(cues: SubtitleCue[]): SubtitleCue[] {
  const sorted = cues
    .map((cue, index) => ({ cue: validCue(cue.startMs, cue.endMs, cue.text), index }))
    .filter((entry): entry is { cue: SubtitleCue; index: number } => entry.cue !== null)
    .sort((left, right) => left.cue.startMs - right.cue.startMs || left.index - right.index);
  const normalized: SubtitleCue[] = [];
  for (const { cue: cleaned } of sorted) {
    const previous = normalized.at(-1);
    // Remove only byte-for-byte duplicate cues at the same time window. Repeated
    // dialogue at a later time is meaningful and must be preserved.
    if (previous && previous.text === cleaned.text && sameTimeWindow(previous, cleaned)) continue;
    normalized.push(cleaned);
  }
  return normalized;
}

/** Parses a downloaded subtitle file into normalized timed cues. */
export function parseSubtitleBuffer(
  input: Buffer | Uint8Array,
  extension: string,
  automaticOrOptions: boolean | SubtitleParseOptions = {},
): SubtitleCue[] {
  const options = typeof automaticOrOptions === "boolean"
    ? { automatic: automaticOrOptions }
    : automaticOrOptions;
  const limits = resolvedLimits(options.limits);
  const text = decodeSubtitleBytes(input, limits.maxBytes);
  const rawCues = parseByFormat(text, extension);
  if (rawCues.length > limits.maxCues) {
    throw new SubtitleTextLimitError("cues", limits.maxCues, rawCues.length);
  }
  const cues = normalizeCueList(rawCues);
  const characterCount = cues.reduce((total, cue) => total + cue.text.length, 0);
  if (characterCount > limits.maxChars) {
    throw new SubtitleTextLimitError("characters", limits.maxChars, characterCount);
  }
  if (cues.length === 0) {
    throw new TextExtractionFailedError("The selected subtitle track did not contain any readable timed text.", {
      extension: normalizedExtension(extension) || null,
    });
  }
  return cues;
}

function timingOverlaps(left: SubtitleCue, right: SubtitleCue): boolean {
  const leftEnd = left.endMs ?? left.startMs;
  const rightEnd = right.endMs ?? right.startMs;
  return right.startMs <= leftEnd && left.startMs <= rightEnd;
}

function mergedPlainText(cues: readonly SubtitleCue[]): string {
  const parts: Array<{ cue: SubtitleCue; text: string }> = [];
  for (const cue of cues) {
    const previous = parts.at(-1);
    if (!previous || !timingOverlaps(previous.cue, cue)) {
      parts.push({ cue, text: cue.text });
      continue;
    }
    if (cue.text === previous.text || previous.text.startsWith(cue.text)) continue;
    if (cue.text.startsWith(previous.text)) {
      parts[parts.length - 1] = { cue, text: cue.text };
      continue;
    }
    parts.push({ cue, text: cue.text });
  }
  return parts.map((part) => part.text).join("\n");
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const fraction = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

/** Builds both the new deterministic response and former transcript aliases. */
export function buildSubtitleResult(
  cues: readonly SubtitleCue[],
  format: MediaFormat,
  limits?: Partial<Pick<SubtitleParseLimits, "maxChars">>,
): ExtractedTextResult {
  const normalizedCues = normalizeCueList([...cues]);
  if (normalizedCues.length === 0) {
    throw new TextExtractionFailedError("The selected subtitle track did not contain any readable timed text.");
  }
  const text = mergedPlainText(normalizedCues);
  const maximum = positiveLimit(limits?.maxChars, DEFAULT_SUBTITLE_PARSE_LIMITS.maxChars);
  if (text.length > maximum) throw new SubtitleTextLimitError("characters", maximum, text.length);
  const timestampedText = normalizedCues.map((cue) => {
    const range = cue.endMs === null
      ? formatTimestamp(cue.startMs)
      : `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`;
    return `[${range}] ${cue.text}`;
  }).join("\n");
  const extension = normalizedExtension(format.ext) || "text";

  return {
    text,
    rawText: text,
    correctedText: text,
    language: format.language?.trim() || "und",
    model: "subtitle-track",
    correctionMode: "none",
    method: "subtitle-track",
    source: format.automatic ? "automatic-caption" : "manual-subtitle",
    trackId: format.id,
    format: extension,
    cueCount: normalizedCues.length,
    segments: normalizedCues,
    timestampedText,
  };
}

export interface SubtitleTextDependencies {
  /**
   * Test/compatibility seam for callers that already prepare a local file.
   * Production extraction uses the bounded remote fetcher below.
   */
  downloadSubtitle?: (
    sourceUrl: string,
    format: MediaFormat,
    config: AppConfig,
  ) => Promise<PreparedMediaFile>;
  fetchSubtitle?: (
    url: string,
    options: {
      maxBytes: number;
      timeoutMs: number;
      idleTimeoutMs?: number;
      maxRedirects?: number;
      headers?: Record<string, string>;
    },
  ) => Promise<Buffer>;
  cleanupPrepared?: (file: PreparedMediaFile) => Promise<void>;
  readSubtitleFile?: (path: string) => Promise<Buffer>;
}

export interface EmbeddedSubtitleInput {
  buffer: Buffer | Uint8Array;
  extension: string;
  language: string;
  streamId: string;
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

/**
 * Deterministic extraction service: download a discovered text track through
 * a DNS-pinned, byte-limited HTTP client, parse it locally, and never route
 * audio through ASR or an AI service.
 */
export class SubtitleTextService {
  private readonly downloadSubtitle?: SubtitleTextDependencies["downloadSubtitle"];
  private readonly fetchSubtitle: NonNullable<SubtitleTextDependencies["fetchSubtitle"]>;
  private readonly cleanupPrepared: NonNullable<SubtitleTextDependencies["cleanupPrepared"]>;
  private readonly readSubtitleFile: NonNullable<SubtitleTextDependencies["readSubtitleFile"]>;

  public constructor(
    private readonly appConfig: AppConfig,
    dependencies: SubtitleTextDependencies = {},
  ) {
    this.downloadSubtitle = dependencies.downloadSubtitle;
    this.fetchSubtitle = dependencies.fetchSubtitle ?? fetchRemoteBuffer;
    this.cleanupPrepared = dependencies.cleanupPrepared ?? cleanupPreparedMedia;
    this.readSubtitleFile = dependencies.readSubtitleFile ?? readFile;
  }

  public async extract(
    sourceUrl: string,
    formats: readonly MediaFormat[],
    options: SubtitleSelectionOptions = {},
  ): Promise<ExtractedTextResult> {
    if (!this.appConfig.textExtractionEnabled) {
      throw new TextExtractionUnavailableError("Deterministic text-track extraction is disabled on this server.");
    }
    const candidates = rankSubtitleFormats(formats, options);
    if (candidates.length === 0) {
      throw new TextTrackNotFoundError(undefined, {
        requestedTrackId: options.trackId ?? options.formatId ?? null,
        requestedLanguage: options.language ?? null,
      });
    }

    const explicitSelection = Boolean((options.trackId ?? options.formatId)?.trim());
    const failures: Array<{ trackId: string; message: string }> = [];
    let deferredInfrastructureError: AppError | undefined;
    for (const candidate of candidates) {
      let prepared: PreparedMediaFile | null = null;
      try {
        let bytes: Buffer;
        let extension = candidate.ext || "";
        if (candidate.inlineData !== undefined) {
          bytes = Buffer.from(candidate.inlineData, "utf8");
        } else if (this.downloadSubtitle) {
          prepared = await this.downloadSubtitle(sourceUrl, candidate, this.appConfig);
          bytes = await this.readSubtitleFile(prepared.filePath);
          extension = prepared.extension || extension;
        } else {
          bytes = await this.fetchSubtitle(candidate.url, {
            maxBytes: this.appConfig.textExtractionMaxBytes,
            timeoutMs: this.appConfig.textExtractionTimeoutMs,
            idleTimeoutMs: Math.min(this.appConfig.textExtractionTimeoutMs, 15_000),
            maxRedirects: 3,
            headers: candidate.httpHeaders,
          });
        }
        const cues = parseSubtitleBuffer(bytes, extension, {
          automatic: Boolean(candidate.automatic),
          limits: {
            maxBytes: this.appConfig.textExtractionMaxBytes,
            maxCues: this.appConfig.textExtractionMaxCues,
            maxChars: this.appConfig.textExtractionMaxChars,
          },
        });
        return buildSubtitleResult(cues, candidate, { maxChars: this.appConfig.textExtractionMaxChars });
      } catch (error) {
        // Limits must never be hidden by fallback. An unavailable executable
        // is shared infrastructure, whereas a single 502 may be an expired
        // track and should fall through to the next ranked candidate.
        if (error instanceof AppError && explicitSelection) {
          throw error;
        }
        failures.push({ trackId: candidate.id, message: errorDiagnostic(error) });
        if (error instanceof AppError && (error.statusCode === 413 || error.statusCode === 503)) {
          deferredInfrastructureError = error;
          // A missing yt-dlp executable affects every provider track. The
          // orchestrator may still recover through the independent embedded path.
          if (error.statusCode === 503) break;
        }
      } finally {
        if (prepared) await this.cleanupPrepared(prepared).catch(() => undefined);
      }
    }

    if (deferredInfrastructureError) throw deferredInfrastructureError;
    throw new TextExtractionFailedError("None of the selected text subtitle tracks could be converted to text.", {
      attempts: failures,
    });
  }

  /** Normalize a text subtitle stream already extracted from a media container. */
  public extractEmbedded(input: EmbeddedSubtitleInput): ExtractedTextResult {
    if (!this.appConfig.textExtractionEnabled) {
      throw new TextExtractionUnavailableError("Deterministic text-track extraction is disabled on this server.");
    }
    const format: MediaFormat = {
      id: input.streamId,
      url: "https://embedded.invalid/subtitle.vtt",
      ext: input.extension,
      mimeType: "text/vtt",
      width: null,
      height: null,
      fps: null,
      bitrateKbps: null,
      filesize: input.buffer.byteLength,
      qualityLabel: input.language,
      videoCodec: null,
      audioCodec: null,
      hasVideo: false,
      hasAudio: false,
      requiresMuxing: false,
      mediaType: "subtitle",
      language: input.language,
      automatic: false,
      httpHeaders: {},
    };
    const cues = parseSubtitleBuffer(input.buffer, input.extension, {
      limits: {
        maxBytes: this.appConfig.textExtractionMaxBytes,
        maxCues: this.appConfig.textExtractionMaxCues,
        maxChars: this.appConfig.textExtractionMaxChars,
      },
    });
    return {
      ...buildSubtitleResult(cues, format, { maxChars: this.appConfig.textExtractionMaxChars }),
      source: "embedded-subtitle",
      method: "subtitle-track",
    };
  }
}
