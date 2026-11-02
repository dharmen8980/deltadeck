import { test } from "node:test";
import assert from "node:assert/strict";

import type { FileEntry, TreeResponse } from "../src/lib/api.ts";
import { buildTree, filterFiles, findDir, hiddenLabel, hiddenNodesFromList } from "../src/lib/tree.ts";

const file = (path: string, mtime: number): FileEntry => ({
  path,
  name: path.split("/").pop() ?? path,
  size: 1,
  mtime,
  kind: "code",
  ext: "ts",
});

const TREE: TreeResponse = {
  version: 1,
  dirs: ["", "web", "server"],
  files: [file("web/a.ts", 10), file("server/b.ts", 20)],
  hidden: [
    { path: ".env", name: ".env", dir: false, reason: "deny", kind: "text", ext: "env" },
    { path: "node_modules", name: "node_modules", dir: true, reason: "ignore" },
    { path: "server/app.log", name: "app.log", dir: false, reason: "git", kind: "text", ext: "log", mtime: 99 },
    { path: "web/out", name: "out", dir: true, reason: "git" },
  ],
};

test("buildTree: hidden items only when asked", () => {
  const root = buildTree(TREE);
  assert.deepEqual(root.dirs.map((d) => d.name).sort(), ["server", "web"]);
  assert.equal(root.files.length, 0);
  assert.equal(root.fileCount, 2);
});

test("buildTree: hidden folders are empty and flagged, hidden files flagged in their folder", () => {
  const root = buildTree(TREE, { hidden: true });
  const nm = findDir(root, "node_modules");
  assert.ok(nm);
  assert.equal(nm.hidden, "ignore");
  assert.deepEqual([nm.dirs.length, nm.files.length, nm.fileCount], [0, 0, 0]);
  assert.equal(findDir(root, "web/out")?.hidden, "git");
  const env = root.files.find((f) => f.path === ".env");
  assert.equal(env?.hidden, "deny");
  assert.equal(env?.kind, "text");
  const log = findDir(root, "server")?.files.find((f) => f.name === "app.log");
  assert.equal(log?.hidden, "git");
});

test("buildTree: hidden items do not count in folder counts or times", () => {
  const root = buildTree(TREE, { hidden: true });
  assert.equal(root.fileCount, 2);
  assert.equal(root.mtime, 20);
  const server = findDir(root, "server");
  assert.equal(server?.fileCount, 1);
  assert.equal(server?.mtime, 20);
  assert.equal(findDir(root, "web")?.fileCount, 1);
});

test("filterFiles: drops hidden items", () => {
  const root = filterFiles(buildTree(TREE, { hidden: true }), () => true);
  assert.equal(findDir(root, "node_modules"), null);
  assert.equal(findDir(root, "web/out"), null);
  assert.equal(root.files.length, 0);
  assert.deepEqual(findDir(root, "server")?.files.map((f) => f.name), ["b.ts"]);
});

test("hiddenNodesFromList: folders and files of an opened hidden folder", () => {
  const { dirs, files } = hiddenNodesFromList({
    path: "node_modules",
    reason: "ignore",
    truncated: false,
    entries: [
      { path: "node_modules/react", name: "react", dir: true, reason: "ignore" },
      { path: "node_modules/.env", name: ".env", dir: false, reason: "deny", kind: "text", ext: "env", size: 12, mtime: 5 },
    ],
  });
  assert.deepEqual(dirs.map((d) => [d.path, d.hidden, d.dirs.length]), [["node_modules/react", "ignore", 0]]);
  assert.deepEqual(files.map((f) => [f.path, f.hidden, f.size, f.mtime]), [["node_modules/.env", "deny", 12, 5]]);
});

test("hiddenLabel", () => {
  assert.equal(hiddenLabel("git"), "Ignored by git");
  assert.equal(hiddenLabel("ignore"), "On the viewer's ignore list");
  assert.equal(hiddenLabel("deny"), "Protected: may contain secrets");
});
