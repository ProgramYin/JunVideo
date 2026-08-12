import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.JUNVIDEO_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const testCasePath = path.resolve(scriptDirectory, "..", "测试用例.txt");

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = { raw: (await response.text()).slice(0, 300) };
  }
  return { response, body };
}

const source = await readFile(testCasePath, "utf8");
const cases = source
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((value, index) => ({ name: `case-${index + 1}`, value }));

if (cases.length === 0) throw new Error(`No test cases found in ${testCasePath}`);

const email = `test-cases-${crypto.randomUUID()}@example.test`;
const registration = await request("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password: "JunVideo-cases-123" }),
});
if (registration.response.status !== 201 || !registration.body?.token) {
  throw new Error(`Registration failed: ${JSON.stringify(registration.body)}`);
}

const headers = { authorization: `Bearer ${registration.body.token}` };
const probeBytesLimit = Math.max(16 * 1024, Number.parseInt(process.env.MEDIA_PROBE_BYTES ?? "65536", 10));

async function probeMedia(job, kind, formatId) {
  const response = await fetch(
    `${baseUrl}/api/proxy/${encodeURIComponent(job.id)}/${kind}?formatId=${encodeURIComponent(formatId)}`,
    { headers },
  );
  let probeBytes = 0;
  if (response.ok && response.body) {
    for await (const chunk of response.body) {
      probeBytes += chunk.byteLength;
      if (probeBytes >= probeBytesLimit) break;
    }
    await response.body.cancel().catch(() => undefined);
  }
  return {
    kind,
    formatId,
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    probeBytes,
  };
}

const report = [];
const secondPhase = [];
for (const item of cases) {
  const parsed = await request("/api/parse", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: item.value }),
  });
  const job = parsed.body?.job;
  const error = parsed.body?.error ?? job?.error;
  if (!job || job.platform === "other") {
    throw new Error(`${item.name} was not recognized: ${JSON.stringify(parsed.body)}`);
  }
  if (error?.code === "INVALID_INPUT" || parsed.response.status === 400) {
    throw new Error(`${item.name} was rejected before platform parsing: ${JSON.stringify(parsed.body)}`);
  }
  if (job.status === "succeeded" && ((job.videoFormats?.length ?? 0) === 0 || (job.audioFormats?.length ?? 0) === 0 || !job.thumbnailUrl)) {
    throw new Error(`${item.name} succeeded without complete media categories: ${JSON.stringify(job)}`);
  }
  if (job.sourceUrl !== item.value) {
    throw new Error(`${item.name} rewrote the pasted input: expected ${JSON.stringify(item.value)}, got ${JSON.stringify(job.sourceUrl)}`);
  }
  report.push({
    name: item.name,
    input: item.value,
    httpStatus: parsed.response.status,
    platform: job.platform,
    jobStatus: job.status,
    normalizedSourceUrl: job.sourceUrl,
    videoFormats: job.videoFormats?.length ?? 0,
    audioFormats: job.audioFormats?.length ?? 0,
    coverAvailable: Boolean(job.thumbnailUrl),
    errorCode: error?.code ?? null,
    error: error?.message ?? null,
  });
  if (job.status === "succeeded") {
    const selections = [
      ...(job.videoFormats?.[0] ? [["video", job.videoFormats[0].id]] : []),
      ...(job.audioFormats?.[0] ? [["audio", job.audioFormats[0].id]] : []),
      ...(job.thumbnailUrl ? [["image", "thumbnail"]] : []),
    ];
    for (const [kind, formatId] of selections) {
      const media = await probeMedia(job, kind, formatId);
      if (media.status !== 200 || media.probeBytes === 0) {
        throw new Error(`${item.name} ${kind} second phase failed: ${JSON.stringify(media)}`);
      }
      secondPhase.push({ name: item.name, ...media });
    }
  }
}

console.log(JSON.stringify({ baseUrl, testCasePath, count: report.length, probeBytesLimit, report, secondPhase }, null, 2));
