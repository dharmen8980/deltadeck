import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineCSharp, tokenize } from "../src/lib/outline/csharp.ts";
import { find, fixture, rows } from "./outline-util.ts";

test("c#: file-scoped namespace, members of every kind, tricky strings", () => {
  const out = outlineCSharp(fixture("sample.cs"));
  assert.deepEqual(rows(out), [
    "namespace Acme.Core @4",
    "  class Repo @9",
    "    property Name @13",
    "    property Count @14",
    "    property this[] @15",
    "    constructor Repo @16",
    "    constructor Repo @17",
    "    constructor Repo @18", // static constructor
    "    method ~Repo @19",
    "    method GetAsync @21", // the line of the name, not of [HttpGet]; no statements inside
    "    method Tuple @34",
    "    method Map @35",
    "    method IDisposable.Dispose @36",
    "    method operator + @37",
    "    method implicit operator string @38",
    "    method ToString @39",
    "    method Raw @40",
    "    method Brace @43",
    "    enum State @44",
    "    record Point @45",
    "    record Pair @46",
    "      method Sum @46",
    "    interface IThing @47",
    "      method Do @47",
    "      property Prop @47",
    "    struct Inner @48",
    "      constructor Inner @48",
    "    method OnChanged @50", // between #region / #endregion
    "  class Repo @54", // the other half of the partial class
    "    method Extra @54",
  ]);
  assert.equal(find(out, "Acme.Core")?.endLine, 55);
  assert.equal(find(out, "GetAsync")?.endLine, 33);
});

test("c#: block namespaces, expression bodies, operators, interface members", () => {
  assert.deepEqual(rows(outlineCSharp(fixture("blocks.cs"))), [
    "namespace Shop.Api @1",
    "  interface IOrders @6",
    "    method FindAsync @8",
    "  class Extensions @12", // fields are not listed
    "    method Describe @15",
    "    method Pick @19",
    "  namespace Models @27",
    "    class Order @29",
    "      property Id @31",
    "      property Lines @32",
    "      property Total @33",
    "      method operator == @37",
    "      method operator != @38",
  ]);
});

test("c# tokenizer: strings, comments and directives leave no braces", () => {
  const src = [
    "#if DEBUG {",
    '/* { */ var a = "{"; var b = @"}"""; var c = $"{x} {{ }}"; var d = \'{\';',
    'var e = """',
    "  { raw }",
    '  """;',
    "// }",
    "}",
  ].join("\n");
  const braces = tokenize(src).filter((t) => t.t === "{" || t.t === "}");
  assert.deepEqual(braces.map((t) => [t.t, t.line]), [["}", 7]]);
});
