// The server as Claude Code runs it: a child process on stdio, started in the
// session's working directory. godot-mcp is registered at user scope, so every
// session on the machine starts one, and only one can own the editor's port.
// Run against the BUILT server: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sleep, takePort, portTaken, waitForAsync } from "./helpers.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");

/**
 * Starts the built server in a throwaway working directory, with or without a
 * project.godot in it. ONE cleanup hook kills the server, waits for it to exit
 * and only then removes the folder: Windows refuses to delete a directory that
 * a live process has as its working directory, and a removal that ran first
 * threw, skipped the kill, and hung the whole run on the orphaned server.
 */
function startServer(t, { isGodotProject, port }) {
  const cwd = mkdtempSync(join(tmpdir(), "gmcp-session-"));
  if (isGodotProject) writeFileSync(join(cwd, "project.godot"), "config_version=5\n");
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: { ...process.env, GODOT_MCP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { child, exited };
}

/** Resolves once the server answers an MCP initialize: its startup has run. */
function initialized(child) {
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes('"id":1')) resolve();
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }) + "\n"
    );
  });
}

test("a server whose session goes away exits and gives the port back", { timeout: 20_000 }, async (t) => {
  const port = await takePort();
  const { child, exited } = startServer(t, { isGodotProject: true, port });
  assert.ok(await waitForAsync(() => portTaken(port)), "premise: inside a Godot project the server claims the port");

  // Claude Code going away closes the server's stdin, and nothing else tells
  // it. On 2026-09-23 a restarted session left its server holding the port for
  // twelve hours, and every later session's Godot tools were dead behind it.
  child.stdin.end();

  const outcome = await Promise.race([exited, sleep(5000).then(() => "still running after 5 s")]);
  assert.equal(outcome, 0, "the server must exit when its session's stdin closes");
  assert.equal(await portTaken(port), false, "and the port must be free for the next session");
});

test("a server whose session is killed outright exits too", { timeout: 20_000 }, async (t) => {
  // The real orphan outlived its session's process. A stand-in session spawns
  // the server holding its stdin, reports its pid, and is then terminated the
  // hard way. `detached` matters: without it Node on Windows puts the server in
  // a job object the OS kills along with the stand-in, and this test passed
  // with no stdin handling at all (measured), proving nothing about the server.
  const port = await takePort();
  const cwd = mkdtempSync(join(tmpdir(), "gmcp-session-"));
  writeFileSync(join(cwd, "project.godot"), "config_version=5\n");
  const standIn = spawn(
    process.execPath,
    [
      "-e",
      `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(SERVER)}], ` +
        `{ cwd: ${JSON.stringify(cwd)}, env: { ...process.env, GODOT_MCP_PORT: "${port}" }, ` +
        `stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true }); ` +
        `process.stdout.write(c.pid + "\\n"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  const serverPid = await new Promise((resolve) => standIn.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(async () => {
    if (alive(serverPid)) process.kill(serverPid);
    if (standIn.exitCode === null && standIn.signalCode === null) standIn.kill();
    await waitForAsync(async () => !alive(serverPid), 3000);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.ok(await waitForAsync(() => portTaken(port)), "premise: the server claimed the port");

  standIn.kill("SIGKILL");

  assert.ok(await waitForAsync(async () => !alive(serverPid), 5000), "the server must exit once its session is gone");
  assert.equal(await portTaken(port), false, "and the port must be free for the next session");
});

test("a server started outside a Godot project never claims the port", { timeout: 20_000 }, async (t) => {
  const port = await takePort();
  const { child } = startServer(t, { isGodotProject: false, port });
  await initialized(child);
  // The server above binds within milliseconds of starting, so a server that
  // meant to bind would have done so inside this window.
  assert.equal(
    await waitForAsync(() => portTaken(port), 1500),
    false,
    "a session outside Godot must leave the port to one inside"
  );
});
