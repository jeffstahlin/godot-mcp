import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The folder holding project.godot at or above `start`, or null. Claude Code
 * starts an MCP server in the session's working directory, so this is how a
 * server learns whether its session is a Godot one at all.
 */
export function findGodotProject(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "project.godot"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
