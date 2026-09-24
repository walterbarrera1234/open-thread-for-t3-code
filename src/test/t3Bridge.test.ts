import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  T3AppUnreachableError,
  isServerRunning,
  resolveBaseDir,
  resolveControlAddress,
  sendOpenWorkspace,
  sendOpenWorkspaceWhenReady,
} from "../t3Bridge";

function tempAddress(): string {
  const id = crypto.randomBytes(6).toString("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\t3code-test-${id}` : path.join(os.tmpdir(), `t3code-test-${id}.sock`);
}

type Reply = (request: Record<string, unknown>) => object | string;

const servers: net.Server[] = [];

function startFakeApp(address: string, reply: Reply): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const response = reply(JSON.parse(buffer.slice(0, newline)));
      socket.end(`${typeof response === "string" ? response : JSON.stringify(response)}\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(address, () => resolve(server)));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("resolveControlAddress", () => {
  it("matches the pipe name T3 Code uses on Windows", { skip: process.platform !== "win32" }, () => {
    // Verified against a running T3 Code 0.0.42 install.
    assert.equal(resolveControlAddress("C:\\Users\\ebarrera\\.t3"), "\\\\.\\pipe\\t3code-app-febe0e28e368882c3a0ed22d");
  });

  it("uses a per-user socket in the temp dir on macOS and Linux", { skip: process.platform === "win32" }, () => {
    const address = resolveControlAddress("/home/someone/.t3");
    const hash = crypto.createHash("sha256").update("/home/someone/.t3/userdata").digest("hex").slice(0, 24);
    assert.equal(address, path.join(os.tmpdir(), `t3code-${process.getuid!()}`, `${hash}.sock`));
  });
});

describe("resolveBaseDir", () => {
  const originalHome = process.env.T3CODE_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = originalHome;
  });

  it("defaults to ~/.t3", () => {
    delete process.env.T3CODE_HOME;
    assert.equal(resolveBaseDir(), path.join(os.homedir(), ".t3"));
  });

  it("honors T3CODE_HOME, with the setting taking precedence", () => {
    process.env.T3CODE_HOME = path.join(os.tmpdir(), "from-env");
    assert.equal(resolveBaseDir(), path.join(os.tmpdir(), "from-env"));
    assert.equal(resolveBaseDir("~/custom"), path.join(os.homedir(), "custom"));
  });
});

describe("sendOpenWorkspace", () => {
  it("sends an open-workspace request and returns the success response", async () => {
    const address = tempAddress();
    let received: Record<string, unknown> | undefined;
    await startFakeApp(address, (request) => {
      received = request;
      return { version: 1, requestId: request.requestId, ok: true, projectId: "p1", threadId: "t1" };
    });

    const response = await sendOpenWorkspace(address, "/work/repo");

    assert.deepEqual(response, { version: 1, requestId: received?.requestId, ok: true, projectId: "p1", threadId: "t1" });
    assert.equal(received?.version, 1);
    assert.equal(received?.type, "open-workspace");
    assert.equal(received?.workspaceRoot, "/work/repo");
    assert.equal(received?.platform, process.platform);
  });

  it("passes failure responses through", async () => {
    const address = tempAddress();
    await startFakeApp(address, (request) => ({
      version: 1,
      requestId: request.requestId,
      ok: false,
      code: "project-create-failed",
      message: "nope",
    }));

    const response = await sendOpenWorkspace(address, "/work/repo");

    assert.equal(response.ok, false);
    assert.equal(!response.ok && response.code, "project-create-failed");
  });

  it("rejects a response for a different request", async () => {
    const address = tempAddress();
    await startFakeApp(address, () => ({ version: 1, requestId: "someone-else", ok: true, projectId: "p", threadId: "t" }));

    await assert.rejects(sendOpenWorkspace(address, "/work/repo"), /did not match/);
  });

  it("rejects malformed responses", async () => {
    const address = tempAddress();
    await startFakeApp(address, () => "not json");

    await assert.rejects(sendOpenWorkspace(address, "/work/repo"), /invalid response/);
  });

  it("reports an unreachable app distinctly", async () => {
    await assert.rejects(sendOpenWorkspace(tempAddress(), "/work/repo"), T3AppUnreachableError);
  });
});

describe("sendOpenWorkspaceWhenReady", () => {
  it("retries until the app starts listening", async () => {
    const address = tempAddress();
    setTimeout(() => {
      void startFakeApp(address, (request) => ({ version: 1, requestId: request.requestId, ok: true, projectId: "p", threadId: "t" }));
    }, 800);

    const response = await sendOpenWorkspaceWhenReady(address, "/work/repo", 10_000);

    assert.equal(response.ok, true);
  });

  it("gives up after the timeout", async () => {
    await assert.rejects(sendOpenWorkspaceWhenReady(tempAddress(), "/work/repo", 600), T3AppUnreachableError);
  });
});

describe("isServerRunning", () => {
  function baseDirWithRuntime(contents: string | undefined): string {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-home-"));
    fs.mkdirSync(path.join(baseDir, "userdata"));
    if (contents !== undefined) fs.writeFileSync(path.join(baseDir, "userdata", "server-runtime.json"), contents);
    return baseDir;
  }

  it("is true when the recorded pid is alive", () => {
    assert.equal(isServerRunning(baseDirWithRuntime(JSON.stringify({ pid: process.pid }))), true);
  });

  it("is false when the recorded pid is gone", () => {
    assert.equal(isServerRunning(baseDirWithRuntime(JSON.stringify({ pid: 2 ** 22 + 12345 }))), false);
  });

  it("is false without a runtime file or with a bad one", () => {
    assert.equal(isServerRunning(baseDirWithRuntime(undefined)), false);
    assert.equal(isServerRunning(baseDirWithRuntime("{broken")), false);
  });
});
