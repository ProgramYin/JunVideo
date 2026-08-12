import assert from "node:assert/strict";
import test from "node:test";
import { parseBody, rawInputFromBody, textExtractionBodySchema, urlFromBody } from "./validation.js";

test("raw pasted share text is retained while URL extraction stays internal", () => {
  const input = "\u3010Bilibili \u6807\u9898\u3011 https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1";
  assert.equal(rawInputFromBody({ url: input }), input);
  assert.equal(urlFromBody({ url: input }), "https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1");
});

test("text extraction accepts track selection but rejects the retired ASR model option", () => {
  assert.deepEqual(parseBody(textExtractionBodySchema, {
    trackId: "subtitle-manual-zh-Hans-0",
    language: "zh-Hans",
  }), {
    trackId: "subtitle-manual-zh-Hans-0",
    language: "zh-Hans",
  });
  assert.throws(
    () => parseBody(textExtractionBodySchema, { model: "tiny" }),
    /validation failed/i,
  );
});
