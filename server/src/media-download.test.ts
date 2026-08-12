import assert from "node:assert/strict";
import test from "node:test";
import { buildYtDlpDownloadArgs } from "./media-download.js";
import type { MediaFormat } from "./parser.js";

const separatedVideo: MediaFormat = {
  id: "30080",
  url: "https://cdn.example.com/video.m4s",
  ext: "mp4",
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 2_000,
  filesize: null,
  qualityLabel: "1080p",
  videoCodec: "avc1",
  audioCodec: "none",
  hasVideo: true,
  hasAudio: false,
  requiresMuxing: true,
  audioFormatId: "30280",
  httpHeaders: {},
};

test("yt-dlp download args select the retained video/audio pair and mp4 merge", () => {
  const args = buildYtDlpDownloadArgs(
    "https://www.bilibili.com/video/BV1test",
    separatedVideo,
    "C:\\temp\\junvideo-download\\media.%(ext)s",
    {
      ytdlpCookiesFile: undefined,
      ytdlpCookiesFromBrowser: undefined,
      ytdlpRetries: 0,
      ytdlpExtractorRetries: 0,
      ytdlpFragmentRetries: 0,
      ytdlpSocketTimeoutMs: 15_000,
      ffmpegPath: "ffmpeg",
    },
  );

  assert.deepEqual(args.slice(-8), [
    "--ffmpeg-location", "ffmpeg",
    "--no-part",
    "--no-mtime",
    "--output", "C:\\temp\\junvideo-download\\media.%(ext)s",
    "--", "https://www.bilibili.com/video/BV1test",
  ]);
  assert.equal(args[args.indexOf("--format") + 1], "30080+30280");
  assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4");
});
