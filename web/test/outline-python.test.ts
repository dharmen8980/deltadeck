import { test } from "node:test";
import assert from "node:assert/strict";
import { outlinePython } from "../src/lib/outline/python.ts";
import { find, fixture, rows } from "./outline-util.ts";

test("python: classes, methods, nested and decorated functions", () => {
  const out = outlinePython(fixture("sample.py"));
  assert.deepEqual(rows(out), [
    "function cached @11", // decorated over several lines: the line of the def
    "class Service @15",
    "  method __init__ @20",
    "  method name @24",
    "  method name @28",
    "  method fetch @31",
    "    function retry @32",
    "      function backoff @33",
    "  class Config @37",
    "    method validate @40",
    "function outer @43",
    "  class Local @44",
    "    method m @45",
    "function fast @50", // inside try / except
    "function fast @52",
    "function main @55", // inside if __name__ == "__main__"
  ]);
  assert.equal(find(out, "Service")?.endLine, 40);
  assert.equal(find(out, "outer")?.endLine, 46);
});

test("python: strings, comments and lambdas are not symbols", () => {
  const src = ['s = "def fake(): pass"', "# class Commented:", "f = lambda x: x", "def real(): pass", ""].join("\n");
  assert.deepEqual(rows(outlinePython(src)), ["function real @4"]);
});

test("python: empty and broken input", () => {
  assert.deepEqual(outlinePython(""), []);
  assert.deepEqual(rows(outlinePython("def ok():\n    pass\ndef broken(:\n")), ["function ok @1", "function broken @3"]);
});

test("python: definitions inside match / case", () => {
  const src = [
    "match cmd:",
    '    case "a":',
    "        def in_match():",
    "            pass",
    "    case _:",
    "        class Fallback:",
    "            def run(self): ...",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlinePython(src)), ["function in_match @3", "class Fallback @6", "  method run @7"]);
});
