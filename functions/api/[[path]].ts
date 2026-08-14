type PagesFunctionContext = {
  request: Request;
  env: {
    API_ORIGIN?: string;
  };
};

const HOP_BY_HOP_REQUEST_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const HOP_BY_HOP_RESPONSE_HEADERS = [
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function json(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function buildUpstreamUrl(request: Request, apiOrigin: string): URL {
  const origin = new URL(apiOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("API_ORIGIN must use http or https.");
  }

  const incoming = new URL(request.url);
  const basePath = origin.pathname.replace(/\/+$/u, "");
  origin.pathname = `${basePath}${incoming.pathname}` || "/";
  origin.search = incoming.search;
  return origin;
}

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  const apiOrigin = String(context.env.API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
  if (!apiOrigin) {
    return json({ error: "Pages API proxy is not configured." }, 503);
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = buildUpstreamUrl(context.request, apiOrigin);
  } catch {
    return json({ error: "Pages API proxy has an invalid API_ORIGIN." }, 500);
  }

  const headers = new Headers(context.request.headers);
  for (const name of HOP_BY_HOP_REQUEST_HEADERS) headers.delete(name);
  headers.set("x-forwarded-host", new URL(context.request.url).host);
  headers.set("x-forwarded-proto", "https");

  const method = context.request.method.toUpperCase();
  const upstreamRequest = new Request(upstreamUrl, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });

  try {
    const upstreamResponse = await fetch(upstreamRequest);
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const name of HOP_BY_HOP_RESPONSE_HEADERS) responseHeaders.delete(name);
    responseHeaders.set("Cache-Control", "no-store");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch {
    return json({ error: "Domestic JunVideo API is unreachable." }, 502);
  }
}
