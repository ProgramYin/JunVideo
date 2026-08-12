import assert from "node:assert/strict";
import test from "node:test";
import { buildYtDlpDownloadArgs, buildYtDlpSubtitleArgs } from "./media-download.js";
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

test("yt-dlp subtitle args refresh the selected automatic caption language", () => {
  const subtitle: MediaFormat = {
    ...separatedVideo,
    id: "subtitle-auto-zh-Hans-0",
    url: "https://cdn.example.com/caption.vtt",
    ext: "vtt",
    mimeType: "text/vtt",
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    videoCodec: null,
    audioCodec: null,
    hasVideo: false,
    hasAudio: false,
    requiresMuxing: false,
    mediaType: "subtitle",
    language: "zh-Hans",
    automatic: true,
  };
  const args = buildYtDlpSubtitleArgs("https://www.youtube.com/watch?v=test", subtitle, "C:\\temp\\subtitle.%(ext)s", {
    ytdlpCookiesFile: undefined,
    ytdlpCookiesFromBrowser: undefined,
    ytdlpRetries: 0,
    ytdlpExtractorRetries: 0,
    ytdlpFragmentRetries: 0,
    ytdlpSocketTimeoutMs: 15_000,
    ffmpegPath: "ffmpeg",
  });

  assert.ok(args.includes("--write-auto-subs"));
  assert.equal(args[args.indexOf("--sub-langs") + 1], "zh-Hans");
  assert.equal(args[args.indexOf("--sub-format") + 1], "vtt/best");
});

test("yt-dlp subtitle args never request audio, video, ASR, or subtitle conversion", () => {
  const subtitle: MediaFormat = {
    ...separatedVideo,
    id: "subtitle-manual-en-0",
    url: "https://cdn.example.com/caption.srt",
    ext: "srt",
    mimeType: "text/plain",
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    videoCodec: null,
    audioCodec: null,
    hasVideo: false,
    hasAudio: false,
    requiresMuxing: false,
    mediaType: "subtitle",
    language: "en",
    automatic: false,
  };
  const args = buildYtDlpSubtitleArgs("https://example.com/watch/1", subtitle, "subtitle.%(ext)s", {
    ytdlpCookiesFile: undefined,
    ytdlpCookiesFromBrowser: undefined,
    ytdlpRetries: 0,
    ytdlpExtractorRetries: 0,
    ytdlpFragmentRetries: 0,
    ytdlpSocketTimeoutMs: 15_000,
    ffmpegPath: "ffmpeg",
  });

  assert.ok(args.includes("--skip-download"));
  assert.ok(args.includes("--write-subs"));
  assert.equal(args.includes("--extract-audio"), false);
  assert.equal(args.includes("--write-auto-subs"), false);
  assert.equal(args.includes("--convert-subs"), false);
});
