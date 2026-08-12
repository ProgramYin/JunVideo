import assert from "node:assert/strict";
import test from "node:test";
import { isTransientMediaStatus } from "./routes.js";

test("media proxy retries transient upstream statuses only", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientMediaStatus(status), true, `status ${status} should be retried`);
  }
  for (const status of [200, 206, 301, 302, 400, 401, 403, 404, 410]) {
    assert.equal(isTransientMediaStatus(status), false, `status ${status} should not be retried`);
  }
});
