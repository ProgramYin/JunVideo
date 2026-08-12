import assert from "node:assert/strict";
import test from "node:test";
import { selectDisplayVideoFormats, type MediaFormat } from "./parser.js";

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
