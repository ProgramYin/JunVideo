import crypto from "node:crypto";

const baseUrl = (process.env.JUNVIDEO_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const rounds = Math.max(1, Number.parseInt(process.env.THREE_ROUNDS ?? "3", 10));
const probeBytesLimit = Math.max(16 * 1024, Number.parseInt(process.env.MEDIA_PROBE_BYTES ?? "65536", 10));
const sources = [
  { name: "douyin-short", url: "https://v.douyin.com/nVeucapm4UM/" },
  { name: "xiaohongshu-short", url: "http://xhslink.cn/o/9Qyw0wGrIUF" },
  { name: "bilibili", url: "https://www.bilibili.com/video/BV1V1GF6dE3z/" },
];

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Media responses are intentionally handled as streams below.
  }
  return { response, body };
}

async function register(round) {
  const email = `priority-${round}-${crypto.randomUUID()}@example.test`;
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "JunVideo-priority-123" }),
  });
  if (result.response.status !== 201 || !result.body?.token) {
    throw new Error(`round ${round} registration failed: ${JSON.stringify(result.body)}`);
  }
  return result.body.token;
}

async function probeMedia(token, job, kind, formatId) {
  const response = await fetch(
    `${baseUrl}/api/proxy/${encodeURIComponent(job.id)}/${kind}?formatId=${encodeURIComponent(formatId)}`,
    { headers: { authorization: `Bearer ${token}` } },
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
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    probeBytes,
  };
}

const report = [];
for (let round = 1; round <= rounds; round += 1) {
  const token = await register(round);
  const roundReport = { round, firstPhase: [], secondPhase: [] };

  for (const source of sources) {
    const parsed = await request("/api/parse", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: source.url }),
    });
    const job = parsed.body?.job;
    const qualityLabels = (job?.videoFormats ?? [])
      .map((format) => format?.qualityLabel)
      .filter((value) => typeof value === "string");
    const displayVideoFormats = job?.videoFormats ?? [];
    const displayHeights = displayVideoFormats
      .map((format) => format?.height)
      .filter((value) => typeof value === "number");
    const allVideoFormatCount = Number(job?.metadata?.allVideoFormatCount ?? displayVideoFormats.length);
    if (parsed.response.status === 201 && job?.status === "succeeded" && new Set(displayHeights).size !== displayHeights.length) {
      throw new Error(`${source.name} returned duplicate displayed resolutions: ${JSON.stringify(displayHeights)}`);
    }
    if (parsed.response.status === 201 && job?.status === "succeeded" && allVideoFormatCount < displayVideoFormats.length) {
      throw new Error(`${source.name} format metadata is inconsistent: all=${allVideoFormatCount}, display=${displayVideoFormats.length}`);
    }
    if (parsed.response.status === 201 && job?.status === "succeeded" && job?.videoFormats?.length && !qualityLabels.some((value) => /\d+p/i.test(value))) {
      throw new Error(`${source.name} returned video formats without resolution labels: ${JSON.stringify(qualityLabels.slice(0, 5))}`);
    }
    roundReport.firstPhase.push({
      source: source.name,
      status: parsed.response.status,
      platform: job?.platform ?? null,
      jobStatus: job?.status ?? null,
      videoFormats: displayVideoFormats.length,
      allVideoFormats: allVideoFormatCount,
      audioFormats: job?.audioFormats?.length ?? 0,
      coverAvailable: Boolean(job?.thumbnailUrl),
      qualityLabels: qualityLabels.slice(0, 8),
      note: "metadata/formats only; no media body requested in phase one",
      error: parsed.body?.error?.message ?? null,
    });

    if (parsed.response.status !== 201 || !job || job.status !== "succeeded") continue;
    const selections = [
      ...(job.videoFormats?.[0] ? [{ kind: "video", id: job.videoFormats[0].id }] : []),
      ...(job.audioFormats?.[0] ? [{ kind: "audio", id: job.audioFormats[0].id }] : []),
      ...(job.thumbnailUrl ? [{ kind: "image", id: "thumbnail" }] : []),
    ];
    for (const selection of selections) {
      roundReport.secondPhase.push({
        source: source.name,
        kind: selection.kind,
        ...(await probeMedia(token, job, selection.kind, selection.id)),
      });
    }
  }
  report.push(roundReport);
}

console.log(JSON.stringify({ baseUrl, rounds, probeBytesLimit, report }, null, 2));
