// Regression tests for the two defects that used to force a Godot editor restart.
// Run against the BUILT bridge: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { GodotBridge } from "../build/godot-bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opened = (ws) => new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const closed = (ws) => new Promise((res) => ws.on("close", res));

// Ask the OS for a free ephemeral port rather than counting up from a fixed
// base: the real 6505 stays untouched, and a leaked listener from an earlier
// run cannot make a later run fail for a reason that has nothing to do with
// the behaviour under test.
async function takePort() {
  const probe = createServer();
  await new Promise((res) => probe.listen(0, "127.0.0.1", res));
  const { port } = probe.address();
  await new Promise((res) => probe.close(res));
  return port;
}

async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

/** A started bridge plus sockets, all torn down even when the test fails. */
async function harness(t) {
  const bridge = new GodotBridge(await takePort());
  const sockets = [];
  t.after(() => {
    for (const ws of sockets) ws.terminate();
    bridge.close();
  });
  bridge.start();
  return {
    bridge,
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
      sockets.push(ws);
      await opened(ws);
      return ws;
    },
  };
}

test("a second editor closing does not orphan the first, still-open editor", async (t) => {
  const { bridge, connect } = await harness(t);
  assert.ok(await waitFor(() => bridge.listening), "server should bind");

  // The real windowed editor the user has been working in all afternoon.
  const editor = await connect();
  assert.ok(await waitFor(() => bridge.clientCount === 1));
  assert.equal(bridge.connected, true);

  // A short-lived `godot --headless --editor` pass (e.g. a class-cache rebuild).
  const headless = await connect();
  assert.ok(await waitFor(() => bridge.clientCount === 2));

  // ...which finishes and exits.
  headless.close();
  await closed(headless);
  assert.ok(await waitFor(() => bridge.clientCount === 1));

  assert.equal(editor.readyState, WebSocket.OPEN, "the real editor is still connected");
  assert.equal(bridge.connected, true, "so the bridge must still consider itself connected");

  // And it must actually route to it, not just report a boolean.
  editor.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined) {
      editor.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { pong: true } }));
    }
  });
  assert.deepEqual(await bridge.call("ping_editor"), { pong: true });
});

test("an in-flight request survives an unrelated editor disconnecting", async (t) => {
  const { bridge, connect } = await harness(t);
  assert.ok(await waitFor(() => bridge.listening));

  const other = await connect();
  const editor = await connect();
  assert.ok(await waitFor(() => bridge.clientCount === 2));

  let seenId = null;
  editor.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined) seenId = msg.id;
  });

  const inflight = bridge.call("slow_command");
  assert.ok(await waitFor(() => seenId !== null), "request should reach the active editor");

  other.close();
  await closed(other);
  assert.ok(await waitFor(() => bridge.clientCount === 1), "server must reap the closed socket");

  // The old code rejected every pending request on ANY disconnect.
  editor.send(JSON.stringify({ jsonrpc: "2.0", id: seenId, result: { ok: 1 } }));
  assert.deepEqual(await inflight, { ok: 1 });
});

test("a second server process survives the port being taken", async (t) => {
  const port = await takePort();
  const holder = new GodotBridge(port);
  t.after(() => holder.close());
  holder.start();
  assert.ok(await waitFor(() => holder.listening), "first server should bind");

  // A second Claude Code session spawns its own server against the same port.
  const child = spawn(process.execPath, [join(HERE, "..", "fixtures", "second-server.mjs")], {
    env: { ...process.env, GODOT_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", () => {});

  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, "the losing server must not crash on EADDRINUSE");
  assert.match(stdout, /alive listening=false/);

  // It must also take the port over once the holder goes away.
  holder.close();
  const taker = new GodotBridge(port);
  t.after(() => taker.close());
  taker.start();
  assert.ok(await waitFor(() => taker.listening, 5000), "should bind after the holder exits");
});

test("a server that stayed off the port says why when a tool is called", async (t) => {
  const bridge = new GodotBridge(await takePort());
  t.after(() => bridge.close());
  bridge.stayIdle("C:/work/app is not inside a Godot project");

  await assert.rejects(bridge.call("ping_editor"), /not inside a Godot project/);
  assert.equal(bridge.listening, false);
});

test("a server that lost the port explains itself instead of blaming the editor", async (t) => {
  const port = await takePort();
  const holder = new GodotBridge(port);
  const loser = new GodotBridge(port);
  t.after(() => { loser.close(); holder.close(); });
  holder.start();
  assert.ok(await waitFor(() => holder.listening));

  loser.start();
  await sleep(300);
  assert.equal(loser.listening, false);

  await assert.rejects(loser.call("ping_editor"), /held by another process/);
});
