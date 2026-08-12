import assert from "node:assert/strict";
import test from "node:test";
import type { MediaFormat } from "./parser.js";
import {
  EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_MS,
  MAX_EMBEDDED_MEDIA_BYTES,
  buildEmbeddedSubtitleExtractArgs,
  buildEmbeddedSubtitleProbeArgs,
  isEligibleEmbeddedSubtitleFormat,
  parseEmbeddedSubtitleInventory,
  rankEmbeddedMediaFormats,
  rankEmbeddedSubtitleStreams,
  type EmbeddedSubtitleStream,
} from "./embedded-subtitle.js";

function videoFormat(overrides: Partial<MediaFormat> = {}): MediaFormat {
  return {
    id: "video-1",
    url: "https://cdn.example.com/media/video.mp4",
    ext: "mp4",
    mimeType: "video/mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 2500,
    filesize: 12 * 1024 * 1024,
    qualityLabel: "1080p",
    videoCodec: "h264",
    audioCodec: "aac",
    hasVideo: true,
    hasAudio: true,
    requiresMuxing: false,
    downloadMode: "direct",
    mediaType: "video",
    httpHeaders: { "User-Agent": "JunVideo test", Referer: "https://example.com/watch" },
    ...overrides,
  };
}

test("embedded inspection accepts only bounded safe single-file video formats", () => {
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat()), true);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ filesize: null })), false);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ filesize: MAX_EMBEDDED_MEDIA_BYTES + 1 })), false);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ requiresMuxing: true })), false);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ url: "http://127.0.0.1/private.mp4" })), false);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ url: "https://cdn.example.com/live.m3u8", ext: "m3u8", mimeType: "application/vnd.apple.mpegurl" })), false);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ url: "https://cdn.example.com/manifest.mpd", ext: "mpd", mimeType: "application/dash+xml" })), false);
  assert.equal(isEligibleEmbeddedSubtitleFormat(videoFormat({ hasVideo: false, mediaType: "audio", mimeType: "audio/mp4" })), false);
});

test("media ranking prefers subtitle-friendly containers, direct URLs, then smaller files", () => {
  const formats = [
    videoFormat({ id: "mp4", filesize: 4_000_000 }),
    videoFormat({ id: "mkv-ytdlp", url: "https://cdn.example.com/video.mkv", ext: "mkv", mimeType: "video/x-matroska", downloadMode: "yt-dlp", filesize: 2_000_000 }),
    videoFormat({ id: "mkv-direct-large", url: "https://cdn.example.com/large.mkv", ext: "mkv", mimeType: "video/x-matroska", filesize: 8_000_000 }),
    videoFormat({ id: "mkv-direct-small", url: "https://cdn.example.com/small.mkv", ext: "mkv", mimeType: "video/x-matroska", filesize: 3_000_000 }),
  ];
  assert.deepEqual(rankEmbeddedMediaFormats(formats).map((format) => format.id), [
    "mkv-direct-small",
    "mkv-direct-large",
    "mkv-ytdlp",
    "mp4",
  ]);
});

test("ffprobe arguments enumerate subtitle streams with bounded network input", () => {
  const args = buildEmbeddedSubtitleProbeArgs(videoFormat({
    httpHeaders: {
      "User-Agent": "JunVideo test",
      Referer: "https://example.com/watch",
      "Bad\r\nHeader": "injected",
      Cookie: "bad\r\nX-Evil: true",
    },
  }));
  assert.deepEqual(args.slice(0, 4), ["-hide_banner", "-v", "error", "-nostdin"]);
  assert.ok(args.includes("-protocol_whitelist"));
  assert.ok(args.includes("-select_streams"));
  assert.equal(args[args.indexOf("-select_streams") + 1], "s");
  assert.equal(args[args.indexOf("-of") + 1], "json");
  const headers = args[args.indexOf("-headers") + 1] ?? "";
  assert.match(headers, /Referer: https:\/\/example\.com\/watch\r\n/u);
  assert.match(headers, /User-Agent: JunVideo test\r\n/u);
  assert.doesNotMatch(headers, /Evil|injected|Cookie/u);
});

test("ffmpeg arguments map one subtitle stream and transcode it to bounded VTT", () => {
  const args = buildEmbeddedSubtitleExtractArgs(videoFormat(), 7, "C:\\temp\\subtitle.vtt", 8 * 1024 * 1024);
  assert.equal(args[args.indexOf("-map") + 1], "0:7");
  assert.equal(args[args.indexOf("-c:s") + 1], "webvtt");
  assert.equal(args[args.indexOf("-f") + 1], "webvtt");
  assert.equal(args[args.indexOf("-fs") + 1], String(8 * 1024 * 1024 + 1));
  assert.equal(args[args.indexOf("-rw_timeout") + 1], String(EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_MS * 1_000));
  assert.equal(args.at(-1), "C:\\temp\\subtitle.vtt");
});

test("ffprobe JSON parser accepts text codecs and explicitly classifies bitmap streams", () => {
  const inventory = parseEmbeddedSubtitleInventory(JSON.stringify({
    streams: [
      { index: 2, codec_name: "subrip", codec_type: "subtitle", tags: { language: "eng", title: "English" }, disposition: { default: 1, forced: 0 } },
      { index: "3", codec_name: "mov_text", codec_type: "subtitle", tags: { LANGUAGE: "zh_CN" }, disposition: { default: "0", forced: "1" } },
      { index: 4, codec_name: "hdmv_pgs_subtitle", codec_type: "subtitle" },
      { index: 5, codec_name: "dvd_subtitle", codec_type: "subtitle" },
      { index: 6, codec_name: "unknown_subtitle", codec_type: "subtitle" },
      { index: 7, codec_name: "aac", codec_type: "audio" },
      { index: -1, codec_name: "webvtt", codec_type: "subtitle" },
    ],
  }));
  assert.deepEqual(inventory.textStreams, [
    { index: 2, codec: "subrip", language: "en", title: "English", isDefault: true, isForced: false },
    { index: 3, codec: "mov_text", language: "zh-cn", title: null, isDefault: false, isForced: true },
  ]);
  assert.deepEqual(inventory.rejectedStreams, [
    { index: 4, codec: "hdmv_pgs_subtitle", reason: "bitmap" },
    { index: 5, codec: "dvd_subtitle", reason: "bitmap" },
    { index: 6, codec: "unknown_subtitle", reason: "unsupported-codec" },
  ]);
});

test("stream ranking uses exact/base language, default disposition, and non-forced tracks", () => {
  const streams: EmbeddedSubtitleStream[] = [
    { index: 8, codec: "ass", language: "zh-tw", title: null, isDefault: true, isForced: false },
    { index: 5, codec: "ass", language: "zh-cn", title: null, isDefault: false, isForced: false },
    { index: 3, codec: "ass", language: "en", title: null, isDefault: true, isForced: false },
    { index: 4, codec: "ass", language: "zh-cn", title: null, isDefault: true, isForced: true },
  ];
  assert.deepEqual(rankEmbeddedSubtitleStreams(streams, "zh_CN").map((stream) => stream.index), [4, 5, 8, 3]);
  assert.equal(rankEmbeddedSubtitleStreams(streams)[0]?.index, 3);
});

test("invalid ffprobe output is rejected instead of being treated as no subtitles", () => {
  assert.throws(() => parseEmbeddedSubtitleInventory("not-json"), (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "EMBEDDED_SUBTITLE_PROBE_INVALID"));
  assert.throws(() => parseEmbeddedSubtitleInventory(JSON.stringify({ streams: {} })));
});
