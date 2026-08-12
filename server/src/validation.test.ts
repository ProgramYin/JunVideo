import assert from "node:assert/strict";
import test from "node:test";
import { rawInputFromBody, urlFromBody } from "./validation.js";

test("raw pasted share text is retained while URL extraction stays internal", () => {
  const input = "\u3010Bilibili \u6807\u9898\u3011 https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1";
  assert.equal(rawInputFromBody({ url: input }), input);
  assert.equal(urlFromBody({ url: input }), "https://www.bilibili.com/video/BV1V1GF6dE3z/?p=1");
});
