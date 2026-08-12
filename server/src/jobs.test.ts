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
