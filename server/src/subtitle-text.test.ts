import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { MediaFormat } from "./parser.js";
import {
  SubtitleTextService,
  SubtitleTextLimitError,
  buildSubtitleResult,
  decodeSubtitleBytes,
  parseSubtitleBuffer,
  rankSubtitleFormats,
} from "./subtitle-text.js";

function subtitle(
  id: string,
  language: string,
  ext: string,
  automatic = false,
  qualityLabel: string | null = language,
): MediaFormat {
  return {
    id,
    url: `https://example.com/${id}.${ext}`,
    ext,
    mimeType: "text/plain",
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    filesize: null,
    qualityLabel,
    videoCodec: null,
    audioCodec: null,
    hasVideo: false,
    hasAudio: false,
    requiresMuxing: false,
    mediaType: "subtitle",
    language,
    automatic,
    httpHeaders: {},
  };
}

test("subtitle ranking filters non-dialogue tracks and prefers requested manual language", () => {
  const formats = [
    subtitle("auto-en", "en-US", "vtt", true),
    subtitle("manual-zh", "zh-Hans", "ass"),
    subtitle("manual-en", "en", "srt"),
    subtitle("chat", "live_chat", "vtt"),
    subtitle("comments", "zh", "vtt", false, "danmaku comments"),
  ];
  assert.deepEqual(
    rankSubtitleFormats(formats, { language: "en-GB" }).map((format) => format.id),
    ["manual-en", "auto-en", "manual-zh"],
  );
  assert.deepEqual(rankSubtitleFormats(formats, { trackId: "auto-en" }).map((format) => format.id), ["auto-en"]);
  assert.deepEqual(rankSubtitleFormats(formats, { formatId: "missing" }), []);
});

test("subtitle bytes decode UTF-8 and both UTF-16 byte orders with an explicit cap", () => {
  assert.equal(decodeSubtitleBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x69])), "Hi");
  assert.equal(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hi", "utf16le")])), "Hi");
  assert.equal(decodeSubtitleBytes(Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])), "Hi");
  assert.throws(
    () => decodeSubtitleBytes(Buffer.from("too large"), 3),
    (error: unknown) => error instanceof SubtitleTextLimitError && error.code === "TEXT_TRACK_TOO_LARGE",
  );
});

test("VTT parsing skips directives, removes markup, and decodes entities", () => {
  const cues = parseSubtitleBuffer(Buffer.from(`WEBVTT

NOTE generated metadata
do not expose this

00:00:01.000 --> 00:00:03.500 align:start
<v Alice>Hello &amp; <b>welcome</b></v>

00:00:03.500 --> 00:00:05.000
Second line<br>continues
`), "vtt");
  assert.deepEqual(cues, [
    { startMs: 1_000, endMs: 3_500, text: "Hello & welcome" },
    { startMs: 3_500, endMs: 5_000, text: "Second line\ncontinues" },
  ]);
});

test("SRT parsing handles BOM, comma milliseconds, cue ids, and multiline text", () => {
  const cues = parseSubtitleBuffer(Buffer.from(`\uFEFF1\r\n00:00:00,250 --> 00:00:01,500\r\nLine one\r\nLine two\r\n`), "srt");
  assert.deepEqual(cues, [{ startMs: 250, endMs: 1_500, text: "Line one\nLine two" }]);
});

test("ASS parsing follows the Events format and preserves commas in dialogue", () => {
  const cues = parseSubtitleBuffer(Buffer.from(`[Script Info]
Title: demo
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:03.45,Default,A,0,0,0,,{\\an8}Hello, world\\Nnext line
Comment: 0,0:00:03.45,0:00:04.00,Default,A,0,0,0,,ignored
`), "ass");
  assert.deepEqual(cues, [{ startMs: 1_200, endMs: 3_450, text: "Hello, world\nnext line" }]);
});

test("TTML and YouTube SRV variants are parsed without an XML runtime", () => {
  const ttml = parseSubtitleBuffer(Buffer.from(`<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
  <p begin="1.5s" end="3s"><span>Hello</span><br/>world &amp; all</p>
</div></body></tt>`), "ttml");
  assert.deepEqual(ttml, [{ startMs: 1_500, endMs: 3_000, text: "Hello\nworld & all" }]);

  const srv3 = parseSubtitleBuffer(Buffer.from(`<timedtext><body>
<p t="1250" d="500"><s>first</s></p>
<p t="1750" d="750">second</p>
</body></timedtext>`), "srv3");
  assert.deepEqual(srv3, [
    { startMs: 1_250, endMs: 1_750, text: "first" },
    { startMs: 1_750, endMs: 2_500, text: "second" },
  ]);

  const srv1 = parseSubtitleBuffer(Buffer.from(`<transcript><text start="2.5" dur="1.25">legacy</text></transcript>`), "srv1");
  assert.deepEqual(srv1, [{ startMs: 2_500, endMs: 3_750, text: "legacy" }]);
});

test("JSON3 joins segments and ignores window-only events", () => {
  const cues = parseSubtitleBuffer(Buffer.from(JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1_200, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 1_200, dDurationMs: 100, wWinId: 1 },
    ],
  })), "json3", true);
  assert.deepEqual(cues, [{ startMs: 0, endMs: 1_200, text: "Hello world" }]);
});

test("LRC parses repeated timestamps, applies offset, and infers cue ends", () => {
  const cues = parseSubtitleBuffer(Buffer.from(`[offset:100]
[00:01.50][00:03.000]chorus
[00:04.25]ending
`), "lrc");
  assert.deepEqual(cues, [
    { startMs: 1_600, endMs: 3_100, text: "chorus" },
    { startMs: 3_100, endMs: 4_350, text: "chorus" },
    { startMs: 4_350, endMs: null, text: "ending" },
  ]);
});

test("result keeps compatibility fields and conservatively collapses rolling captions", () => {
  const format = subtitle("auto-zh", "zh-Hans", "vtt", true);
  const result = buildSubtitleResult([
    { startMs: 0, endMs: 2_000, text: "今天" },
    { startMs: 1_000, endMs: 3_000, text: "今天 天气很好" },
    { startMs: 3_000, endMs: 4_000, text: "再见" },
  ], format);
  assert.equal(result.text, "今天 天气很好\n再见");
  assert.equal(result.rawText, result.text);
  assert.equal(result.correctedText, result.text);
  assert.equal(result.model, "subtitle-track");
  assert.equal(result.correctionMode, "none");
  assert.equal(result.source, "automatic-caption");
  assert.equal(result.trackId, "auto-zh");
  assert.equal(result.cueCount, 3);
  assert.match(result.timestampedText, /00:00:01\.000 --> 00:00:03\.000/u);
});

test("cue and character limits fail with a stable resource error", () => {
  const twoCues = Buffer.from(`WEBVTT

00:00:00.000 --> 00:00:01.000
a

00:00:01.000 --> 00:00:02.000
b
`);
  assert.throws(
    () => parseSubtitleBuffer(twoCues, "vtt", { limits: { maxCues: 1 } }),
    (error: unknown) => error instanceof SubtitleTextLimitError
      && error.code === "TEXT_TRACK_TOO_LARGE"
      && error.details?.limitType === "cues",
  );
  assert.throws(
    () => parseSubtitleBuffer(twoCues, "vtt", { limits: { maxChars: 1 } }),
    (error: unknown) => error instanceof SubtitleTextLimitError && error.details?.limitType === "characters",
  );
});

test("cues are stably sorted and invalid zero-duration cues are discarded", () => {
  const cues = parseSubtitleBuffer(Buffer.from(`WEBVTT

00:00:02.000 --> 00:00:03.000
later

00:00:01.000 --> 00:00:02.000
same time first

00:00:01.000 --> 00:00:01.000
invalid

00:00:01.000 --> 00:00:02.500
same time second
`), "vtt");
  assert.deepEqual(cues.map((cue) => cue.text), ["same time first", "same time second", "later"]);
});

function extractionConfig(): AppConfig {
  return {
    textExtractionEnabled: true,
    textExtractionMaxBytes: 8 * 1024 * 1024,
    textExtractionMaxCues: 20_000,
    textExtractionMaxChars: 2_000_000,
  } as AppConfig;
}

test("service falls back after a candidate-specific download failure", async () => {
  const attempts: string[] = [];
  const service = new SubtitleTextService(extractionConfig(), {
    downloadSubtitle: async (_sourceUrl, format) => {
      attempts.push(format.id);
      if (format.id === "manual") {
        throw new AppError(502, "SUBTITLE_DOWNLOAD_FAILED", "expired");
      }
      return { filePath: "memory.vtt", workDir: "memory", extension: "vtt", contentType: "text/vtt" };
    },
    readSubtitleFile: async () => Buffer.from(`WEBVTT

00:00:00.000 --> 00:00:01.000
fallback text
`),
    cleanupPrepared: async () => undefined,
  });
  const result = await service.extract("https://example.com/video", [
    subtitle("manual", "en", "vtt"),
    subtitle("automatic", "en", "vtt", true),
  ]);
  assert.deepEqual(attempts, ["manual", "automatic"]);
  assert.equal(result.text, "fallback text");
  assert.equal(result.trackId, "automatic");
});

test("service preserves errors for an explicitly selected track", async () => {
  const expected = new AppError(502, "SUBTITLE_DOWNLOAD_FAILED", "expired");
  const service = new SubtitleTextService(extractionConfig(), {
    downloadSubtitle: async () => { throw expected; },
    cleanupPrepared: async () => undefined,
  });
  await assert.rejects(
    service.extract("https://example.com/video", [subtitle("manual", "en", "vtt")], { trackId: "manual" }),
    (error: unknown) => error === expected,
  );
});
