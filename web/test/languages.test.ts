import { test } from "node:test";
import assert from "node:assert/strict";

import { isDockerfile, languageFor } from "../src/lib/languages.ts";

test("languageFor: one row per extension, any case", () => {
  assert.deepEqual(languageFor("TS"), { shiki: "typescript", editor: "typescript", outline: { lang: "javascript", variant: "ts" } });
  assert.equal(languageFor("jsx")?.shiki, "javascript");
  assert.equal(languageFor("jsx")?.editor, "jsx");
  // outlined and editable, but no grammar in the Shiki bundle
  assert.equal(languageFor("scss")?.shiki, undefined);
  assert.equal(languageFor("scss")?.outline?.variant, "scss");
  assert.equal(languageFor("java")?.editor, "plain");
  assert.equal(languageFor("go")?.outline, undefined);
  for (const ext of ["", "docx", "constructor", "toString"]) assert.equal(languageFor(ext), undefined);
});

test("isDockerfile", () => {
  for (const n of ["Dockerfile", "dockerfile", "Dockerfile.dev", "app.dockerfile"]) assert.ok(isDockerfile(n), n);
  for (const n of ["Dockerfiles", "my-Dockerfile", "docker-compose.yml"]) assert.ok(!isDockerfile(n), n);
});
