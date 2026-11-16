// @ts-nocheck
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "::1", "metadata.google.internal"]);

export function attachIptvRelay(middlewares) {
  middlewares.use(async (req, res, next) => {
    const raw = req.url || "";
    const path = raw.split("?")[0];
    if (path !== "/api/relay") {
      next();
      return;
    }
    try {
      const host = header(req, "x-forwarded-host") || header(req, "host") || "127.0.0.1:8080";
      const proto = header(req, "x-forwarded-proto") || "http";
      const headers = new Headers();
      copy(headers, "range", header(req, "range"));
      copy(headers, "accept", header(req, "accept"));
      copy(headers, "user-agent", header(req, "user-agent"));
      copy(headers, "origin", header(req, "origin"));
      const request = new Request(`${proto}://${host}${raw}`, { method: req.method || "GET", headers });
      const response = await relayRequest(request);
      await pipeToNode(res, response);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("relay failed");
      }
    }
  });
}

export async function relayRequest(request) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,HEAD,OPTIONS",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method", { status: 405 });
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).hostname !== url.hostname) return new Response("origin", { status: 403 });
    } catch {
      return new Response("origin", { status: 403 });
    }
  }
  const target = url.searchParams.get("url");
  if (!target) return new Response("missing", { status: 400 });
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("bad", { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return new Response("blocked", { status: 400 });
  if (isBlockedHost(parsed.hostname)) return new Response("blocked", { status: 400 });
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const ua = request.headers.get("user-agent");
  if (ua) headers.set("user-agent", ua);
  headers.set("accept", request.headers.get("accept") || "*/*");
  const upstream = await fetch(parsed, { method: request.method, headers, redirect: "follow" });
  const type = upstream.headers.get("content-type") || "";
  const playlist = /\.m3u8?(\?|$)/i.test(parsed.pathname) || /mpegurl|vnd\.apple/i.test(type);
  if (playlist && request.method !== "HEAD") {
    const text = await upstream.text();
    const relayBase = `${url.origin}${url.pathname}?url=`;
    const body = rewritePlaylist(text, upstream.url || parsed.toString(), relayBase);
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }
  const out = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set("cache-control", "no-store");
  out.set("access-control-allow-origin", "*");
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}

function rewritePlaylist(text, base, relayBase) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${relayBase}${encodeURIComponent(absolute(uri, base))}"`);
      }
      return `${relayBase}${encodeURIComponent(absolute(trimmed, base))}`;
    })
    .join("\n");
}

function absolute(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function header(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value ? String(value) : "";
}

function copy(headers, name, value) {
  if (value) headers.set(name, value);
}

async function pipeToNode(nodeRes, response) {
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === "transfer-encoding" || key === "content-encoding") return;
    nodeRes.setHeader(key, value);
  });
  if (!response.body) {
    nodeRes.end();
    return;
  }
  const { Readable } = await import("node:stream");
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body);
    stream.on("error", reject);
    nodeRes.on("error", reject);
    nodeRes.on("finish", resolve);
    stream.pipe(nodeRes);
  });
}
