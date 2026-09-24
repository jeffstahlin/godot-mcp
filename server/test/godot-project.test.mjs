// Which working directories count as "inside a Godot project".
// Run against the BUILT module: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findGodotProject } from "../build/godot-project.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "gmcp-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("finds the project from its own folder and from a folder below it", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "project.godot"), "config_version=5\n");
  const nested = join(root, "src", "ui");
  mkdirSync(nested, { recursive: true });

  assert.equal(findGodotProject(root), resolve(root));
  // A session started in a subfolder of the game is still a game session.
  assert.equal(findGodotProject(nested), resolve(root));
});

test("answers null where no project.godot sits at or above the folder", (t) => {
  assert.equal(findGodotProject(tempDir(t)), null);
});
