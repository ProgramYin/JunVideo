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
  body: JSON.stringify({ name: "Test Cases Smoke", email, password: "JunVideo-cases-123" }),
});
if (registration.response.status !== 201 || !registration.body?.token) {
  throw new Error(`Registration failed: ${JSON.stringify(registration.body)}`);
}

const headers = { authorization: `Bearer ${registration.body.token}` };
const probeBytesLimit = Math.max(16 * 1024, Number.parseInt(process.env.MEDIA_PROBE_BYTES ?? "65536", 10));

function probeVideoFormat(job) {
  const remembered = Array.isArray(job.metadata?.allVideoFormats) ? job.metadata.allVideoFormats : [];
  const candidates = [...remembered, ...(Array.isArray(job.videoFormats) ? job.videoFormats : [])]
    .filter((format, index, values) => format && typeof format.id === "string" && values.findIndex((item) => item?.id === format.id) === index);
  return candidates.sort((left, right) => {
    const leftSize = Number.isFinite(left.filesize) && left.filesize > 0 ? left.filesize : Number.POSITIVE_INFINITY;
    const rightSize = Number.isFinite(right.filesize) && right.filesize > 0 ? right.filesize : Number.POSITIVE_INFINITY;
    return leftSize - rightSize
      || (left.height ?? Number.POSITIVE_INFINITY) - (right.height ?? Number.POSITIVE_INFINITY)
      || (left.bitrateKbps ?? Number.POSITIVE_INFINITY) - (right.bitrateKbps ?? Number.POSITIVE_INFINITY)
      || String(left.id).localeCompare(String(right.id));
  })[0] ?? job.videoFormats?.[0] ?? null;
}

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
const failures = [];
for (const item of cases) {
  try {
    const parsed = await request("/api/parse", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: item.value }),
    });
    const job = parsed.body?.job;
    const error = parsed.body?.error ?? job?.error;
    if (!job || job.platform === "other") {
      failures.push({ name: item.name, stage: "parse", error: "not recognized", details: parsed.body });
      continue;
    }
    if (error?.code === "INVALID_INPUT" || parsed.response.status === 400) {
      failures.push({ name: item.name, stage: "parse", error: error?.message ?? "invalid input", details: parsed.body });
      continue;
    }
    if (parsed.response.status !== 201 || job.status !== "succeeded") {
      failures.push({
        name: item.name,
        stage: "parse",
        error: error?.message ?? `parse did not succeed (HTTP ${parsed.response.status}, job ${job.status})`,
        details: parsed.body,
      });
      continue;
    }
    const imageFormats = Array.isArray(job.imageFormats)
      ? job.imageFormats
      : Array.isArray(job.metadata?.imageFormats)
        ? job.metadata.imageFormats
        : [];
    const downloadableMediaCount = (job.videoFormats?.length ?? 0)
      + (job.audioFormats?.length ?? 0)
      + imageFormats.length;
    if (downloadableMediaCount === 0) {
      failures.push({ name: item.name, stage: "parse", error: "succeeded without downloadable media" });
      continue;
    }
    if (job.sourceUrl !== item.value) {
      failures.push({ name: item.name, stage: "parse", error: "pasted input was rewritten", expected: item.value, actual: job.sourceUrl });
      continue;
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
      imageFormats: imageFormats.length,
      coverAvailable: Boolean(job.thumbnailUrl),
      errorCode: error?.code ?? null,
      error: error?.message ?? null,
    });
    const probeVideo = probeVideoFormat(job);
    const imageSelections = imageFormats.length > 0
      ? [imageFormats[0], imageFormats.at(-1)]
          .filter((format, index, values) => format?.id && values.findIndex((value) => value?.id === format.id) === index)
          .map((format) => ["image", format.id])
      : job.thumbnailUrl
        ? [["image", "thumbnail"]]
        : [];
    const selections = [
      ...(probeVideo ? [["video", probeVideo.id]] : []),
      ...(job.audioFormats?.[0] ? [["audio", job.audioFormats[0].id]] : []),
      ...imageSelections,
    ];
    for (const [kind, formatId] of selections) {
      const media = await probeMedia(job, kind, formatId);
      if (media.status !== 200 || media.probeBytes === 0) {
        failures.push({ name: item.name, stage: `${kind} second phase`, error: media });
        continue;
      }
      secondPhase.push({ name: item.name, ...media });
    }
  } catch (error) {
    failures.push({
      name: item.name,
      stage: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const result = { baseUrl, testCasePath, count: report.length, probeBytesLimit, report, secondPhase, failures };
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
