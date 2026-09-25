import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { after, before, describe, it } from "node:test";
import { startPanelProxy, type PanelProxy } from "../panelProxy";

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders };

/** Stands in for T3 Code: records what it receives and accepts WebSocket upgrades. */
function startFakeT3(): Promise<{ server: http.Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": "t3_session=from-t3; Path=/" }).end("hello from t3");
  });
  server.on("upgrade", (req, socket: net.Socket) => {
    seen.push({ method: "WS", url: req.url, headers: req.headers });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port, seen })),
  );
}

type Response = { status: number; body: string; setCookie: string[] };

function get(proxy: PanelProxy, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxy.port, path, headers: { host: `127.0.0.1:${proxy.port}`, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers["set-cookie"] ?? [] }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function upgrade(proxy: PanelProxy, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, "127.0.0.1", () => {
      const all = {
        host: `127.0.0.1:${proxy.port}`,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        ...headers,
      };
      socket.write(`GET /ws HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    });
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0]);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe("panel proxy", () => {
  let t3: Awaited<ReturnType<typeof startFakeT3>>;
  let proxy: PanelProxy;
  let key: string;
  let cookie: string;
  let self: string;

  before(async () => {
    t3 = await startFakeT3();
    proxy = await startPanelProxy({ target: () => ({ host: "127.0.0.1", port: t3.port }), token: () => "secret-token" });
    key = new URL(proxy.entryUrl).searchParams.get("t3panelKey")!;
    self = `http://127.0.0.1:${proxy.port}`;
    const entry = await get(proxy, `/?t3panelKey=${key}`, { "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" });
    cookie = entry.setCookie[0].split(";")[0];
  });

  after(async () => {
    await proxy.close();
    await new Promise((resolve) => t3.server.close(resolve));
  });

  it("listens on loopback with a random port and an unguessable key", () => {
    assert.match(proxy.entryUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?t3panelKey=[\w-]{40,}$/);
  });

  it("serves the entry page for the key and sets the key cookie instead of T3's", async () => {
    const entry = await get(proxy, `/?t3panelKey=${key}`);
    assert.equal(entry.status, 200);
    assert.equal(entry.body, "hello from t3");
    assert.equal(entry.setCookie.length, 1);
    assert.match(entry.setCookie[0], /^t3panel=[\w-]+; Path=\/; HttpOnly; SameSite=None; Secure; Partitioned$/);
  });

  it("forwards with the bearer token, T3's host and origin, and without the key or cookies", async () => {
    t3.seen.length = 0;
    await get(proxy, `/api/thing?x=1&t3panelKey=${key}`, { origin: self, cookie: `${cookie}; other=1` });
    const [seen] = t3.seen;
    assert.equal(seen.url, "/api/thing?x=1");
    assert.equal(seen.headers.authorization, "Bearer secret-token");
    assert.equal(seen.headers.host, `127.0.0.1:${t3.port}`);
    assert.equal(seen.headers.origin, `http://127.0.0.1:${t3.port}`);
    assert.equal(seen.headers.cookie, undefined);
  });

  it("accepts the panel's own requests and WebSocket via the key cookie", async () => {
    assert.equal((await get(proxy, "/assets/app.js", { cookie })).status, 200);
    assert.equal(await upgrade(proxy, { origin: self, cookie }), "HTTP/1.1 101 Switching Protocols");
  });

  it("rejects requests without the key", async () => {
    assert.equal((await get(proxy, "/")).status, 403);
    assert.equal((await get(proxy, "/", { "sec-fetch-site": "same-origin" })).status, 403);
    assert.equal((await get(proxy, "/?t3panelKey=wrong")).status, 403);
    assert.equal((await get(proxy, "/", { cookie: "t3panel=wrong" })).status, 403);
    assert.equal(await upgrade(proxy, { origin: self }), "HTTP/1.1 403 Forbidden");
  });

  it("rejects other websites even with the key cookie", async () => {
    assert.equal((await get(proxy, "/api/thing", { cookie, origin: "https://evil.example" })).status, 403);
    assert.equal(await upgrade(proxy, { cookie, origin: "https://evil.example" }), "HTTP/1.1 403 Forbidden");
  });

  it("rejects DNS-rebinding requests addressed to another host", async () => {
    assert.equal((await get(proxy, `/?t3panelKey=${key}`, { host: `evil.example:${proxy.port}` })).status, 403);
  });

  it("reports T3 Code being down instead of hanging", async () => {
    const down = await startPanelProxy({ target: () => undefined, token: () => "t" });
    const downKey = new URL(down.entryUrl).searchParams.get("t3panelKey")!;
    assert.equal((await get(down, `/?t3panelKey=${downKey}`)).status, 502);
    await down.close();
  });
});
