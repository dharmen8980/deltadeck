// Pure (no DOM, no React, no "@/" value imports): unit tested with node --test.
import type { FileEntry, HiddenEntry, HiddenListResponse, HiddenReason, TreeResponse } from "@/lib/api";
import { basename, dirname } from "./paths.ts";

export interface DirNode {
  path: string;
  name: string;
  dirs: DirNode[];
  files: FileEntry[];
  /** Max mtime of all descendants (0 if empty). */
  mtime: number;
  fileCount: number;
  /** a hidden folder: its children are not in the tree, they are listed when it is opened */
  hidden?: HiddenReason;
}

export type SortMode = "name" | "mtime";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const hiddenDir = (e: HiddenEntry): DirNode => ({
  path: e.path,
  name: e.name,
  dirs: [],
  files: [],
  mtime: 0,
  fileCount: 0,
  hidden: e.reason,
});

const hiddenFile = (e: HiddenEntry): FileEntry => ({
  path: e.path,
  name: e.name,
  size: e.size ?? 0,
  mtime: e.mtime ?? 0,
  kind: e.kind ?? "binary",
  ext: e.ext ?? "",
  hidden: e.reason,
});

/** `hidden`: add the tree's hidden items (dimmed rows); they do not count in folder counts or times. */
export function buildTree(tree: TreeResponse, opts?: { hidden?: boolean }): DirNode {
  const root: DirNode = { path: "", name: "", dirs: [], files: [], mtime: 0, fileCount: 0 };
  const byPath = new Map<string, DirNode>([["", root]]);
  const ensure = (path: string): DirNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const parent = ensure(dirname(path));
    const node: DirNode = { path, name: basename(path), dirs: [], files: [], mtime: 0, fileCount: 0 };
    parent.dirs.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const d of tree.dirs) if (d) ensure(d);
  for (const f of tree.files) ensure(dirname(f.path)).files.push(f);
  if (opts?.hidden && tree.hidden) {
    for (const e of tree.hidden) {
      const parent = ensure(dirname(e.path));
      if (e.dir) parent.dirs.push(hiddenDir(e));
      else parent.files.push(hiddenFile(e));
    }
  }
  const finish = (n: DirNode) => {
    let m = 0;
    let c = 0;
    for (const f of n.files) {
      if (f.hidden) continue;
      m = Math.max(m, f.mtime);
      c++;
    }
    for (const d of n.dirs) {
      finish(d);
      m = Math.max(m, d.mtime);
      c += d.fileCount;
    }
    n.mtime = m;
    n.fileCount = c;
  };
  finish(root);
  return root;
}

export function sortDirs(dirs: DirNode[], mode: SortMode): DirNode[] {
  return [...dirs].sort((a, b) =>
    mode === "mtime" ? b.mtime - a.mtime || collator.compare(a.name, b.name) : collator.compare(a.name, b.name),
  );
}

export function sortFiles(files: FileEntry[], mode: SortMode): FileEntry[] {
  return [...files].sort((a, b) =>
    mode === "mtime" ? b.mtime - a.mtime || collator.compare(a.name, b.name) : collator.compare(a.name, b.name),
  );
}

export function findDir(root: DirNode, path: string): DirNode | null {
  if (!path) return root;
  let node: DirNode | undefined = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length && node; i++) {
    const p = parts.slice(0, i + 1).join("/");
    node = node.dirs.find((d) => d.path === p);
  }
  return node ?? null;
}

/** The tree with only the files `keep` accepts; folders left without files are dropped, and hidden items too. */
export function filterFiles(root: DirNode, keep: (f: FileEntry) => boolean): DirNode {
  const walk = (n: DirNode): DirNode | null => {
    if (n.hidden) return null;
    const files = n.files.filter((f) => !f.hidden && keep(f));
    const dirs = n.dirs.map(walk).filter((d): d is DirNode => d !== null);
    if (n.path && !files.length && !dirs.length) return null;
    let mtime = 0;
    let fileCount = files.length;
    for (const f of files) mtime = Math.max(mtime, f.mtime);
    for (const d of dirs) {
      mtime = Math.max(mtime, d.mtime);
      fileCount += d.fileCount;
    }
    return { ...n, files, dirs, mtime, fileCount };
  };
  return walk(root) ?? root;
}


/** The children of an opened hidden folder (/api/hidden) as tree rows. */
export function hiddenNodesFromList(res: HiddenListResponse): { dirs: DirNode[]; files: FileEntry[] } {
  const dirs: DirNode[] = [];
  const files: FileEntry[] = [];
  for (const e of res.entries) {
    if (e.dir) dirs.push(hiddenDir(e));
    else files.push(hiddenFile(e));
  }
  return { dirs, files };
}

export function hiddenLabel(reason: HiddenReason): string {
  if (reason === "git") return "Ignored by git";
  if (reason === "ignore") return "On the viewer's ignore list";
  return "Protected: may contain secrets";
}
