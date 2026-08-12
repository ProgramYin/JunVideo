import assert from "node:assert/strict";
import crypto from "node:crypto";

const baseUrl = (process.env.JUNVIDEO_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const email = `smoke-${crypto.randomUUID()}@example.test`;
const password = "JunVideo-smoke-123";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Some health failures may be returned by an upstream proxy without JSON.
  }
  return { response, body };
}

const health = await request("/api/health");
assert.ok(health.body && health.body.service === "junvideo-api", "health response identifies the API");

const registration = await request("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Backend Smoke", email, password }),
});
assert.equal(registration.response.status, 201, "registration succeeds");
assert.ok(registration.body?.token, "registration returns a JWT");
assert.equal(registration.body?.user?.name, "Backend Smoke", "registration persists the supplied account name");

const wrongLogin = await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password: "wrong-password" }),
});
assert.equal(wrongLogin.response.status, 401, "wrong password is rejected");

const login = await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
assert.equal(login.response.status, 200, "login succeeds");
const token = login.body?.token;
assert.ok(token, "login returns a JWT");
const authHeaders = { authorization: `Bearer ${token}` };

for (const [url, expectedPlatform] of [
  ["https://www.douyin.com/video/123", "douyin"],
  ["https://www.xiaohongshu.com/explore/abc", "xiaohongshu"],
  ["https://www.bilibili.com/video/BV123", "bilibili"],
]) {
  const preflight = await request("/api/parse/preflight", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ url }),
  });
  assert.equal(preflight.response.status, 200, `${expectedPlatform} preflight succeeds`);
  assert.equal(preflight.body?.platform?.id, expectedPlatform, `${expectedPlatform} is recognized`);
}

const usage = await request("/api/usage", { headers: authHeaders });
assert.equal(usage.response.status, 200, "usage endpoint succeeds");
assert.equal(usage.body?.usage?.used, 0, "new account starts with zero accepted attempts");

console.log(`Backend smoke checks passed against ${baseUrl}.`);
console.log("Set BACKEND_SMOKE_PARSE=true and run against PARSER_MODE=mock to exercise the quota boundary.");

if (process.env.BACKEND_SMOKE_PARSE === "true") {
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const parsed = await request("/api/parse", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: `https://www.bilibili.com/video/BVsmoke${attempt}` }),
    });
    if (attempt <= 10) {
      assert.notEqual(parsed.response.status, 429, `attempt ${attempt} is within the quota`);
    } else {
      assert.equal(parsed.response.status, 429, "the 11th normal parse attempt is rejected");
    }
  }
  console.log("Quota boundary check passed.");

  const activation = await request("/api/dev/vip/activate", {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(activation.response.status, 200, "development VIP activation succeeds");
  const vipParse = await request("/api/parse", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ url: "https://www.bilibili.com/video/BVvip-smoke" }),
  });
  assert.notEqual(vipParse.response.status, 429, "VIP bypasses the daily quota");
  console.log("VIP bypass check passed.");
}
