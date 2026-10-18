// Ctrl+C, Ctrl+X and Ctrl+V inside a sketch reach the app as the sketch
// clipboard's actions (main.ts hands them to SketchMode), and nowhere else:
// not while a text field or a dimension box has the caret, not outside a
// sketch, and not over text the user selected on the page, where they are the
// browser's own copy and paste. The single-letter tool keys C and X (Circle,
// Construction) are a different keystroke and keep their meaning.
//
// Driven through the REAL keymap listener with keydown events shaped the way
// the browser delivers them.
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

class FakeInput extends FakeEl {
  constructor() {
    super("input");
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLInputElement = FakeInput;
g.HTMLTextAreaElement = class {};
g.HTMLSelectElement = class {};
g.HTMLElement = FakeEl;
installFakeDocument();

const handlers: ((e: unknown) => void)[] = [];
let pageSelection = "";
g.window = {
  addEventListener: (_t: string, fn: (e: unknown) => void) => handlers.push(fn),
  removeEventListener() {},
  getSelection: () => ({ isCollapsed: pageSelection === "", toString: () => pageSelection }),
};

const { installKeymap } = await import("./keymap");

const actions: string[] = [];
let context: "model" | "sketch" = "sketch";
installKeymap((a) => actions.push(a), () => context);

const canvas = new FakeEl("canvas");
function press(key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}, target: FakeEl = canvas) {
  let prevented = false;
  const e = {
    key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: false, isComposing: false, target,
    preventDefault: () => { prevented = true; }, stopPropagation() {},
  };
  for (const fn of handlers) fn(e);
  return prevented;
}

beforeEach(() => {
  actions.length = 0;
  context = "sketch";
  pageSelection = "";
});

describe("the sketch clipboard keys", () => {
  it("Ctrl+C, Ctrl+X and Ctrl+V in a sketch are Copy, Cut and Paste, and the browser's own is held back", () => {
    expect(press("c", { ctrl: true })).toBe(true);
    expect(press("x", { ctrl: true })).toBe(true);
    expect(press("v", { ctrl: true })).toBe(true);
    expect(actions).toEqual(["sketch-copy", "sketch-cut", "sketch-paste"]);
  });

  it("Cmd works as Ctrl does, and Caps Lock changes nothing", () => {
    press("c", { meta: true });
    press("V", { ctrl: true });
    expect(actions).toEqual(["sketch-copy", "sketch-paste"]);
  });

  it("the bare letters are still the Circle and Construction keys", () => {
    press("c");
    press("x");
    expect(actions).toEqual(["circle", "toggle-construction"]);
  });

  it("outside a sketch they are the browser's", () => {
    context = "model";
    expect(press("c", { ctrl: true })).toBe(false);
    expect(press("v", { ctrl: true })).toBe(false);
    expect(actions).toEqual([]);
  });

  it("in a text field or a dimension box they are the field's", () => {
    const input = new FakeInput();
    expect(press("c", { ctrl: true }, input)).toBe(false);
    expect(press("v", { ctrl: true }, input)).toBe(false);
    expect(actions).toEqual([]);
  });

  it("over text selected on the page they copy the text", () => {
    pageSelection = "Sketch1";
    expect(press("c", { ctrl: true })).toBe(false);
    expect(actions).toEqual([]);
  });

  it("Ctrl+Shift+C is not Copy (a browser's developer tools)", () => {
    expect(press("c", { ctrl: true, shift: true })).toBe(false);
    expect(actions).toEqual([]);
  });
});
