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
