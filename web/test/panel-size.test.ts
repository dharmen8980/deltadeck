import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampWidth,
  dragWidth,
  keyResize,
  maxWidth,
  MIN_CONTENT,
  parseReadingWidth,
  parseWidth,
  READING_MAX,
  SIDEBAR_SPEC,
  TOC_SPEC,
} from "../src/lib/panel-size.ts";

test("max width: the spec max, half the window for the sidebar, never below min", () => {
  assert.equal(maxWidth(SIDEBAR_SPEC, 2000), 640);
  assert.equal(maxWidth(SIDEBAR_SPEC, 1000), 500);
  assert.equal(maxWidth(SIDEBAR_SPEC, 300), 192);
  assert.equal(maxWidth(TOC_SPEC, 1000), 350);
  // unknown window (server render): the spec max
  assert.equal(maxWidth(SIDEBAR_SPEC, 0), 640);
});

test("clamp keeps widths inside min..max and rounds", () => {
  assert.equal(clampWidth(100, SIDEBAR_SPEC, 1600), 192);
  assert.equal(clampWidth(900, SIDEBAR_SPEC, 1600), 640);
  assert.equal(clampWidth(333.6, SIDEBAR_SPEC, 1600), 334);
  // a narrow window re-clamps a saved wide sidebar (keeping MIN_CONTENT for the document)
  assert.equal(clampWidth(600, SIDEBAR_SPEC, 800), 800 - MIN_CONTENT);
  assert.equal(clampWidth(600, SIDEBAR_SPEC, 1000), 500);
  assert.equal(clampWidth(Number.NaN, SIDEBAR_SPEC, 1600), 320);
  assert.equal(clampWidth(Number.NaN, SIDEBAR_SPEC, 500), 192);
});

test("both panels together leave the document MIN_CONTENT", () => {
  assert.equal(MIN_CONTENT, 480);
  // 1280 window, sidebar at 640: the contents panel gets what is left, but never below its min
  assert.equal(maxWidth(TOC_SPEC, 1280, 640), 160);
  assert.equal(maxWidth(TOC_SPEC, 1280, 320), 448);
  assert.equal(maxWidth(TOC_SPEC, 1600, 640), 448);
  assert.equal(clampWidth(448, TOC_SPEC, 1280, 600), 200);
  assert.equal(clampWidth(Number.NaN, TOC_SPEC, 1280, 600), 200);
  assert.equal(keyResize("End", false, 240, TOC_SPEC, 1400, -1, 640), 280);
  assert.equal(keyResize("ArrowLeft", true, 240, TOC_SPEC, 1400, -1, 640), 280);
  assert.equal(dragWidth(240, -500, TOC_SPEC, 1400, -1, 640), 280);
  // a collapsed sidebar reserves nothing
  assert.equal(maxWidth(TOC_SPEC, 1280, 0), 448);
});

test("drag: right grows a left panel, left grows a right panel", () => {
  assert.equal(dragWidth(320, 50, SIDEBAR_SPEC, 1600, 1), 370);
  assert.equal(dragWidth(240, 50, TOC_SPEC, 1600, -1), 190);
  assert.equal(dragWidth(240, -500, TOC_SPEC, 1600, -1), 448);
  assert.equal(dragWidth(320, -500, SIDEBAR_SPEC, 1600, 1), 192);
});

test("keyboard: arrows step 16 (Shift 64), Home/End, Enter resets", () => {
  assert.equal(keyResize("ArrowRight", false, 320, SIDEBAR_SPEC, 1600, 1), 336);
  assert.equal(keyResize("ArrowLeft", true, 320, SIDEBAR_SPEC, 1600, 1), 256);
  // the TOC handle is on the panel's left edge: moving it left widens the panel
  assert.equal(keyResize("ArrowLeft", false, 240, TOC_SPEC, 1600, -1), 256);
  assert.equal(keyResize("ArrowRight", true, 240, TOC_SPEC, 1600, -1), 176);
  assert.equal(keyResize("ArrowLeft", true, 200, SIDEBAR_SPEC, 1600, 1), 192);
  assert.equal(keyResize("Home", false, 320, SIDEBAR_SPEC, 1600, 1), 192);
  assert.equal(keyResize("End", false, 320, SIDEBAR_SPEC, 1000, 1), 500);
  assert.equal(keyResize("Enter", false, 320, SIDEBAR_SPEC, 1600, 1), "reset");
  assert.equal(keyResize("a", false, 320, SIDEBAR_SPEC, 1600, 1), null);
  assert.equal(keyResize("ArrowUp", false, 320, SIDEBAR_SPEC, 1600, 1), null);
});

test("saved widths: integers inside the spec, anything else is the default", () => {
  assert.equal(parseWidth("400", SIDEBAR_SPEC), 400);
  assert.equal(parseWidth(" 400 ", SIDEBAR_SPEC), 400);
  assert.equal(parseWidth(null, SIDEBAR_SPEC), null);
  assert.equal(parseWidth(undefined, SIDEBAR_SPEC), null);
  assert.equal(parseWidth("", SIDEBAR_SPEC), null);
  assert.equal(parseWidth("20rem", SIDEBAR_SPEC), null);
  assert.equal(parseWidth("400.5", SIDEBAR_SPEC), null);
  assert.equal(parseWidth("-400", SIDEBAR_SPEC), null);
  assert.equal(parseWidth("100", SIDEBAR_SPEC), null);
  assert.equal(parseWidth("9999", SIDEBAR_SPEC), null);
});

test("reading width prefs", () => {
  assert.equal(parseReadingWidth("wide"), "wide");
  assert.equal(parseReadingWidth("full"), "full");
  assert.equal(parseReadingWidth("huge"), "full");
  assert.equal(parseReadingWidth("default"), "default");
  assert.equal(parseReadingWidth(null), "full");
  assert.equal(READING_MAX.default, "56rem");
  assert.equal(READING_MAX.full, "none");
});
