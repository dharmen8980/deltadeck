// Which files can be edited, and with which CodeMirror language. Kept apart
// from the (lazily loaded) editor so the viewer bundle does not pull it in.

import type { FileKind, HiddenReason } from "@/lib/api";
import { EDIT_MAX_BYTES } from "@/lib/edit-api";
import { isDockerfile, languageFor, type EditorLang } from "@/lib/languages";

const EDITABLE_KINDS: FileKind[] = ["markdown", "mermaid", "code", "json", "csv", "text"];

/**
 * `maxBytes`: the server's limit (editMaxBytes(config)). Protected and ignore-list files are
 * read-only (the server refuses them); git-ignored files stay editable.
 */
export function isEditable(
  file: { kind: FileKind; size: number; hidden?: HiddenReason } | null | undefined,
  maxBytes = EDIT_MAX_BYTES,
): boolean {
  if (!file || file.hidden === "deny" || file.hidden === "ignore") return false;
  return EDITABLE_KINDS.includes(file.kind) && file.size <= maxBytes;
}

export type { EditorLang };

export function editorLangFor(name: string, ext: string, kind: string): EditorLang {
  if (kind === "markdown") return "markdown";
  if (kind === "json") return "json";
  // A known extension wins (Dockerfile.yml is yaml), as in the server's kind_of.
  const row = languageFor(ext);
  if (row) return row.editor;
  if (isDockerfile(name)) return "dockerfile";
  if (name.toLowerCase() === "makefile") return "shell";
  return "plain";
}
