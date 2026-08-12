import assert from "node:assert/strict";
import test from "node:test";
import { detectPlatform, extractUrlFromText, isSafeRemoteHttpUrl, normalizeAndValidateUrl, preflightUrl } from "./platform.js";

test("priority platform links are detected without depending on the parser", () => {
  assert.equal(detectPlatform("https://www.douyin.com/video/123").id, "douyin");
  assert.equal(detectPlatform("https://xhslink.com/abc").id, "xiaohongshu");
  assert.equal(detectPlatform("http://xhslink.cn/o/abc").id, "xiaohongshu");
  assert.equal(detectPlatform("https://b23.tv/abc").id, "bilibili");
  assert.equal(preflightUrl("https://www.bilibili.com/video/BV123").platform.recognized, true);
});

test("platform share links without a scheme are normalized to HTTPS", () => {
  assert.equal(normalizeAndValidateUrl("www.douyin.com/video/123"), "https://www.douyin.com/video/123");
  assert.equal(normalizeAndValidateUrl("//www.bilibili.com/video/BV123"), "https://www.bilibili.com/video/BV123");
});

test("Chinese share text and Markdown wrappers yield the embedded video URL", () => {
  assert.equal(
    extractUrlFromText("飞行员下机了😁😁🤭 http://xhslink.cn/o/9Qyw0wGrIUF 前往小红书一探究竟"),
    "http://xhslink.cn/o/9Qyw0wGrIUF",
  );
  assert.equal(
    extractUrlFromText("【视频】 [https://www.bilibili.com/video/BV123/?p=1]"),
    "https://www.bilibili.com/video/BV123/?p=1",
  );
});

test("Markdown link wrappers do not become part of the extracted Bilibili URL", () => {
  const input = "\u3010\u6807\u9898\u3011 [https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1](https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1)";
  assert.equal(
    extractUrlFromText(input),
    "https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1",
  );
  assert.equal(
    normalizeAndValidateUrl(input),
    "https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1",
  );
});

test("URL safety rejects credentials and local destinations", () => {
  assert.equal(isSafeRemoteHttpUrl("https://cdn.example.com/video.mp4"), true);
  assert.equal(isSafeRemoteHttpUrl("http://127.0.0.1:4000/internal"), false);
  assert.equal(isSafeRemoteHttpUrl("http://localhost/internal"), false);
  assert.equal(isSafeRemoteHttpUrl("https://user:pass@example.com/file"), false);
});
