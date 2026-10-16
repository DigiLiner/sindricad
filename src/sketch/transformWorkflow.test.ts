// Move, Copy, Rotate and Scale: choose, then the point (Paul's reports from
// 2026-10-03):
//
//   53f5fcbb  "If I click Rotate first, I can only select a single line ... I
//             cannot do a multiselect ... I cannot select / snap to any of the
//             points on the sketch, all I can highlight is lines. ... the
//             degrees of rotation dialogue appears ... nowhere near the
//             rotation point I have picked"
//   8e712fc0  Mirror works nicely: select first, then the tool.
//   b64e2805  "Scale has same issue as Rotate: cannot snap on sketch points"
//   269bfb81  "if a user has not selected an element then warn/alert them
//             immediately ... don't let them highlight something in red, and
//             then warn them"
//
// Driven from where the user's input lands: the tool being armed (setTool),
// pointerdown and pointermove on the canvas, Enter and Esc, and keystrokes in
// the REAL on-canvas box (DimInput, against the fake DOM). A real SketchMode
// needs WebGL, so it is built off the prototype; what is stubbed is the
// viewport's screen<->plane mapping and rendering, never the logic under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));

import { SketchMode } from "./sketchMode";
import { DimInput } from "./dimInput";
import { SketchPlane } from "./plane";
import { originGeometry } from "./origin";
import { candidatesFromEntities, type ResolvedEntity, type SnapKind } from "./snap";
import { PROJECTED_FIXED_MSG } from "./modify";
import { compileAndSolve } from "./sketchSolve";
import { SketchHistory } from "./history";
import { ORIGIN_X_ID } from "./origin";
import { noteConstraintId } from "./id";
import type { SketchConstraint } from "../types";
import { EDGE_HOVER } from "../viewport/colors3d";
import { t } from "../i18n";

// The box's inputs, and SketchMode's key handler, narrow with instanceof.
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
g.Node = FakeEl;
installFakeDocument();
(g.document as { createElement(tag: string): FakeEl }).createElement = (tag: string) =>
  tag === "input" ? new FakeInput() : new FakeEl(tag);
vi.stubGlobal("requestAnimationFrame", () => 0);
// the real planegcs wasm on disk, as constraintSemantics.test.ts reaches it
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

/** 10 screen px per sketch mm, so the 10 px snap radius is 1 mm. */
const PX = 10;
const viewport = {
  screenToPlane: (cx: number, cy: number) => new THREE.Vector3(cx / PX, -cy / PX, 0),
  projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: -w.y * PX }),
  pixelWorldSize: () => 1 / PX,
  camera: {},
  domElement: { setPointerCapture() {}, releasePointerCapture() {} },
  hoverEntity() {},
  // no imported scan in a sketch-gesture fixture: nothing to snap onto
  scanVertexAt: () => null,
};

type Ptr = { button: number; clientX: number; clientY: number; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; pointerId: number; preventDefault(): void; stopPropagation(): void };
/** a primary press or move at sketch point (x, y) */
const at = (x: number, y: number, mods: { shift?: boolean; ctrl?: boolean } = {}): Ptr => ({
  button: 0, clientX: x * PX, clientY: -y * PX, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, metaKey: false, pointerId: 1,
  preventDefault() {}, stopPropagation() {},
});

interface Priv {
  onPointerDown(e: Ptr): void;
  onPointerMove(e: Ptr): void;
  onKey(e: unknown): void;
  setTool(tool: string): void;
  entities: ResolvedEntity[];
  selected: Set<string>;
  choosingPromptKey: string | null;
  lastPress: unknown;
}

// Two lines, a circle and a rectangle, away from each other and the origin.
const SHAPES = (): ResolvedEntity[] => [
  { type: "line", id: "a", x1: 10, y1: 10, x2: 30, y2: 10 },
  { type: "line", id: "b", x1: 10, y1: 20, x2: 30, y2: 20 },
  { type: "circle", id: "c", x: 50, y: 50, radius: 5 },
  { type: "rectangle", id: "r", x: -40, y: 30, width: 20, height: 10 },
];

/** The rectangle's inside, standing in for the area region.ts finds there:
 *  what a click inside the shape lands on when it misses every curve. */
const inRectArea = (p: THREE.Vector2) => p.x > -50 && p.x < -30 && p.y > 25 && p.y < 35;

function makeMode(selected: string[] = [], extra: ResolvedEntity[] = [], areaSelected = false) {
  const entities = [...originGeometry(), ...SHAPES(), ...extra];
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const dim = new DimInput();
  const seen = {
    previews: [] as THREE.Object3D[][], snaps: [] as (SnapKind | null)[], states: 0,
    /** what main.ts's onState puts in the prompt pill: the choosing prompt, or
     *  (null) the tool's own prompt, which is about the point */
    prompts: [] as (string | null)[],
  };
  const area = { region: "the rectangle's inside" };
  Object.assign(s, {
    active: true, tool: "select", entities, constraints: [], patterns: [], selected: new Set(selected), dim,
    pointCarry: {}, regionCarry: {}, plane: new SketchPlane("XY"), viewport, gridSnap: false, gridCell: 5,
    candidates: candidatesFromEntities(entities), // what refreshActive builds
    dims: { clearSelection() {}, setInteractive() {} },
    glyphs: { setInteractive() {} },
    textPanel: { hide() {} },
    projectPanel: { hide() {} },
    overlay: {
      setPreview: (objs: THREE.Object3D[]) => void seen.previews.push(objs),
      setSnap: (_w: unknown, kind?: SnapKind) => void seen.snaps.push(kind ?? null),
      setSnapScale() {},
      activeRegionAt: (p: THREE.Vector2) => (inRectArea(p) ? area : null),
      selectedActiveRegions: () => (areaSelected ? [area] : []),
      activeTextIdAt: () => null,
    },
    constraintTools: { heldOperandId: () => null, resetPending() {}, hasPending: () => false },
    patternFlow: { hasPending: () => false, flushPending() {} },
    filletFirst: null, clickPts: [], splinePts: [], lastCursor: new THREE.Vector2(), lastPress: null,
    offsetPick: null, polygonEdit: null, moveDrag: null, dragFrom: null, boxSel: null, textBoxStart: null,
    rightDownAt: null, rightDragged: false, trial: null, pendingBindings: new Map(), dimPicks: [],
    moveBase: null, transformPivot: null, pickingTargets: false,
    pickTol: () => 0.9,
    derivedEntities: () => [],
    refreshActive: () => {},
    requestSolve: () => {},
    afterModify: () => {},
    onState: () => { seen.states++; seen.prompts.push((s as unknown as Priv).choosingPromptKey); },
  });
  const priv = s as unknown as Priv;
  const box = () => (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields;
  const input = (name: string) => {
    const f = box().find((x) => x.def.name === name);
    if (!f) throw new Error(`no ${name} field in the box`);
    return f.input;
  };
  /** what typing does: the browser rewrites the text and fires `input` */
  const type = (name: string, text: string) => {
    const el = input(name);
    el.value = text;
    el.dispatch("input");
  };
  const enterIn = (name: string) =>
    input(name).dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
  /** a key pressed over the canvas, not into a box */
  const key = (k: string) => priv.onKey({ key: k, target: null, preventDefault() {} });
  /** a fresh press each time, so two clicks never read as a double-click */
  const click = (x: number, y: number, mods: { shift?: boolean; ctrl?: boolean } = {}) => {
    priv.lastPress = null;
    priv.onPointerDown(at(x, y, mods));
  };
  const lastPreview = () => seen.previews[seen.previews.length - 1] ?? [];
  const prompt = () => seen.prompts[seen.prompts.length - 1];
  const boxAt = () => {
    const st = (dim as unknown as { root: { style: Record<string, string> } }).root.style;
    return { left: st.left, top: st.top };
  };
  const ent = (id: string) => priv.entities.find((e) => e.id === id) as unknown as Record<string, number>;
  return { s: priv, dim, seen, input, type, enterIn, key, click, lastPreview, prompt, boxAt, ent };
}

/** the entity ids and colours a preview draws */
const litIds = (objs: THREE.Object3D[]) => [...new Set(objs.map((o) => o.userData.entityId as string))];
function colours(objs: THREE.Object3D[]): number[] {
  const out = new Set<number>();
  for (const o of objs) {
    o.traverse((c) => {
      const m = (c as unknown as { material?: { color?: THREE.Color } }).material;
      if (m?.color) out.add(m.color.getHex());
    });
  }
  return [...out];
}

beforeEach(() => { toasts.length = 0; });

describe("armed with nothing selected, the tool says so at once and its clicks choose", () => {
  it.each([
    ["move", "sketch.transform.selectFirstMove", "sketch.prompt.moveChoose"],
    ["copy", "sketch.transform.selectFirstCopy", "sketch.prompt.copyChoose"],
    ["rotate", "sketch.transform.selectFirstRotate", "sketch.prompt.rotateChoose"],
    ["scale", "sketch.transform.selectFirstScale", "sketch.prompt.scaleChoose"],
  ])("%s says what to select before any click", (tool, toastKey, promptKey) => {
    const { s } = makeMode();
    s.setTool(tool);
    expect(toasts).toEqual([t(toastKey)]);
    expect(s.choosingPromptKey).toBe(promptKey);
  });

  it("a selection made first is used as it is, the way Mirror uses one", () => {
    const { s } = makeMode(["a", "b"]);
    s.setTool("rotate");
    expect(toasts).toEqual([]);
    expect(s.choosingPromptKey, "straight to the pivot: main.ts shows the tool's own prompt").toBeNull();
    expect([...s.selected]).toEqual(["a", "b"]);
  });

  it("lights what a click would select in the hover colour, never the modify red", () => {
    const { s, lastPreview } = makeMode();
    s.setTool("rotate");
    s.onPointerMove(at(20, 10.2)); // on line a
    expect(litIds(lastPreview())).toEqual(["a"]);
    expect(colours(lastPreview())).toEqual([EDGE_HOVER]);
    s.onPointerMove(at(5, -8)); // on nothing
    expect(lastPreview()).toEqual([]);
  });

  it("a click selects, Shift or Ctrl adds and drops, and nothing complains", () => {
    const { s, click } = makeMode();
    s.setTool("rotate");
    toasts.length = 0; // the arming toast
    click(20, 10.2);
    expect([...s.selected]).toEqual(["a"]);
    click(20, 20.2, { ctrl: true });
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    click(55, 50, { shift: true }); // the circle's rim
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
    click(20, 10.2, { shift: true }); // again: dropped
    expect([...s.selected].sort()).toEqual(["b", "c"]);
    expect(s.choosingPromptKey, "still choosing after a pick: Enter ends it").toBe("sketch.prompt.rotateChoose");
    expect(toasts).toEqual([]);
  });

  it("a plain click on another curve takes it alone, and says so when that lets several go", () => {
    const { s, click } = makeMode();
    s.setTool("rotate");
    click(20, 10.2);
    toasts.length = 0;
    click(55, 50); // the circle's rim: one chosen thing swapped for another, as Select does
    expect([...s.selected]).toEqual(["c"]);
    expect(toasts).toEqual([]);
    click(20, 20.2, { shift: true });
    click(-40, 25.2); // the middle of the rectangle's bottom: a midpoint selects, it is no pivot
    expect([...s.selected]).toEqual(["r"]);
    expect(toasts).toEqual([t("sketch.transform.choseOnlyThis")]);
  });

  it("the point to turn about, clicked before Enter, keeps what is chosen and says to press Enter", () => {
    const { s, click, lastPreview } = makeMode();
    s.setTool("rotate");
    click(20, 10.2);
    click(20, 20.2, { shift: true });
    click(55, 50, { shift: true });
    toasts.length = 0;
    // the rectangle's corner: it used to swap all three for the rectangle, unsaid
    s.onPointerMove(at(-30.1, 25.1));
    expect(lastPreview(), "not lit: a plain click there would not choose it").toEqual([]);
    click(-30.1, 25.1);
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
    // a's own end: it used to leave the choice as it was, unsaid
    click(10.1, 10.1);
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
    expect(toasts).toEqual([t("sketch.transform.pressEnter"), t("sketch.transform.pressEnter")]);
    // Shift says "add": the corner's rectangle is chosen
    s.onPointerMove(at(-30.1, 25.1, { shift: true }));
    expect(litIds(lastPreview())).toEqual(["r"]);
    click(-30.1, 25.1, { shift: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "r"]);
  });

  it("a plain click on the one thing chosen says to press Enter, rather than nothing", () => {
    const { s, click } = makeMode();
    s.setTool("scale");
    click(20, 10.2);
    toasts.length = 0;
    click(22, 9.9);
    expect([...s.selected]).toEqual(["a"]);
    expect(toasts).toEqual([t("sketch.transform.pressEnter")]);
  });

  it("an area selected inside a shape is not called nothing, and a click inside one says to click its curves", () => {
    const armed = makeMode([], [], true);
    armed.s.setTool("rotate");
    expect(toasts, "the filled area is on screen: 'nothing is selected' would be false").toEqual([t("sketch.transform.areaNotCurves")]);
    expect(armed.s.choosingPromptKey).toBe("sketch.prompt.rotateChoose");

    const { s, click } = makeMode();
    s.setTool("move");
    toasts.length = 0;
    click(-45, 32); // inside the rectangle, on none of its sides
    expect([...s.selected]).toEqual([]);
    expect(toasts).toEqual([t("sketch.transform.areaNotCurves")]);
    click(20, 10.2);
    toasts.length = 0;
    click(-45, 32, { shift: true }); // adding the shape
    expect(toasts).toEqual([t("sketch.transform.areaNotCurves")]);
    toasts.length = 0;
    click(-45, 32); // a plain click there, with something chosen, is a free pivot point
    expect(toasts).toEqual([t("sketch.transform.pressEnter")]);
    expect([...s.selected]).toEqual(["a"]);
  });

  it("an origin axis is never chosen, and a click on nothing says to press Enter", () => {
    const { s, click } = makeMode();
    s.setTool("move");
    click(20, 10.2);
    toasts.length = 0;
    click(70, 0.1); // on the X axis, far from anything drawn
    expect([...s.selected]).toEqual(["a"]);
    expect(toasts).toEqual([t("sketch.transform.pressEnter")]);
  });

  it("projected geometry is refused when it is clicked, not after the move", () => {
    const projected = {
      type: "projected", id: "pj",
      source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
      curve: { kind: "line", x1: 10, y1: -20, x2: 30, y2: -20 },
    } as unknown as ResolvedEntity;
    const { s, click, lastPreview } = makeMode([], [projected]);
    s.setTool("rotate");
    toasts.length = 0;
    s.onPointerMove(at(20, -20.1));
    expect(lastPreview(), "not lit: the click would not take it").toEqual([]);
    click(20, -20.1);
    expect([...s.selected]).toEqual([]);
    expect(toasts).toEqual([PROJECTED_FIXED_MSG]);
  });

  it("Enter with nothing chosen says what to select again, and stays choosing", () => {
    const { s, key } = makeMode();
    s.setTool("scale");
    toasts.length = 0;
    key("Enter");
    expect(toasts).toEqual([t("sketch.transform.selectFirstScale")]);
    expect(s.choosingPromptKey).toBe("sketch.prompt.scaleChoose");
  });
});

describe("after Enter, the point snaps like a drawing click and the box opens beside it", () => {
  /** armed with nothing, a and b chosen, Enter */
  const chooseLines = (tool: string) => {
    const m = makeMode();
    m.s.setTool(tool);
    m.click(20, 10.2);
    m.click(20, 20.2, { ctrl: true });
    m.key("Enter");
    toasts.length = 0;
    return m;
  };

  it("Enter moves on to the point, and the hover shows the snap marker on points, not lit curves", () => {
    const { s, seen, lastPreview } = chooseLines("rotate");
    expect(s.choosingPromptKey).toBeNull();
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    const hover = (x: number, y: number) => {
      s.onPointerMove(at(x, y));
      return { snap: seen.snaps[seen.snaps.length - 1], lit: lastPreview() };
    };
    // an endpoint, a circle centre, a rectangle corner, the origin
    expect(hover(10.3, 9.8)).toEqual({ snap: "endpoint", lit: [] });
    expect(hover(50.4, 49.7)).toEqual({ snap: "center", lit: [] });
    expect(hover(-30.2, 25.3)).toEqual({ snap: "endpoint", lit: [] });
    expect(hover(0.3, -0.2)).toEqual({ snap: "endpoint", lit: [] });
    // on a line, away from its points: no curve lit (the old hover lit it red)
    expect(hover(20, 10.2).lit).toEqual([]);
  });

  it("the prompt pill follows the step: what to select, then the point, then what to select again", () => {
    const { s, click, key, prompt } = makeMode();
    s.setTool("rotate");
    expect(prompt()).toBe("sketch.prompt.rotateChoose");
    click(20, 10.2);
    click(20, 20.2, { ctrl: true });
    key("Enter");
    expect(prompt(), "Enter: the pill moves on to the point").toBeNull();
    key("Escape");
    expect([...s.selected]).toEqual([]);
    expect(prompt(), "Esc cleared the selection: back to what to select").toBe("sketch.prompt.rotateChoose");
  });

  it("an arc's centre is a pivot, as it is a drawing snap", () => {
    const h = Math.SQRT1_2 * 10;
    const arc = { type: "arc", id: "k", x1: 70, y1: -30, x2: 60, y2: -20, mx: 60 + h, my: -30 + h } as ResolvedEntity;
    const m = makeMode([], [arc]);
    m.s.setTool("rotate");
    m.click(20, 10.2);
    m.key("Enter");
    m.s.onPointerMove(at(60.3, -29.8));
    expect(m.seen.snaps[m.seen.snaps.length - 1]).toBe("center");
    m.click(60.3, -29.8);
    m.type("angle", "90");
    m.enterIn("angle");
    const a = m.ent("a");
    expect([a.x1, a.y1, a.x2, a.y2].map((v) => +v!.toFixed(9))).toEqual([20, -80, 20, -60]);
  });

  it("Rotate turns about the snapped corner, with the angle box beside it", () => {
    const { s, dim, type, enterIn, click, boxAt, ent } = chooseLines("rotate");
    click(10.3, 9.8); // half a millimetre off a's start
    expect(dim.isActive).toBe(true);
    // DimInput.position puts the box 16 px right of and below the point
    expect(boxAt()).toEqual({ left: `${10 * PX + 16}px`, top: `${-10 * PX + 16}px` });
    type("angle", "90");
    enterIn("angle");
    const a = ent("a"), b = ent("b");
    expect([a.x1, a.y1, a.x2, a.y2].map((v) => +v!.toFixed(9))).toEqual([10, 10, 10, 30]);
    expect([b.x1, b.y1, b.x2, b.y2].map((v) => +v!.toFixed(9))).toEqual([0, 10, 0, 30]);
    expect([...s.selected].sort(), "the rotated geometry stays selected for another turn").toEqual(["a", "b"]);
  });

  it("Scale grows about the snapped circle centre, with the factor box beside it", () => {
    const { dim, type, enterIn, click, boxAt, ent } = chooseLines("scale");
    click(50.4, 49.7);
    expect(dim.isActive).toBe(true);
    expect(boxAt()).toEqual({ left: `${50 * PX + 16}px`, top: `${-50 * PX + 16}px` });
    type("factor", "2");
    enterIn("factor");
    const a = ent("a");
    expect([a.x1, a.y1, a.x2, a.y2].map((v) => +v!.toFixed(9))).toEqual([-30, -30, 10, -30]);
  });

  it("Move takes a snapped base point and a snapped destination", () => {
    const { click, ent } = chooseLines("move");
    click(30.2, 20.3); // b's end
    click(-29.8, 25.2); // the rectangle's bottom-right corner
    const b = ent("b");
    expect([b.x1, b.y1, b.x2, b.y2].map((v) => +v!.toFixed(9))).toEqual([-50, 25, -30, 25]);
  });

  it("Esc with the box open drops the pivot and keeps the selection", () => {
    const { s, dim, click, input } = chooseLines("rotate");
    click(10.3, 9.8);
    s.onKey({ key: "Escape", target: input("angle"), preventDefault() {} });
    expect(dim.isActive).toBe(false);
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    expect(s.choosingPromptKey).toBeNull();
  });

  it("Esc that clears the selection goes back to choosing, which again lasts until Enter", () => {
    const { s, key, click } = chooseLines("rotate");
    key("Escape");
    expect([...s.selected]).toEqual([]);
    expect(s.choosingPromptKey).toBe("sketch.prompt.rotateChoose");
    click(20, 10.2);
    click(20, 20.2, { shift: true });
    expect([...s.selected].sort(), "the second pick adds, rather than being taken as the pivot").toEqual(["a", "b"]);
  });
});

// Copy carries the constraints and dimensions among what it copies (6c0c9504,
// promised on GH #41): every one whose operands are ALL in the copied set comes
// along, pointed at the copies, with its value; one that names anything else
// (an uncopied curve, the origin) stays behind rather than tying the copy to
// the original. Driven through the tool's own clicks, and judged by the real
// solver: an edited copy springs back to its dimensions, and the original
// does not move.
describe("Copy carries the constraints inside the copied set", () => {
  // a hexagon, a slot and two lines nobody copies, beside SHAPES
  const EXTRA: ResolvedEntity[] = [
    { type: "polygon", id: "pg", x: 0, y: -30, radius: 5, sides: 6, angle: 0 },
    { type: "slot", id: "sl", x1: 60, y1: -20, x2: 80, y2: -20, width: 6 },
    { type: "line", id: "x", x1: 100, y1: 100, x2: 120, y2: 100 },
    { type: "line", id: "y", x1: 100, y1: 110, x2: 120, y2: 110 },
  ];
  // every one already holds on the fixture, so a solve has nothing to move
  const CONS = (): SketchConstraint[] => [
    { type: "horizontal", line: "a" },
    { type: "parallel", l1: "a", l2: "b" },
    { type: "distance", id: "c1", line: "a", value: 20 },
    { type: "p2pDistance", id: "c2", e1: "a", p1: 0, e2: "b", p2: 0, value: 10, place: { ox: 1, oy: 2 } },
    { type: "diameter", id: "c3", circle: "c", value: 10 },
    { type: "fix", e: "c", p: 0 },
    { type: "distance", id: "c4", line: "r~0", value: 20 }, // a rectangle edge
    { type: "horizontal", line: "sl~2" }, // the slot's axis
    { type: "p2pDistanceX", id: "c5", e1: "pg", p1: -1, e2: "sl", p2: 0, value: 60 }, // hexagon centre to slot end
    { type: "offset", id: "c6", pairs: [{ src: "a", cpy: "b" }, { src: "x", cpy: "y" }], value: 10 },
    // these two name something the copy leaves behind
    { type: "parallel", l1: "b", l2: "x" },
    { type: "parallel", l1: "a", l2: ORIGIN_X_ID },
  ];
  const SOURCE = ["a", "b", "c", "r", "pg", "sl"];

  interface Live extends Priv {
    constraints: SketchConstraint[];
    pendingBindings: Map<string, { expr: string; kind: string }>;
    undoEdit(): boolean;
    redoEdit(): boolean;
  }
  /** Select `sel`, arm Copy, click a base point and a destination (50, 20)
   *  away. afterModify and the undo history are the real ones; only the solve
   *  pump is held, so each test runs the solver itself on what Copy left. */
  function copy(sel: string[]) {
    const m = makeMode(sel, EXTRA);
    const s = m.s as unknown as Live & Record<string, unknown>;
    s.constraints = CONS();
    for (const c of s.constraints) if ("id" in c) noteConstraintId(c.id); // as opening the sketch does
    delete s.afterModify;
    delete s.requestSolve;
    Object.assign(s, { history: new SketchHistory(), pump: async () => {}, solveDirty: false });
    (s.history as SketchHistory).reset({ entities: s.entities, constraints: s.constraints, patterns: [] } as never);
    // the source distance is bound to a parameter (the dims panel's `width`)
    s.pendingBindings.set("c:c1", { expr: "width", kind: "length" });
    const before = { entities: structuredClone(s.entities), constraints: structuredClone(s.constraints) };
    s.setTool("copy");
    m.click(200, 200);
    m.click(250, 220);
    const fresh = s.entities.filter((e) => !before.entities.some((b) => b.id === e.id));
    // each copy is where its source went, so match them up by position
    const of = new Map<string, string>();
    for (const e of before.entities) {
      if (!sel.includes(e.id)) continue;
      const moved = fresh.find((f) => canon({ ...f, id: "" }) === canon(shifted(e)));
      if (moved) of.set(e.id, moved.id);
    }
    return { s, before, of };
  }
  /** what the copy of `e` must look like, id aside */
  const shifted = (e: ResolvedEntity): ResolvedEntity => {
    const o = { ...e, id: "" } as Record<string, unknown>;
    for (const k of ["x", "x1", "x2"]) if (typeof o[k] === "number") o[k] = (o[k] as number) + 50;
    for (const k of ["y", "y1", "y2"]) if (typeof o[k] === "number") o[k] = (o[k] as number) + 20;
    return o as unknown as ResolvedEntity;
  };
  const canon = (e: ResolvedEntity) => JSON.stringify(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : 1)));
  const ids = (c: SketchConstraint) => JSON.stringify(c).match(/"(?:line|l1|l2|circle|e|e1|e2|src|cpy)":"[^"]+"/g) ?? [];

  it("brings every constraint and dimension whose operands are all copied, pointed at the copies", () => {
    const { s, before, of } = copy(SOURCE);
    expect(of.size, "one copy per selected entity").toBe(SOURCE.length);
    expect(s.constraints.slice(0, before.constraints.length), "the original's constraints are untouched").toEqual(before.constraints);
    const added = s.constraints.slice(before.constraints.length);
    const to = (id: string) => {
      const k = id.indexOf("~");
      return k < 0 ? of.get(id)! : of.get(id.slice(0, k))! + id.slice(k);
    };
    const dimIds = added.flatMap((c) => ("id" in c && c.id ? [c.id] : []));
    expect(added).toEqual([
      { type: "horizontal", line: to("a") },
      { type: "parallel", l1: to("a"), l2: to("b") },
      { type: "distance", id: dimIds[0], line: to("a"), value: 20 },
      { type: "p2pDistance", id: dimIds[1], e1: to("a"), p1: 0, e2: to("b"), p2: 0, value: 10, place: { ox: 1, oy: 2 } },
      { type: "diameter", id: dimIds[2], circle: to("c"), value: 10 },
      { type: "fix", e: to("c"), p: 0 },
      { type: "distance", id: dimIds[3], line: to("r~0"), value: 20 },
      { type: "horizontal", line: to("sl~2") },
      { type: "p2pDistanceX", id: dimIds[4], e1: to("pg"), p1: -1, e2: to("sl"), p2: 0, value: 60 },
      // the pair naming lines nobody copied is not carried; the other is
      { type: "offset", id: dimIds[5], pairs: [{ src: to("a"), cpy: to("b") }], value: 10 },
    ]);
    // every copied dimension is a dimension of its own: a parameter binding
    // names a dim by id, so sharing one would bind the copy to the original's
    expect(new Set(dimIds).size).toBe(6);
    for (const id of dimIds) expect(["c1", "c2", "c3", "c4", "c5", "c6"]).not.toContain(id);
    // the copy's distance is the source's value, not its parameter
    expect([...s.pendingBindings.keys()]).toEqual(["c:c1"]);
    // nothing shared: moving the copy's label leaves the original's where it is
    (added[3] as { place: { ox: number } }).place.ox = 99;
    expect((s.constraints[3] as { place: { ox: number } }).place.ox).toBe(1);
    // and none of the new ones name an original
    for (const c of added) for (const op of ids(c)) expect(SOURCE.some((id) => op.includes(`"${id}"`) || op.includes(`"${id}~`))).toBe(false);
  });

  it("a copy of part of a sketch leaves behind what ties it to the rest", () => {
    const { s, before, of } = copy(["a"]);
    const a2 = of.get("a")!;
    expect(s.constraints.slice(before.constraints.length)).toEqual([
      { type: "horizontal", line: a2 },
      { type: "distance", id: expect.any(String), line: a2, value: 20 },
    ]);
  });

  it("the solver holds the copy to its dimensions, and editing the copy leaves the original alone", async () => {
    const { s, of } = copy(SOURCE);
    const settled = await compileAndSolve([...s.entities], s.constraints);
    expect(settled.ok).toBe(true);
    expect(settled.conflicts).toEqual([]);
    const shift = Math.max(...settled.entities.flatMap((e, i) => {
      const was = s.entities[i] as unknown as Record<string, unknown>;
      return Object.entries(e).flatMap(([k, v]) => (typeof v === "number" && typeof was[k] === "number" ? [Math.abs(v - (was[k] as number))] : []));
    }));
    expect(shift, "the copy already satisfies what it carried").toBeLessThan(1e-6);

    // stretch the copied line to 30 and shrink the copied circle to r 2
    const a2 = of.get("a")!, c2 = of.get("c")!;
    const edited = s.entities.map((e) =>
      e.id === a2 && e.type === "line" ? { ...e, x2: e.x1 + 30 }
        : e.id === c2 && e.type === "circle" ? { ...e, radius: 2 } : e);
    const r = await compileAndSolve(edited, s.constraints);
    expect(r.ok).toBe(true);
    const got = (id: string) => r.entities.find((e) => e.id === id)!;
    const len = (e: ResolvedEntity) => (e.type === "line" ? Math.hypot(e.x2 - e.x1, e.y2 - e.y1) : NaN);
    expect(len(got(a2)), "the copy springs back to its 20 mm").toBeCloseTo(20, 6);
    expect((got(c2) as { radius: number }).radius, "and its 10 mm diameter").toBeCloseTo(5, 6);
    expect(got("a"), "the original line did not move").toEqual(s.entities.find((e) => e.id === "a"));
    expect(got("c"), "nor the original circle").toEqual(s.entities.find((e) => e.id === "c"));
  });

  it("text on a copied path rides the copy of the path; on a path left behind, the original", () => {
    const text = (id: string, pathRef: string) => ({ type: "text", id, text: "hi", x: 10, y: 10, height: 3, pathRef }) as ResolvedEntity;
    const m = makeMode(["a", "ta", "tx"], [...EXTRA, text("ta", "a"), text("tx", "x")]);
    m.s.setTool("copy");
    m.click(200, 200);
    m.click(250, 220);
    const copies = m.s.entities.filter((e) => [...m.s.selected].includes(e.id));
    const a2 = copies.find((e) => e.type === "line")!.id;
    expect(copies.filter((e) => e.type === "text").map((e) => (e as { pathRef: string }).pathRef)).toEqual([a2, "x"]);
  });

  it("one Undo takes the copies and their constraints away together, and Redo brings both back", () => {
    const { s, before } = copy(SOURCE);
    const after = { entities: structuredClone(s.entities), constraints: structuredClone(s.constraints) };
    expect(after.constraints.length).toBeGreaterThan(before.constraints.length);
    s.undoEdit();
    expect(s.entities).toEqual(before.entities);
    expect(s.constraints).toEqual(before.constraints);
    s.redoEdit();
    expect(s.entities).toEqual(after.entities);
    expect(s.constraints).toEqual(after.constraints);
  });
});
