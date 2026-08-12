import { randomBytes } from "node:crypto";
import { once } from "node:events";

process.env.NODE_ENV = "production";
process.env.PORT = process.env.PRODUCTION_SMOKE_PORT || "4015";
process.env.SERVE_CLIENT = "true";
process.env.DEV_VIP_ENABLED = "false";
process.env.JWT_SECRET = randomBytes(48).toString("base64url");

const [{ app }, { closeDatabase }, { config }] = await Promise.all([
  import("../dist/server/src/app.js"),
  import("../dist/server/src/db.js"),
  import("../dist/server/src/config.js"),
]);

const server = app.listen(config.port);

try {
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const [healthResponse, pageResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(`${baseUrl}/`),
  ]);
  const health = await healthResponse.json();
  const page = await pageResponse.text();
  const report = {
    healthOk: healthResponse.ok && health.ok === true,
    database: health.database?.status,
    parser: health.parser?.available,
    parserVersion: health.parser?.version,
    extractorCount: health.parser?.extractorCount,
    subtitles: health.features?.subtitles,
    devVip: health.features?.devVip,
    pageStatus: pageResponse.status,
    hasRoot: page.includes('<div id="root"></div>'),
    hasCsp: Boolean(pageResponse.headers.get("content-security-policy")),
  };

  if (
    !report.healthOk ||
    report.database !== "up" ||
    report.devVip !== false ||
    report.pageStatus !== 200 ||
    !report.hasRoot ||
    !report.hasCsp
  ) {
    throw new Error(`Production smoke failed: ${JSON.stringify(report)}`);
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeDatabase();
}
