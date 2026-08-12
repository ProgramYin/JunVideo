import assert from "node:assert/strict";
import test from "node:test";
import { buildYtDlpArgs, parseYtDlpInfo, selectDisplayVideoFormats, type MediaFormat, type ParseRequest } from "./parser.js";

function video(id: string, height: number | null, fps: number | null, bitrateKbps: number): MediaFormat {
  return {
    id,
    url: `https://cdn.example.com/${id}.mp4`,
    ext: "mp4",
    mimeType: "video/mp4",
    width: height === null ? null : Math.round(height * 16 / 9),
    height,
    fps,
    bitrateKbps,
    filesize: null,
    qualityLabel: height === null ? "Video" : `${height}p`,
    videoCodec: "h264",
    audioCodec: null,
    hasVideo: true,
    hasAudio: false,
    requiresMuxing: true,
    httpHeaders: {},
  };
}

test("selectDisplayVideoFormats keeps the highest FPS stream for each resolution", () => {
  const selected = selectDisplayVideoFormats([
    video("720-30", 720, 30, 2_000),
    video("1080-30", 1080, 30, 5_000),
    video("1080-60", 1080, 60, 4_000),
    video("720-60", 720, 60, 1_000),
    video("unknown", null, null, 500),
  ]);

  assert.deepEqual(
    selected.map((format) => format.id),
    ["1080-60", "720-60", "unknown"],
  );
});

test("selectDisplayVideoFormats uses bitrate as the tie breaker", () => {
  const selected = selectDisplayVideoFormats([
    video("1080-low", 1080, 30, 2_000),
    video("1080-high", 1080, 30, 8_000),
  ]);

  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, "1080-high");
});

test("yt-dlp metadata arguments use HTTP timeouts without automatic retries", () => {
  const args = buildYtDlpArgs("https://www.bilibili.com/video/BV1test", {
    ytdlpCookiesFile: undefined,
    ytdlpCookiesFromBrowser: undefined,
    ytdlpRetries: 0,
    ytdlpExtractorRetries: 0,
    ytdlpFragmentRetries: 0,
    ytdlpSocketTimeoutMs: 15_001,
  });

  assert.deepEqual(args.slice(0, 12), [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--retries", "0",
    "--extractor-retries", "0",
    "--fragment-retries", "0",
    "--socket-timeout", "16",
  ]);
  assert.deepEqual(args.slice(-4), ["--dump-single-json", "--skip-download", "--", "https://www.bilibili.com/video/BV1test"]);
});

test("yt-dlp formats normalize string numbers and preserve playable muxed streams", () => {
  const request: ParseRequest = {
    sourceUrl: "https://www.bilibili.com/video/BV1test",
    canonicalUrl: "https://www.bilibili.com/video/BV1test",
    platform: { id: "bilibili", label: "Bilibili", hostname: "bilibili.com", recognized: true },
  };
  const result = parseYtDlpInfo({
    title: "Test video",
    duration: "12.5",
    formats: [
      {
        format_id: "1080",
        url: "https://cdn.example.com/video.mp4",
        ext: "mp4",
        mime: "video/mp4",
        width: "1920",
        height: "1080",
        fps: "60",
        tbr: "4500",
        vcodec: "avc1",
        acodec: "mp4a.40.2",
        http_headers: {
          "User-Agent": "JunVideo test",
          Referer: "https://www.bilibili.com/",
          Cookie: "must-not-forward",
        },
      },
    ],
  }, request);

  assert.equal(result.durationSeconds, 13);
  assert.equal(result.videoFormats[0]?.width, 1920);
  assert.equal(result.videoFormats[0]?.height, 1080);
  assert.equal(result.videoFormats[0]?.fps, 60);
  assert.equal(result.videoFormats[0]?.requiresMuxing, false);
  assert.deepEqual(result.videoFormats[0]?.httpHeaders, {
    "User-Agent": "JunVideo test",
    Referer: "https://www.bilibili.com/",
  });
});
