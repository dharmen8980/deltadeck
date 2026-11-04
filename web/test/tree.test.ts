import { test } from "node:test";
import assert from "node:assert/strict";

import type { FileEntry, TreeResponse } from "../src/lib/api.ts";
import { buildTree, findDir, ignoredPaths, withoutHidden } from "../src/lib/tree.ts";

const file = (path: string, ignored = false): FileEntry => ({
  path,
  name: path.split("/").pop()!,
  size: 1,
  mtime: 1,
  kind: "text",
  ext: "txt",
  ...(ignored ? { ignored } : {}),
});

const tree: TreeResponse = {
  files: [file("a.txt"), file("logs/x.log", true), file("logs/deep/y.log", true), file("src/z.txt"), file("src/out.tmp", true)],
  dirs: ["", "logs", "logs/deep", "src"],
  ignored_dirs: ["logs", "logs/deep"],
  version: 1,
};

test("buildTree marks git-ignored folders", () => {
  const root = buildTree(tree);
  assert.equal(findDir(root, "logs")?.ignored, true);
  assert.equal(findDir(root, "logs/deep")?.ignored, true);
  assert.equal(findDir(root, "src")?.ignored, undefined);
  assert.equal(findDir(root, "src")?.files.find((f) => f.name === "out.tmp")?.ignored, true);
});

test("ignoredPaths lists ignored files and folders", () => {
  assert.deepEqual([...ignoredPaths(tree)].sort(), ["logs", "logs/deep", "logs/deep/y.log", "logs/x.log", "src/out.tmp"]);
  assert.equal(ignoredPaths({ files: [file("a")], dirs: [""], version: 0 }).size, 0);
});

test("withoutHidden drops paths and everything below them", () => {
  assert.equal(withoutHidden(tree, new Set()), tree);
  const t = withoutHidden(tree, new Set(["logs", "a.txt"]));
  assert.deepEqual(t.files.map((f) => f.path), ["src/z.txt", "src/out.tmp"]);
  assert.deepEqual(t.dirs, ["", "src"]);
  assert.deepEqual(t.ignored_dirs, []);
});
