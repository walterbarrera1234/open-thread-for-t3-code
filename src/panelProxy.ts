/**
 * Loopback relay that lets a VS Code webview show T3 Code's own web UI.
 *
 * T3 Code authenticates browsers with a `SameSite=Lax` session cookie, which a
 * webview iframe (a cross-site context) never sends. The relay instead injects
 * a bearer token into every request it forwards, so the page never holds a
 * credential. Because an authenticated relay could be abused by other pages or
 * processes, every request must pass these checks:
 *
 * 1. Bound to 127.0.0.1 on a random port.
 * 2. `Host` must be exactly our address, which defeats DNS rebinding.
 * 3. A browser-supplied `Origin`, if present, must be ours; cross-site
 *    WebSocket and POST attempts from websites carry a foreign one.
 * 4. Every request must carry the per-launch key: the entry URL has it as a
 *    query parameter, and the response sets it as a cookie that the page's
 *    later requests (including the WebSocket) send back.
 */
import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";

export interface PanelTarget {
  host: string;
  port: number;
}

export interface PanelProxyOptions {
  /** Resolved per connection, so the relay follows T3 Code across restarts. */
  target: () => PanelTarget | undefined;
  token: () => string;
  log?: (message: string) => void;
}

export interface PanelProxy {
  port: number;
  /** URL the webview iframe should load. */
  entryUrl: string;
  close(): Promise<void>;
}

const KEY_PARAM = "t3panelKey";
const COOKIE_NAME = "t3panel";

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

type Verdict = { ok: true; setCookie: boolean; stripKey: boolean } | { ok: false; reason: string };

export async function startPanelProxy(options: PanelProxyOptions): Promise<PanelProxy> {
  const key = crypto.randomBytes(32).toString("base64url");
  const log = options.log ?? (() => {});
  let selfHost = "";
  let selfOrigin = "";

  function check(req: http.IncomingMessage): Verdict {
    if (req.headers.host !== selfHost) return { ok: false, reason: `host ${req.headers.host}` };
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== selfOrigin) return { ok: false, reason: `origin ${origin}` };

    const url = new URL(req.url ?? "/", selfOrigin);
    const hasKeyParam = safeEqual(url.searchParams.get(KEY_PARAM) ?? undefined, key);
    const hasCookie = safeEqual(cookieValue(req.headers.cookie, COOKIE_NAME), key);
    if (hasKeyParam) return { ok: true, setCookie: true, stripKey: true };
    if (hasCookie) return { ok: true, setCookie: false, stripKey: false };
    return { ok: false, reason: "missing key" };
  }

  function forwardHeaders(req: http.IncomingMessage, path: string, target: PanelTarget): http.OutgoingHttpHeaders {
    const targetOrigin = `http://${target.host}:${target.port}`;
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = `${target.host}:${target.port}`;
    if (headers.origin) headers.origin = targetOrigin;
    if (headers.referer) headers.referer = targetOrigin + path;
    delete headers.cookie;
    headers.authorization = `Bearer ${options.token()}`;
    return headers;
  }

  function targetPath(req: http.IncomingMessage, stripKey: boolean): string {
    const url = new URL(req.url ?? "/", selfOrigin);
    if (stripKey) url.searchParams.delete(KEY_PARAM);
    return url.pathname + url.search;
  }

  const server = http.createServer((req, res) => {
    const verdict = check(req);
    if (!verdict.ok) {
      log(`Denied ${req.method} ${new URL(req.url ?? "/", selfOrigin).pathname} (${verdict.reason})`);
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    const target = options.target();
    if (!target) {
      res.writeHead(502, { "content-type": "text/plain" }).end("T3 Code isn't running.");
      return;
    }
    const path = targetPath(req, verdict.stripKey);
    const upstream = http.request(
      { host: target.host, port: target.port, method: req.method, path, headers: forwardHeaders(req, path, target) },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        delete headers["set-cookie"];
        if (verdict.setCookie) {
          headers["set-cookie"] = [`${COOKIE_NAME}=${key}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`];
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`T3 Code isn't reachable: ${error.message}`);
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
    const verdict = check(req);
    if (!verdict.ok) {
      log(`Denied WebSocket ${new URL(req.url ?? "/", selfOrigin).pathname} (${verdict.reason})`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = options.target();
    if (!target) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const path = targetPath(req, verdict.stripKey);
    const upstream = net.connect(target.port, target.host, () => {
      const headers = forwardHeaders(req, path, target);
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) lines.push(`${name}: ${v}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  selfHost = `127.0.0.1:${port}`;
  selfOrigin = `http://${selfHost}`;

  return {
    port,
    entryUrl: `${selfOrigin}/?${KEY_PARAM}=${key}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
