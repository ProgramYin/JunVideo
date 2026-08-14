import assert from "node:assert/strict";
import test from "node:test";
import { buildYtDlpArgs, formatSelectorFor, parseYtDlpInfo, selectDisplayVideoFormats, type MediaFormat, type ParseRequest } from "./parser.js";

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
    ytdlpExtractorArgs: "youtube:player_client=web_embedded,android",
    ytdlpJsRuntimes: "node",
    ytdlpRemoteComponents: "ejs:github",
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
  assert.ok(args.includes("--ignore-no-formats-error"));
  assert.deepEqual(args.slice(12, 18), [
    "--extractor-args", "youtube:player_client=web_embedded,android",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
  ]);
  assert.deepEqual(args.slice(-4), ["--dump-single-json", "--skip-download", "--", "https://www.bilibili.com/video/BV1test"]);
});

test("yt-dlp metadata arguments pass a materialized cookie file to any source", () => {
  const args = buildYtDlpArgs("https://www.douyin.com/video/123", {
    ytdlpCookiesFile: "/tmp/junvideo-ytdlp-cookies/cookies.txt",
    ytdlpCookiesFromBrowser: undefined,
    ytdlpRetries: 0,
    ytdlpExtractorRetries: 0,
    ytdlpFragmentRetries: 0,
    ytdlpSocketTimeoutMs: 15_000,
  });

  assert.deepEqual(args.slice(args.indexOf("--cookies"), args.indexOf("--cookies") + 2), [
    "--cookies", "/tmp/junvideo-ytdlp-cookies/cookies.txt",
  ]);
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

test("separate yt-dlp streams retain a fresh-download audio pairing", () => {
  const request: ParseRequest = {
    sourceUrl: "https://www.bilibili.com/video/BV1test",
    canonicalUrl: "https://www.bilibili.com/video/BV1test",
    platform: { id: "bilibili", label: "Bilibili", hostname: "bilibili.com", recognized: true },
  };
  const result = parseYtDlpInfo({
    title: "Separated streams",
    formats: [
      {
        format_id: "video-1080",
        url: "https://cdn.example.com/video-1080.m4s",
        video_ext: "mp4",
        width: 1920,
        height: 1080,
        vcodec: "avc1",
        acodec: "none",
        tbr: 2_000,
      },
      {
        format_id: "audio-128",
        url: "https://cdn.example.com/audio-128.m4s",
        audio_ext: "m4a",
        vcodec: "none",
        acodec: "mp4a.40.2",
        abr: 128,
      },
    ],
    requested_downloads: [{
      requested_formats: [
        {
          format_id: "video-1080",
          url: "https://cdn.example.com/video-1080.m4s",
          video_ext: "mp4",
          vcodec: "avc1",
          acodec: "none",
          height: 1080,
        },
        {
          format_id: "audio-128",
          url: "https://cdn.example.com/audio-128.m4s",
          audio_ext: "m4a",
          vcodec: "none",
          acodec: "mp4a.40.2",
          abr: 128,
        },
      ],
    }],
  }, request);

  assert.equal(result.videoFormats[0]?.audioFormatId, "audio-128");
  assert.equal(formatSelectorFor(result.videoFormats[0]!), "video-1080+audio-128");
  assert.equal(result.audioFormats[0]?.id, "audio-128");
});

test("browser fallback formats stay on their fresh direct media URLs", () => {
  const result = parseYtDlpInfo({
    browserFallback: true,
    title: "Browser fallback",
    webpage_url: "https://www.douyin.com/video/123",
    formats: [{
      format_id: "browser-quality-0-0",
      url: "https://cdn.example.com/fresh.mp4",
      ext: "mp4",
      mime: "video/mp4",
      vcodec: "h264",
      acodec: "aac",
      width: 720,
      height: 1280,
    }],
  }, {
    sourceUrl: "https://www.douyin.com/video/123",
    canonicalUrl: "https://www.douyin.com/video/123",
    platform: { id: "douyin", label: "Douyin", hostname: "douyin.com", recognized: true },
  });

  assert.equal(result.videoFormats[0]?.downloadMode, "direct");
});

test("Xiaohongshu prefers the official default cover over the low-quality preview", () => {
  const result = parseYtDlpInfo({
    title: "Xiaohongshu cover",
    thumbnail: "http://sns-webpic-qc.xhscdn.com/image!nd_prv_wlteh_jpg_3",
    thumbnails: [
      {
        id: "1",
        url: "http://sns-webpic-qc.xhscdn.com/image!nd_prv_wlteh_jpg_3",
        width: 1080,
        height: 1440,
      },
      {
        id: "0",
        url: "http://sns-webpic-qc.xhscdn.com/image!nd_dft_wlteh_jpg_3",
        width: 1080,
        height: 1440,
      },
    ],
    formats: [{
      format_id: "0",
      url: "https://sns-video-v2.xhscdn.com/video.mp4",
      ext: "mp4",
      vcodec: "h264",
      acodec: "aac",
      width: 720,
      height: 1280,
    }],
  }, {
    sourceUrl: "https://www.xiaohongshu.com/discovery/item/note-test",
    canonicalUrl: "https://www.xiaohongshu.com/discovery/item/note-test",
    platform: { id: "xiaohongshu", label: "Xiaohongshu", hostname: "xiaohongshu.com", recognized: true },
  });

  assert.equal(
    result.thumbnailUrl,
    "https://sns-webpic-qc.xhscdn.com/image!nd_dft_wlteh_jpg_3",
  );
});

test("Xiaohongshu image notes normalize a complete default-quality gallery", () => {
  const result = parseYtDlpInfo({
    title: "Xiaohongshu gallery",
    formats: [],
    thumbnails: [
      { id: "preview-2", url: "http://sns-webpic-qc.xhscdn.com/assets/gallery-2!nd_prv_wlteh_jpg_3", width: 1080, height: 1443 },
      { id: "default-2", url: "http://sns-webpic-qc.xhscdn.com/assets/gallery-2!nd_dft_wlteh_jpg_3", width: 1080, height: 1443 },
      { id: "preview-1", url: "http://sns-webpic-qc.xhscdn.com/assets/gallery-1!nd_prv_wlteh_jpg_3", width: 1080, height: 1443 },
      { id: "default-1", url: "http://sns-webpic-qc.xhscdn.com/assets/gallery-1!nd_dft_wlteh_jpg_3", width: 1080, height: 1443 },
    ],
  }, {
    sourceUrl: "https://www.xiaohongshu.com/discovery/item/gallery-test",
    canonicalUrl: "https://www.xiaohongshu.com/discovery/item/gallery-test",
    platform: { id: "xiaohongshu", label: "Xiaohongshu", hostname: "xiaohongshu.com", recognized: true },
  });

  assert.equal(result.videoFormats.length, 0);
  assert.equal(result.audioFormats.length, 0);
  assert.deepEqual(result.imageFormats.map((format) => format.id), ["image-1", "image-2"]);
  assert.deepEqual(result.imageFormats.map((format) => format.url), [
    "https://sns-webpic-qc.xhscdn.com/assets/gallery-1!nd_dft_wlteh_jpg_3",
    "https://sns-webpic-qc.xhscdn.com/assets/gallery-2!nd_dft_wlteh_jpg_3",
  ]);
  assert.equal(result.thumbnailUrl, result.imageFormats[0]?.url);
  assert.equal(result.imageFormats[0]?.mediaType, "image");
  assert.equal(result.metadata.imageFormatCount, 2);
});

test("Xiaohongshu metadata with no media still fails", () => {
  assert.throws(() => parseYtDlpInfo({ title: "Empty note", formats: [], thumbnails: [] }, {
    sourceUrl: "https://www.xiaohongshu.com/discovery/item/empty-test",
    canonicalUrl: "https://www.xiaohongshu.com/discovery/item/empty-test",
    platform: { id: "xiaohongshu", label: "Xiaohongshu", hostname: "xiaohongshu.com", recognized: true },
  }), /no downloadable video, audio, or image formats/i);
});

test("yt-dlp subtitles prefer manual tracks and retain automatic captions", () => {
  const result = parseYtDlpInfo({
    title: "Captioned video",
    formats: [{
      format_id: "18",
      url: "https://cdn.example.com/video.mp4",
      ext: "mp4",
      vcodec: "h264",
      acodec: "aac",
      height: 360,
    }],
    subtitles: {
      en: [{ ext: "json3", url: "https://cdn.example.com/en.json3" }, { ext: "vtt", url: "https://cdn.example.com/en.vtt", name: "English" }],
    },
    automatic_captions: {
      en: [{ ext: "vtt", url: "https://cdn.example.com/en-auto.vtt" }],
      "zh-Hans": [{ ext: "vtt", url: "https://cdn.example.com/zh-auto.vtt", name: "简体中文" }],
    },
  }, {
    sourceUrl: "https://www.youtube.com/watch?v=test",
    canonicalUrl: "https://www.youtube.com/watch?v=test",
    platform: { id: "youtube", label: "YouTube", hostname: "youtube.com", recognized: true },
  });

  assert.equal(result.subtitleFormats.length, 3);
  assert.equal(result.subtitleFormats[0]?.language, "en");
  assert.equal(result.subtitleFormats[0]?.ext, "vtt");
  assert.equal(result.subtitleFormats[0]?.automatic, false);
  assert.equal(result.subtitleFormats[1]?.language, "en");
  assert.equal(result.subtitleFormats[1]?.automatic, true);
  assert.equal(result.subtitleFormats[2]?.language, "zh-Hans");
  assert.equal(result.subtitleFormats[2]?.automatic, true);
  assert.equal(result.metadata.subtitleFormatCount, 4);
  assert.equal((result.metadata.allSubtitleFormats as MediaFormat[]).length, 4);
});

test("yt-dlp live chat is not exposed as extractable video text", () => {
  const result = parseYtDlpInfo({
    title: "Archived stream",
    formats: [{
      format_id: "18",
      url: "https://cdn.example.com/video.mp4",
      ext: "mp4",
      vcodec: "h264",
      acodec: "aac",
    }],
    subtitles: {
      live_chat: [{ ext: "json3", url: "https://cdn.example.com/chat.json3" }],
      en: [{ ext: "vtt", url: "https://cdn.example.com/en.vtt" }],
    },
  }, {
    sourceUrl: "https://www.youtube.com/watch?v=stream",
    canonicalUrl: "https://www.youtube.com/watch?v=stream",
    platform: { id: "youtube", label: "YouTube", hostname: "youtube.com", recognized: true },
  });

  assert.deepEqual(result.subtitleFormats.map((format) => format.language), ["en"]);
  assert.equal(result.metadata.subtitleFormatCount, 1);
});

test("yt-dlp inline subtitle data is retained as a deterministic text track", () => {
  const result = parseYtDlpInfo({
    title: "Inline captions",
    formats: [{
      format_id: "18",
      url: "https://cdn.example.com/video.mp4",
      ext: "mp4",
      vcodec: "h264",
      acodec: "aac",
    }],
    subtitles: {
      en: [{ ext: "vtt", data: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\ninline" }],
    },
  }, {
    sourceUrl: "https://example.com/watch/inline",
    canonicalUrl: "https://example.com/watch/inline",
    platform: { id: "other", label: "Other", hostname: "example.com", recognized: false },
  });

  const all = result.metadata.allSubtitleFormats as MediaFormat[];
  assert.equal(all.length, 1);
  assert.match(all[0]?.url ?? "", /^https:\/\/inline-subtitle\.invalid\//u);
  assert.match(all[0]?.inlineData ?? "", /^WEBVTT/u);
});
