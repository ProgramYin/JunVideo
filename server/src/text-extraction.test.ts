import assert from "node:assert/strict";
import test from "node:test";
import { TextExtractionFailedError, TextTrackNotFoundError } from "./errors.js";
import type { PreparedEmbeddedSubtitle } from "./embedded-subtitle.js";
import type { MediaFormat } from "./parser.js";
import type { ExtractedTextResult } from "./subtitle-text.js";
import { extractVideoText, serializeExtractedTextResult } from "./text-extraction.js";

function format(id: string, mediaType: "video" | "subtitle"): MediaFormat {
  return {
    id,
    url: `https://cdn.example.com/${id}.${mediaType === "video" ? "mp4" : "vtt"}`,
    ext: mediaType === "video" ? "mp4" : "vtt",
    mimeType: mediaType === "video" ? "video/mp4" : "text/vtt",
    width: mediaType === "video" ? 640 : null,
    height: mediaType === "video" ? 360 : null,
    fps: mediaType === "video" ? 30 : null,
    bitrateKbps: null,
    filesize: mediaType === "video" ? 1_000_000 : 100,
    qualityLabel: id,
    videoCodec: mediaType === "video" ? "h264" : null,
    audioCodec: mediaType === "video" ? "aac" : null,
    hasVideo: mediaType === "video",
    hasAudio: mediaType === "video",
    requiresMuxing: false,
    mediaType,
    language: mediaType === "subtitle" ? "en" : null,
    automatic: false,
    httpHeaders: {},
  };
}

function result(source: ExtractedTextResult["source"]): ExtractedTextResult {
  return {
    text: "hello",
    rawText: "hello",
    correctedText: "hello",
    language: "en",
    model: "subtitle-track",
    correctionMode: "none",
    method: "subtitle-track",
    source,
    trackId: source === "embedded-subtitle" ? "embedded-0" : "subtitle-en",
    format: "vtt",
    cueCount: 1,
    segments: [{ startMs: 0, endMs: 1000, text: "hello" }],
    timestampedText: "[00:00:00.000 --> 00:00:01.000] hello",
  };
}

const embedded: PreparedEmbeddedSubtitle = {
  buffer: Buffer.from("WEBVTT"),
  extension: "vtt",
  contentType: "text/vtt; charset=utf-8",
  language: "en",
  streamIndex: 2,
  streamId: "embedded-video-2",
  sourceFormatId: "video",
  sourceCodec: "webvtt",
};

test("provider subtitle succeeds without probing the media container", async () => {
  let embeddedCalls = 0;
  const actual = await extractVideoText({
    sourceUrl: "https://example.com/watch/1",
    subtitleFormats: [format("subtitle-en", "subtitle")],
    videoFormats: [format("video", "video")],
  }, {
    extract: async () => result("manual-subtitle"),
    extractEmbedded: () => result("embedded-subtitle"),
  }, {
    extract: async () => { embeddedCalls += 1; return embedded; },
  });
  assert.equal(actual.source, "manual-subtitle");
  assert.equal(embeddedCalls, 0);
});

test("stale provider tracks fall back to an embedded text stream", async () => {
  const actual = await extractVideoText({
    sourceUrl: "https://example.com/watch/1",
    subtitleFormats: [format("subtitle-en", "subtitle")],
    videoFormats: [format("video", "video")],
  }, {
    extract: async () => { throw new TextExtractionFailedError("stale track"); },
    extractEmbedded: (input) => {
      assert.equal(input.streamId, embedded.streamId);
      return result("embedded-subtitle");
    },
  }, { extract: async () => embedded });
  assert.equal(actual.source, "embedded-subtitle");
});

test("explicit track selection never silently changes to an embedded stream", async () => {
  let embeddedCalls = 0;
  await assert.rejects(() => extractVideoText({
    sourceUrl: "https://example.com/watch/1",
    subtitleFormats: [format("subtitle-en", "subtitle")],
    videoFormats: [format("video", "video")],
    options: { trackId: "subtitle-en" },
  }, {
    extract: async () => { throw new TextExtractionFailedError("selected track failed"); },
    extractEmbedded: () => result("embedded-subtitle"),
  }, {
    extract: async () => { embeddedCalls += 1; return embedded; },
  }), /selected track failed/u);
  assert.equal(embeddedCalls, 0);
});

test("an unknown explicit track is rejected before embedded inspection", async () => {
  await assert.rejects(() => extractVideoText({
    sourceUrl: "https://example.com/watch/1",
    subtitleFormats: [],
    videoFormats: [format("video", "video")],
    options: { trackId: "missing" },
  }, {
    extract: async () => result("manual-subtitle"),
    extractEmbedded: () => result("embedded-subtitle"),
  }, { extract: async () => embedded }), (error: unknown) =>
    error instanceof TextTrackNotFoundError && error.code === "TEXT_TRACK_NOT_FOUND");
});

test("modern responses avoid duplicate transcript payloads unless requested", () => {
  const full = result("manual-subtitle");
  const modern = serializeExtractedTextResult(full);
  assert.equal(modern.text, "hello");
  assert.equal(modern.rawText, undefined);
  assert.equal(modern.correctedText, undefined);
  assert.equal(modern.segments, undefined);
  assert.equal(modern.timestampedText, undefined);

  const legacy = serializeExtractedTextResult(full, { legacy: true, includeTimestamps: true });
  assert.equal(legacy.rawText, "hello");
  assert.deepEqual(legacy.segments, full.segments);
});

test("disabled extraction fails before probing embedded media", async () => {
  let embeddedCalls = 0;
  await assert.rejects(() => extractVideoText({
    sourceUrl: "https://example.com/watch/1",
    subtitleFormats: [],
    videoFormats: [format("video", "video")],
    enabled: false,
  }, {
    extract: async () => result("manual-subtitle"),
    extractEmbedded: () => result("embedded-subtitle"),
  }, {
    extract: async () => { embeddedCalls += 1; return embedded; },
  }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
    && error.code === "TEXT_EXTRACTION_UNAVAILABLE"));
  assert.equal(embeddedCalls, 0);
});
