// Menu -> page scripts (page-events.ts): fixed events, details from a closed list. Run: npm test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findScript, pickFolderScript, FIND_EVENT } = require("../dist/page-events");

function run(script) {
  const seen = [];
  const window = { dispatchEvent: (e) => seen.push(e) };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  class Event extends CustomEvent {}
  new Function("window", "Event", "CustomEvent", script)(window, Event, CustomEvent);
  return seen;
}

test("find menu items dispatch deltadeck:find with their action", () => {
  for (const action of ["open", "next", "prev"]) {
    const [e] = run(findScript(action));
    assert.equal(e.type, FIND_EVENT);
    assert.equal(e.detail, action);
  }
  assert.equal(FIND_EVENT, "deltadeck:find");
});

test("anything else is refused, never put into the script", () => {
  for (const bad of ["", "close", "open'); alert(1); ('", null, undefined, 1]) assert.throws(() => findScript(bad));
});

test("open folder dispatches its plain event", () => {
  const [e] = run(pickFolderScript());
  assert.equal(e.type, "deltadeck:pick-folder");
  assert.equal(e.detail, undefined);
});
