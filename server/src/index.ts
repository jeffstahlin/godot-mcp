#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GodotBridge } from "./godot-bridge.js";
import { findGodotProject } from "./godot-project.js";
import { registerTools } from "./tools.js";

const bridge = new GodotBridge();
// Claude Code starts one of these for every session that has godot-mcp
// registered (user scope means every session on the machine), in that
// session's working directory, and only one of them can own the editor's port.
// A session outside a Godot project will never use these tools, so it must not
// hold the port a Godot session is waiting for.
if (findGodotProject(process.cwd())) {
  bridge.start();
} else {
  bridge.stayIdle(
    `${process.cwd()} is not inside a Godot project (no project.godot at or above it), ` +
      `so this server never claims port ${bridge.port}`
  );
}

const server = new McpServer({
  name: "godot-mcp",
  version: "0.1.0",
});

registerTools(server, bridge);

function shutdown() {
  bridge.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The session going away closes stdin, and nothing else tells this process:
// the editor's socket and the listener keep the event loop alive, so without
// this a session that restarts leaves its server holding the port for good
// (2026-09-23: twelve hours, every later session's Godot tools dead behind it).
// 'end' alone is enough: a parent that dies without closing the pipe cleanly
// still reaches this process as end-of-file (a 'close' handler beside it was
// measured redundant).
process.stdin.on("end", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
