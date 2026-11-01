import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineCss, preprocess } from "../src/lib/outline/css.ts";
import { find, fixture, rows } from "./outline-util.ts";

test("css: selectors, groups, keyframes, font-face, layers, nesting", () => {
  const out = outlineCss(fixture("sample.css"), "css");
  assert.deepEqual(rows(out), [
    "selector :root @3",
    "selector .a > .b, #c:hover::before @4",
    "media @media (max-width: 600px) and (prefers-color-scheme: dark) @5",
    "  selector .d @6",
    "  supports @supports (display: grid) @7",
    "    selector .e @7",
    "keyframes @keyframes spin @9", // stops are not listed
    "font-face @font-face @10",
    "layer @layer components @11", // `@layer base, components;` (a statement) is not
    "  selector .btn @11",
    "container @container sidebar (min-width: 400px) @12",
    "  selector .card @12",
    "selector .nest @13",
    "  selector &:hover @13",
    "  selector .child @13",
  ]);
  assert.equal(find(out, "@media (max-width: 600px) and (prefers-color-scheme: dark)")?.endLine, 8);
});

test("scss: placeholders, mixins, functions, interpolation, control flow", () => {
  assert.deepEqual(rows(outlineCss(fixture("sample.scss"), "scss")), [
    "selector %visually-hidden @4",
    "at-rule @function rem($px) @5",
    "at-rule @mixin respond($bp) @6",
    "  media @media (min-width: map-get($breakpoints, $bp)) @7",
    "selector .card @9",
    "  selector &__title @13",
    "  selector &:hover, &.is-active @14",
    "  selector .icon + & @15",
    "  selector #{$self}--wide @17",
    "selector .w-#{$name} @20", // the @each itself is not listed, its rules are
  ]);
});

test("less: variables, mixin calls, guards, interpolation", () => {
  assert.deepEqual(rows(outlineCss(fixture("sample.less"), "less")), [
    "selector .mixin(@a) @3",
    "selector .btn @4",
    "  selector &-primary @6",
    "  media @media (min-width: 768px) @7",
    "selector .@{prefix}-card @9",
    "  selector .inner @11", // the guard is not part of the name
    "selector #ns @13",
    "  selector .m() @13",
    "selector .use @14",
  ]);
});

test("preprocess keeps every offset", () => {
  for (const [name, variant] of [
    ["sample.scss", "scss"],
    ["sample.less", "less"],
  ] as const) {
    const src = fixture(name);
    const out = preprocess(src, variant);
    assert.equal(out.length, src.length);
    assert.deepEqual(out.split("\n").map((l) => l.length), src.split("\n").map((l) => l.length));
  }
  assert.equal(preprocess("a { b: c } // x {", "css"), "a { b: c } // x {");
});

test("less: &:extend() is not merged into the next selector", () => {
  const src = [
    "#header {", // 1
    "  &:extend(.foo all);",
    "  .logo when (@mode = dark) {",
    "    width: 300px;",
    "  }",
    "  &:hover { color: red; }",
    "}",
    ".guard when (iscolor(@c)) { color: @c; }",
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineCss(src, "less")), [
    "selector #header @1",
    "  selector .logo @3",
    "  selector &:hover @6",
    "selector .guard @8",
  ]);
});

test("preprocess is linear: about 1 MB of SCSS / LESS in well under a second", () => {
  for (const [name, variant] of [
    ["sample.scss", "scss"],
    ["sample.less", "less"],
  ] as const) {
    const one = fixture(name);
    const big = one.repeat(Math.ceil(1_000_000 / one.length));
    const start = performance.now();
    const out = preprocess(big, variant);
    const ms = performance.now() - start;
    assert.equal(out.length, big.length);
    // was 0.5-2 s (quadratic); now about 20 ms. Generous for slow CI machines.
    assert.ok(ms < 400, `${name}: ${Math.round(ms)} ms`);
  }
});
