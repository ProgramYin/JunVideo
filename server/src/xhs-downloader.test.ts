import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { extractXhsInfoWithDownloader } from "./xhs-downloader.js";

test("XHS-Downloader API data is normalized into video streams and cover metadata", async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/xhs/detail");
    let requestBody = "";
    for await (const chunk of request) requestBody += chunk.toString();
    assert.deepEqual(JSON.parse(requestBody), {
      url: "https://www.xiaohongshu.com/explore/note-test-1",
      download: false,
      cookie: "a=b",
      proxy: "http://127.0.0.1:7890",
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: {
        noteId: "note-test-1",
        type: "video",
        title: "公开测试视频",
        desc: "测试描述",
        user: { nickname: "JunVideo test" },
        imageList: [{ urlDefault: "https://sns-webpic-qc.xhscdn.com/123/abc/cover.jpg!" }],
        video: {
          consumer: { originVideoKey: "video/original.mp4" },
          media: {
            stream: {
              h264: [{
                masterUrl: "https://sns-video-bd.xhscdn.com/video/720.mp4",
                width: 1280,
                height: 720,
                videoBitrate: 900_000,
                fps: 30,
                size: 1024,
              }],
            },
          },
        },
      },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const info = await extractXhsInfoWithDownloader("https://www.xiaohongshu.com/explore/note-test-1", {
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2_000,
      cookie: "a=b",
      proxy: "http://127.0.0.1:7890",
    });
    assert.equal(info.extractor, "xhs-downloader-api");
    assert.equal(info.title, "公开测试视频");
    assert.equal(info.thumbnail, "https://sns-webpic-qc.xhscdn.com/123/abc/cover.jpg!");
    assert.equal(Array.isArray(info.formats), true);
    assert.equal((info.formats as unknown[]).length, 2);
    assert.equal((info.formats as Array<Record<string, unknown>>)[1].height, 720);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("localized XHS-Downloader image-note data preserves the complete gallery", async () => {
  const gallery = [
    "https://ci.xiaohongshu.com/gallery-first?imageView2/format/jpeg",
    "https://ci.xiaohongshu.com/gallery-second?imageView2/format/jpeg",
    "https://ci.xiaohongshu.com/gallery-third?imageView2/format/jpeg",
  ];
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/xhs/detail");
    let requestBody = "";
    for await (const chunk of request) requestBody += chunk.toString();
    assert.deepEqual(JSON.parse(requestBody), {
      url: "https://www.xiaohongshu.com/explore/note-gallery",
      download: false,
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      message: "获取小红书作品数据成功",
      data: {
        作品类型: "图文",
        作品ID: "note-gallery",
        作品标题: "图文测试",
        作品描述: "三张有序图片",
        作者昵称: "JunVideo test",
        下载地址: [...gallery, gallery[1], "javascript:alert(1)"],
        动图地址: [null, null, null],
      },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const info = await extractXhsInfoWithDownloader("https://www.xiaohongshu.com/explore/note-gallery", {
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2_000,
    });
    assert.equal(info.id, "note-gallery");
    assert.equal(info.title, "图文测试");
    assert.equal(info.uploader, "JunVideo test");
    assert.equal(info.thumbnail, gallery[0]);
    assert.equal((info.formats as unknown[]).length, 0);
    const images = info.image_formats as Array<Record<string, unknown>>;
    assert.deepEqual(images.map((image) => image.url), gallery);
    assert.deepEqual(images.map((image) => image.format_id), ["image-1", "image-2", "image-3"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("localized XHS-Downloader video data remains a playable video format", async () => {
  const videoUrl = "https://sns-video-bd.xhscdn.com/video/localized.mp4";
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      data: {
        作品类型: "视频",
        作品ID: "note-video-localized",
        作品标题: "视频测试",
        作者昵称: "JunVideo test",
        下载地址: [videoUrl],
      },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const info = await extractXhsInfoWithDownloader("https://www.xiaohongshu.com/explore/note-video-localized", {
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2_000,
    });
    const formats = info.formats as Array<Record<string, unknown>>;
    assert.equal(info.title, "视频测试");
    assert.equal(formats.length, 1);
    assert.equal(formats[0]?.url, videoUrl);
    assert.equal(formats[0]?.format_id, "xhs-video-0");
    assert.equal((info.image_formats as unknown[]).length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
