import assert from "node:assert/strict";
import test from "node:test";
import { selectMediaFormat, type ParseJobRow } from "./jobs.js";

const rememberedFormat = {
  id: "1080-60",
  url: "https://cdn.example.com/1080-60.mp4",
  ext: "mp4",
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  fps: 60,
  bitrateKbps: 8_000,
  filesize: null,
  qualityLabel: "1080p / 60fps",
  videoCodec: "h264",
  audioCodec: null,
  hasVideo: true,
  hasAudio: false,
  requiresMuxing: true,
  httpHeaders: {},
};

test("a remembered non-displayed video format remains downloadable by id", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
    source_url: "https://example.com/video",
    canonical_url: "https://example.com/video",
    platform: "bilibili",
    status: "succeeded",
    title: "Remembered format",
    description: null,
    thumbnail_url: null,
    uploader: null,
    duration_seconds: 10,
    video_formats: [],
    audio_formats: [],
    metadata: { allVideoFormats: [rememberedFormat] },
    error_code: null,
    error_message: null,
    error_action: null,
    accepted_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: new Date(),
  } as ParseJobRow;

  assert.equal(selectMediaFormat(row, "video", "1080-60").url, rememberedFormat.url);
});
