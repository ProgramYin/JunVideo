import assert from "node:assert/strict";
import test from "node:test";
import { safeDownloadFilename, selectMediaFormat, type ParseJobRow } from "./jobs.js";

const row = {
  id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  source_url: "https://example.com/video",
  canonical_url: "https://example.com/video",
  platform: "bilibili",
  status: "succeeded",
  title: "Cover test",
  description: null,
  thumbnail_url: "https://cdn.example.com/images/cover.webp?token=test",
  uploader: null,
  duration_seconds: 10,
  video_formats: [],
  audio_formats: [],
  metadata: {},
  error_code: null,
  error_message: null,
  error_action: null,
  accepted_at: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
  completed_at: new Date(),
} as ParseJobRow;

test("a parsed thumbnail is exposed as a safe image download format", () => {
  const format = selectMediaFormat(row, "image", "thumbnail");
  assert.equal(format.id, "thumbnail");
  assert.equal(format.ext, "webp");
  assert.equal(format.mimeType, "image/webp");
  assert.match(safeDownloadFilename("中文封面", "image", format), /\.webp$/);
});

test("remembered subtitle formats are selectable by id", () => {
  const subtitleRow = {
    ...row,
    metadata: {
      allSubtitleFormats: [{
        id: "subtitle-manual-en-0",
        url: "https://cdn.example.com/en.vtt",
        ext: "vtt",
        mimeType: "text/vtt",
        width: null,
        height: null,
        fps: null,
        bitrateKbps: null,
        filesize: null,
        qualityLabel: "en / English",
        videoCodec: null,
        audioCodec: null,
        hasVideo: false,
        hasAudio: false,
        requiresMuxing: false,
        mediaType: "subtitle",
        language: "en",
        automatic: false,
        httpHeaders: {},
      }],
    },
  } as ParseJobRow;
  const format = selectMediaFormat(subtitleRow, "subtitle", "subtitle-manual-en-0");
  assert.equal(format.language, "en");
  assert.match(safeDownloadFilename("Caption test", "subtitle", format), /\.vtt$/);
});
