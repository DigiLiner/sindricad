// GH #17: the draw-time W/H box made every cursor move expensive. While it
// tracked the cursor it rewrote its text and re-selected it on EVERY pointer
// move. A focused field with a live selection is the costliest thing a
// software-painted WebKitGTK frame can carry: measured on the reporter's
// scenario (empty sketch, Rectangle, first corner placed, 300 moves at 60 Hz),
// the per-move rewrite + select took the app's own frame time from ~35 to
// 48.6 ms at half a CPU core with WEBKIT_DISABLE_DMABUF_RENDERER=1, which is the
// 20 fps on his screen (.fable/gh17-video/RESULT.md).
//
// What the user relies on, and what these hold: typing at any moment REPLACES
// the live figure instead of appending to it, Tab locks a field and moves on,
// Enter commits. The cost side is asserted as what the field is asked to do per
// move: no write when the shown text does not change, no selection per move.
//
// Driven through the REAL DimInput inside the real centre-rectangle preview
// (SketchMode.multiClickPreview, what a pointer move routes to for that tool),
// on the fakeDom stub. The stub's <input> is extended here with the one browser
// rule this hinges on and the stub does not model: writing a DIFFERENT value
// into a text field collapses its selection to a caret at the end (HTML spec,
// "value" setter). Without that rule a stub would let typing replace text that
// a real field would have appended to.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { FakeEl, fakeFocus, installFakeDocument } from "../ui/fakeDom.testkit";

vi.mock("../ui/toast", () => ({ toast: () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

/** An <input> that keeps a browser's selection rules and counts what the app
 *  asks of it. */
class BrowserInput extends FakeEl {
  private text = "";
  /** value assignments by the app, and select() calls by the app */
  writes = 0;
  selects = 0;

  constructor() {
    super("input");
    // An accessor over FakeEl's plain `value` field, defined on the instance
    // because the field is itself an own property.
    Object.defineProperty(this, "value", {
      get: () => this.text,
      set: (v: string) => {
        this.writes++;
        if (v !== this.text) {
          this.text = v;
          this.selectionStart = this.selectionEnd = v.length;
        }
      },
    });
  }

  override select() {
    this.selects++;
    super.select();
  }

  /** The user clicks a caret into the text at `at`. */
  clickCaret(at: number) {
    this.dispatch("pointerdown", {});
    this.selectionStart = this.selectionEnd = at;
  }

  /** One keystroke the way a browser runs it: keydown first (where a handler
   *  can still move the selection or cancel the key), then the character
   *  replaces whatever is selected, then `input`. */
  press(k: string) {
    let prevented = false;
    this.dispatch("keydown", {
      key: k, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault() { prevented = true; },
      stopPropagation() {},
    });
    if (prevented || k.length !== 1) return;
    const a = this.selectionStart ?? this.text.length;
    const b = this.selectionEnd ?? a;
    this.text = this.text.slice(0, a) + k + this.text.slice(b);
    this.selectionStart = this.selectionEnd = a + 1;
    this.dispatch("input");
  }
}

installFakeDocument();
const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
const plainCreate = doc.createElement as (tag: string) => FakeEl;
doc.createElement = (tag: string) => (tag === "input" ? new BrowserInput() : plainCreate(tag));
Object.defineProperty(doc, "activeElement", { get: () => fakeFocus.el });
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;

const { DimInput } = await import("./dimInput");
const { SketchMode } = await import("./sketchMode");
import type { ResolvedEntity } from "./snap";

interface Priv {
  multiClickAt(p: THREE.Vector2): void;
  multiClickPreview(cursor: THREE.Vector2): void;
  entities: ResolvedEntity[];
  lastCursor: THREE.Vector2;
}

/** A centre rectangle with its centre placed at the origin: the box is up and
 *  tracking, focused on width. */
function centreRectStarted() {
  const dim = new DimInput();
  const s = Object.create(SketchMode.prototype) as Record<string, unknown>;
  Object.assign(s, {
    tool: "centerRectangle",
    dim,
    entities: [] as ResolvedEntity[],
    constraints: [],
    clickPts: [] as THREE.Vector2[],
    lastCursor: new THREE.Vector2(),
    trial: null,
    base: null,
    baseRef: null,
    baseCurve: null,
    lastSnapRef: null,
    lastSnapCurve: null,
    rectCenterRef: null,
    rectCenterCurve: null,
    chainStart: null,
    constructionMode: false,
    solverDead: false,
    plane: { to3D: (x: number, y: number) => new THREE.Vector3(x, y, 0) },
    overlay: { setPreview: () => {} },
    entityCurve: () => ({}), // the drawn rubber band; not what these assert
    refreshActive: () => {},
    requestSolve: () => {},
    onState: undefined,
  });
  const mode = s as unknown as Priv;
  mode.multiClickAt(new THREE.Vector2(0, 0));
  const fields: BrowserInput[] = [];
  const walk = (el: FakeEl) => {
    if (el instanceof BrowserInput) fields.push(el);
    el.children.forEach(walk);
  };
  walk((dim as unknown as { root: FakeEl }).root);
  /** a pointer move to (x, y), routed the way the canvas routes it */
  const move = (x: number, y: number) => {
    mode.lastCursor = new THREE.Vector2(x, y);
    mode.multiClickPreview(mode.lastCursor);
  };
  return { mode, dim, w: fields[0]!, h: fields[1]!, move };
}

describe("GH #17: the tracking W/H box does no per-move work it does not need", () => {
  it("a move that keeps the shown figure leaves the field alone", () => {
    const { w, h, move } = centreRectStarted();
    move(30, 20);
    const writes = w.writes + h.writes;
    // 60 x 40 at three decimals, whichever way the sub-micron jitter goes
    for (let i = 1; i <= 10; i++) move(30 + i * 1e-5, 20 - i * 1e-5);
    expect(w.value).toBe("60");
    expect(h.value).toBe("40");
    expect(w.writes + h.writes - writes).toBe(0);
  });

  it("the figure still follows the cursor, and reads back as the cursor's exact value", () => {
    const { dim, w, h, move } = centreRectStarted();
    move(30, 20);
    move(31.25, 20.5);
    expect([w.value, h.value]).toEqual(["62.5", "41"]);
    // a jitter below the display's precision is still the value Enter commits
    move(31.25 + 1e-5, 20.5);
    expect(w.value).toBe("62.5");
    expect(dim.getValue("width")).toBeCloseTo(62.5 + 2e-5, 9);
  });

  it("moving the cursor never re-selects the text", () => {
    const { w, h, move } = centreRectStarted();
    const selects = w.selects + h.selects;
    for (let i = 0; i < 20; i++) move(10 + i, 5 + i / 2);
    expect(w.selects + h.selects - selects).toBe(0);
  });
});

describe("GH #17: the box behaves as before for the user", () => {
  it("typing after moves replaces the live figure, Tab moves on, Enter commits", () => {
    const { mode, w, h, move } = centreRectStarted();
    for (let i = 0; i < 20; i++) move(10 + i, 5 + i / 2);
    expect(w.value).toBe("58"); // tracking, caret parked at the end by the last write
    w.press("4");
    w.press("0");
    expect(w.value).toBe("40");
    w.press("Tab"); // locks width, focuses height
    expect(fakeFocus.el).toBe(h);
    move(12, 9); // width is locked now; height still tracks
    expect(w.value).toBe("40");
    expect(h.value).toBe("18");
    h.press("3");
    h.press("0");
    expect(h.value).toBe("30");
    h.press("Enter");
    expect(mode.entities).toHaveLength(1);
    expect(mode.entities[0]).toMatchObject({ type: "rectangle", width: 40, height: 30 });
  });

  it("typing after a move that kept the figure still replaces it", () => {
    const { mode, w, move } = centreRectStarted();
    move(31, 20); // "62": rewritten, caret at the end
    move(31 + 1e-5, 20); // still "62": nothing written, nothing selected
    w.press("7");
    expect(w.value).toBe("7");
    w.press("Enter");
    expect(mode.entities[0]).toMatchObject({ type: "rectangle", width: 7, height: 40 });
  });

  it("a caret the user clicked into the figure is where typing goes", () => {
    const { w, move } = centreRectStarted();
    move(30, 20);
    move(31, 20); // "62"
    w.clickCaret(1); // between the 6 and the 2
    w.press("5");
    expect(w.value).toBe("652");
  });
});
