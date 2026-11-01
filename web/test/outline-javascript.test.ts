import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineJavaScript } from "../src/lib/outline/javascript.ts";
import { find, fixture, rows } from "./outline-util.ts";

test("typescript: declarations, class members, overloads, tests", () => {
  const out = outlineJavaScript(fixture("sample.ts"), "ts");
  assert.deepEqual(rows(out), [
    "interface Props @6",
    "type Handler @11",
    "enum Mode @13",
    "namespace Util.Inner @18",
    "  function helper @19",
    "class Store @22",
    "  method onEvent @25", // arrow-function property
    "  constructor constructor @26",
    "  getter size @29",
    "  setter size @32",
    "  method add @33", // three overloads, one entry at the first
    "    function inner @36",
    "  method [Symbol.asyncIterator] @38",
    "  method create @39",
    "  method flush @42",
    "function format @45", // overloads again
    "  function local @48",
    "function debounce @52",
    "function legacy @53",
    "function Button @54", // memo(function ...)
    "variable api @55",
    "  method get @56",
    "  method post @57",
    "function main @61",
    "suite Store @63",
    "  test adds items @65",
    "  suite with %i @66",
    "    test skipped @67",
    "  test template name @69",
  ]);
  // the folded overloads end where the implementation ends
  assert.equal(find(out, "add")?.endLine, 37);
  assert.equal(find(out, "Store")?.endLine, 43);
});

test("jsx: default arrow, class fields, wrapped components", () => {
  assert.deepEqual(rows(outlineJavaScript(fixture("sample.jsx"), "jsx")), [
    "function default @3",
    "class Legacy @5",
    "  method handleClick @7",
    "  method render @10",
    "function Card @15",
    "function helper @17", // module.exports.helper = function ...
  ]);
});

test("javascript: comments, strings and plain calls are not symbols", () => {
  const src = [
    "// function a() {}",
    "/* class B {} */",
    'const s = "function c() {}";',
    "foo(function () {});",
    "items.forEach((x) => x);",
    "export default class {}",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(src, "js")), ["class default @6"]);
});

test("javascript: calls on objects named like test functions are not tests", () => {
  const src = [
    'const context = canvas.getContext("2d");',
    'context.fillText("Hello", 0, 0);',
    "module.exports = async function (context, req) {",
    '  context.log("JavaScript HTTP trigger function processed a request.");',
    '  context.done("x", () => {});',
    "};",
    'test.step("not a declaration", () => {});',
    'suite.addTest("x");',
    'it.should("x", () => {});',
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(src, "js")), ["function module.exports @3"]);
});

test("typescript: playwright-style tests, hooks and table tests", () => {
  const src = [
    'import { test, expect } from "@playwright/test";', // 1
    'test.describe("pw suite", () => {',
    '  test.describe.configure({ mode: "serial" });',
    "  test.beforeEach(async ({ page }) => {",
    "    function setup() {}", // 5: a declaration inside a hook is still listed
    "  });",
    "  test.afterAll(async () => {});",
    '  test("loads", async ({ page }) => {',
    '    await test.step("click", async () => {});',
    "  });", // 10
    '  test.describe.serial("ordered", () => {',
    '    test.only("first", () => {});',
    "  });",
    '  test.skip(browserName === "webkit", "not on webkit");',
    '  test.fixme("broken", () => {});', // 15
    "});",
    'context("mocha context", () => {',
    '  it.each([1, 2])("array %i", (n) => {});',
    "  it.each`",
    "    a | b", // 20
    '  `("table $a", ({ a }) => {});',
    '  test.concurrent.each([[1]])("conc %i", async () => {});',
    "});",
    "describe(Store, () => {",
    '  it.todo("later");', // 25
    "});",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(src, "ts")), [
    "suite pw suite @2",
    "  function setup @5",
    "  test loads @8",
    "  suite ordered @11",
    "    test first @12",
    "  test broken @15",
    "suite mocha context @17",
    "  test array %i @18",
    "  test table $a @19",
    "  test conc %i @22",
    "suite Store @24",
    "  test later @25",
  ]);
});

test("tsx: wrapped components with type arguments", () => {
  const src = [
    "export const Input = forwardRef<HTMLInputElement, Props>(function Input(props, ref) {",
    "  return <input ref={ref} {...props} />;",
    "});",
    "const Row = React.memo<RowProps>(({ item }) => <li>{item}</li>);",
    "const Both = memo(forwardRef<HTMLDivElement, P>((p, ref) => <div ref={ref} />));",
    "const notAComponent = useState<number>(0);",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(src, "tsx")), ["function Input @1", "function Row @4", "function Both @5"]);
});

test("jsx: export default class extends, export default object", () => {
  const cls = [
    "export default class extends React.Component {",
    "  componentDidMount() {}",
    "  render() {",
    "    return null;",
    "  }",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(cls, "jsx")), [
    "class default @1",
    "  method componentDidMount @2",
    "  method render @3",
  ]);
  assert.deepEqual(rows(outlineJavaScript("export default class extends Base { render() {} }\n", "js")), [
    "class default @1",
    "  method render @1",
  ]);
  const vue = [
    "export default {",
    '  name: "Todo",',
    "  data() {",
    "    return { items: [] };",
    "  },",
    "  methods: {",
    "    save() {},",
    "    remove: function () {},",
    "  },",
    "  computed: { count: () => 1 },",
    "};",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(vue, "js")), [
    "variable default @1",
    "  method data @3",
    "  property methods @6",
    "    method save @7",
    "    method remove @8",
    "  property computed @10",
    "    method count @10",
  ]);
});

test("javascript: CommonJS exports and prototype methods", () => {
  const src = [
    '"use strict";',
    "exports.handler = async (event) => {",
    "  return { statusCode: 200 };",
    "};",
    "module.exports.close = function close() {};",
    "Store.prototype.add = function (item) {",
    "  function check() {}",
    "};",
    "module.exports = {",
    "  run() {},",
    "  stop: function () {},",
    "  Store,",
    "};",
    "module.exports.version = 3;",
    "obj.handler = () => {};",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineJavaScript(src, "js")), [
    "function handler @2",
    "function close @5",
    "function Store.prototype.add @6",
    "  function check @7",
    "variable module.exports @9",
    "  method run @10",
    "  method stop @11",
  ]);
});
