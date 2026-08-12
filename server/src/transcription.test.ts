import assert from "node:assert/strict";
import test from "node:test";
import { buildFfmpegArgs, correctTranscript } from "./transcription.js";

test("transcript correction fixes common Chinese ASR errors without rewriting wording", () => {
  assert.equal(correctTranscript("今天讲克服问题，最后做富盘。"), "今天讲客服问题，最后做复盘。");
});

test("ffmpeg receives yt-dlp request headers and extracts mono 16k audio", () => {
  const args = buildFfmpegArgs({
    id: "video",
    url: "https://cdn.example.com/video.mp4",
    ext: "mp4",
    mimeType: "video/mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 1000,
    filesize: null,
    qualityLabel: "1080p",
    videoCodec: "h264",
    audioCodec: "aac",
    hasVideo: true,
    hasAudio: true,
    requiresMuxing: false,
    httpHeaders: { Referer: "https://example.com", "User-Agent": "JunVideo test" },
  }, "C:\\temp\\junvideo-audio.wav");
  assert.ok(args.includes("-headers"));
  assert.ok(args.includes("-ar"));
  assert.ok(args.includes("16000"));
  assert.equal(args.at(-1), "C:\\temp\\junvideo-audio.wav");
});
