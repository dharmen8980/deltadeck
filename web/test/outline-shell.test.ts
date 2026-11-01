import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineShell } from "../src/lib/outline/shell.ts";
import { fixture, rows } from "./outline-util.ts";

test("shell: function syntaxes under section headers; heredocs and strings skipped", () => {
  assert.deepEqual(rows(outlineShell(fixture("sample.sh"))), [
    "function helper @4",
    "section Setup @6", // # ---- Setup ----
    "  function setup @7", // function name {
    "  function with_parens @15", // function name() {
    "section Build steps @21", // ### Build steps
    "  function build_all @22", // name () on its own line
    "section Deploy @30", // a banner between two rule lines: the line of the text
    "  function deploy::prod @32",
    "  function after @35", // after `<<<`, which starts no heredoc
  ]);
});

test("zsh: banner sections, quoted heredocs, arithmetic shifts", () => {
  assert.deepEqual(rows(outlineShell(fixture("sample.zsh"))), [
    "section Prompt @3",
    "  function prompt_setup @5",
    "  function _complete_git @11", // `# == Completion ==` (two-char rule) is not a header
    "  function cleanup @25", // after $(( 1 << 2 )) and a <<'PY' heredoc with a def inside
    "  function inner @26", // nested functions are listed flat
  ]);
});

test("shell: comments and the shebang are not headers", () => {
  const src = ["#!/bin/sh", "# just a comment", "#", "x() { :; }", ""].join("\n");
  assert.deepEqual(rows(outlineShell(src)), ["function x @4"]);
});
