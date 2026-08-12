import assert from "node:assert/strict";
import test from "node:test";
import {
  parseResultToColumns,
  safeDownloadFilename,
  selectMediaFormat,
  subtitleFormatsForExtraction,
  toParseJobView,
  type ParseJobRow,
} from "./jobs.js";
import type { MediaFormat, ParseResult } from "./parser.js";

function imageFormat(id: string, url: string): MediaFormat {
  return {
    id,
    url,
    ext: "jpg",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1440,
    fps: null,
    bitrateKbps: null,
    filesize: null,
    qualityLabel: id,
    videoCodec: null,
    audioCodec: null,
    hasVideo: false,
    hasAudio: false,
    requiresMuxing: false,
    downloadMode: "direct",
    mediaType: "image",
    httpHeaders: {},
  };
}

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
  assert.deepEqual(subtitleFormatsForExtraction(subtitleRow).map((candidate) => candidate.id), ["subtitle-manual-en-0"]);
});

test("text extraction uses remembered alternatives and filters malformed tracks", () => {
  const valid = {
    id: "subtitle-manual-en-vtt-0",
    url: "https://cdn.example.com/en.vtt",
    ext: "vtt",
    mimeType: "text/vtt",
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    filesize: null,
    qualityLabel: "en",
    videoCodec: null,
    audioCodec: null,
    hasVideo: false,
    hasAudio: false,
    requiresMuxing: false,
    mediaType: "subtitle" as const,
    language: "en",
    automatic: false,
    httpHeaders: {},
  };
  const subtitleRow = {
    ...row,
    metadata: {
      subtitleFormats: [valid],
      allSubtitleFormats: [
        valid,
        { ...valid, id: "subtitle-manual-en-srt-1", ext: "srt", url: "https://cdn.example.com/en.srt" },
        { ...valid, id: "unsafe", url: "file:///etc/passwd" },
      ],
    },
  } as ParseJobRow;

  assert.deepEqual(subtitleFormatsForExtraction(subtitleRow).map((format) => format.ext), ["vtt", "srt"]);
});

test("persisted image galleries expose every image and keep the thumbnail alias", () => {
  const images = [
    imageFormat("image-1", "https://cdn.example.com/gallery/first.jpg"),
    imageFormat("image-2", "https://cdn.example.com/gallery/second.jpg"),
  ];
  const result: ParseResult = {
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    platform: { id: "xiaohongshu", label: "Xiaohongshu", hostname: "xiaohongshu.com", recognized: true },
    title: "Gallery test",
    description: null,
    thumbnailUrl: images[0]!.url,
    uploader: null,
    durationSeconds: null,
    videoFormats: [],
    audioFormats: [],
    imageFormats: images,
    subtitleFormats: [],
    metadata: {},
    mock: false,
  };
  const columns = parseResultToColumns(result);
  const galleryRow = {
    ...row,
    platform: "xiaohongshu",
    title: columns.title,
    thumbnail_url: columns.thumbnailUrl,
    metadata: JSON.stringify(columns.metadata),
  } as ParseJobRow;

  const view = toParseJobView(galleryRow);
  assert.deepEqual(view.imageFormats.map((format) => format.id), ["image-1", "image-2"]);
  assert.equal(selectMediaFormat(galleryRow, "image", "thumbnail").url, images[0]!.url);
  const second = selectMediaFormat(galleryRow, "image", "image-2");
  assert.equal(second.url, images[1]!.url);
  assert.match(safeDownloadFilename("Gallery test", "image", second), /Gallery test-image-2\.jpg$/);
});
