import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineJava } from "../src/lib/outline/java.ts";
import { find, fixture, rows } from "./outline-util.ts";

test("java: package, types, constructors, methods, fields, nested types", () => {
  const out = outlineJava(fixture("Sample.java"));
  assert.deepEqual(rows(out), [
    "package org.acme.orders @4",
    "class Order @13", // the line of the name, not of the annotations
    "  field MAX @14",
    "  field MIN @14",
    "  field text @15", // the text block's contents are not code
    "  constructor Order @19",
    "  constructor Order @23", // its lambda and local class are not listed
    "  method compareTo @29",
    "  method sorted @33",
    "  class Builder @37",
    "    field id @38",
    "    method id @39",
    "    method build @40",
    "  enum Status @43", // constants (and their bodies) are not listed
    "    method open @46",
    "  interface Shape @49",
    "    method area @50",
    "    method perimeter @51",
    "  record Circle @54",
    "    constructor Circle @55", // compact constructor
    "    method perimeter @58",
  ]);
  assert.equal(find(out, "Builder")?.endLine, 41);
});

test("java: annotation types and a file without a package", () => {
  const src = ["@interface Ann {", '  String value() default "";', "  int[] ids();", "}", ""].join("\n");
  assert.deepEqual(rows(outlineJava(src)), ["annotation Ann @1", "  method value @2", "  method ids @3"]);
});
