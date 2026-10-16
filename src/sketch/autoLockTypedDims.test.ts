// A value the user TYPES into a draw-time dim box (a centre rectangle's width/
// height, a circle's diameter) used to size the fresh entity and then vanish:
// no constraint held it, so the very next Equal or drag-driven resize could
// carry it away, and the only way to pin it back down was a separate Lock
// click on the badge. Reports 71b9955e (rectangle) and 75d4e294 (circle).
//
// Retyping an EXISTING rectangle's width/height had the same gap the other
// way round: a circle's diameter or a line's length auto-locks the moment you
// retype it (directDims.drivingDimFor), a rectangle's did not. Report
// e9742a4f: "in other dimensions that are not locked, if I change them they
// become locked" — true for everything except a rectangle.
//
// Decided scope (Thomas): rectangle width/height and circle diameter only.
// Slot width, polygon radius and line angle stay direct writes — lockDimFor
// has no constraint form for them, so there is nothing to auto-lock to.
//
// These drive the real private methods off SketchMode.prototype — no WebGL,
// same technique as dimFieldRefusal.test.ts — with the REAL DimInput on the
// fakeDom stub, typed into the way a user types (input events, Tab, Enter). The
// first version of this file used a fake dim box whose hide() did nothing, so
// it passed while the centre rectangle hid the box (emptying every field)
// BEFORE reading which fields were typed, and locked nothing (95108ab8; it is
// why 71b9955e was closed as fixed when it was not). The real box clears its
// fields on hide(), so that ordering now fails here.
//
// The solve itself is stubbed everywhere except the one test that needs to
// observe the geometry move (editDimension on an existing entity), which sets
// solverDead so the no-solver fallback (applyDrivingDimsDirectly) runs
// synchronously instead.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

const toasts: string[] = [];
import { vi } from "vitest";
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

installFakeDocument();
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;

const { DimInput } = await import("./dimInput");
const { SketchMode } = await import("./sketchMode");
import { governingDimAt } from "./directDims";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const key = (k: string) => ({
  key: k, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  preventDefault() {}, stopPropagation() {},
});

/** The dim box's <input>s, in the order the box shows them. */
function inputs(dim: InstanceType<typeof DimInput>): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk((dim as unknown as { root: FakeEl }).root);
  return out;
}

/** What the user does: type into field `i` (an input event marks it typed). */
function typeInto(dim: InstanceType<typeof DimInput>, i: number, text: string) {
  const el = inputs(dim)[i]!;
  el.value = text;
  el.dispatch("input");
}

/** ...and press Enter in it, which is the box's commit. */
function pressEnter(dim: InstanceType<typeof DimInput>) {
  inputs(dim)[0]!.dispatch("keydown", key("Enter"));
}

interface Priv {
  commitFromCursor(cursor: THREE.Vector2): void;
  multiClickAt(p: THREE.Vector2): void;
  showDimFields(): void;
  editDimension(index: number, field: string, mm: number): void;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  clickPts: THREE.Vector2[];
  lastCursor: THREE.Vector2;
  solverDead: boolean;
}

function makeMode(tool: string, base?: THREE.Vector2, over: Record<string, unknown> = {}) {
  const dim = new DimInput();
  const s = Object.create(SketchMode.prototype) as InstanceType<typeof SketchMode> & Record<string, unknown>;
  Object.assign(s, {
    tool,
    dim,
    entities: [] as ResolvedEntity[],
    constraints: [] as SketchConstraint[],
    clickPts: [] as THREE.Vector2[],
    lastCursor: new THREE.Vector2(),
    trial: null,
    base: base ?? null,
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
    multiClickPreview: () => {}, // the live preview; not what these assert
    refreshActive: () => {},
    requestSolve: () => {},
    onState: undefined,
    ...over,
  });
  return { s: s as unknown as Omit<InstanceType<typeof SketchMode>, keyof Priv> & Priv, dim };
}

/** A multi-click tool (centre rectangle, 2-point circle) the way the user runs
 *  it: the first click opens the box, they type, Enter places the rest at the
 *  cursor. `typed` is [field index, text]. */
function multiClickTyped(tool: string, first: THREE.Vector2, cursor: THREE.Vector2, typed: [number, string][]) {
  const { s, dim } = makeMode(tool);
  s.multiClickAt(first); // what a canvas click routes to for these tools
  for (const [i, text] of typed) typeInto(dim, i, text);
  s.lastCursor = cursor.clone();
  pressEnter(dim);
  return { s, dim };
}

/** A drag-draw tool (corner rectangle, centre circle) from its first click: the
 *  base is placed and the box is up. */
function dragDrawTyped(tool: string, base: THREE.Vector2, cursor: THREE.Vector2, typed: [number, string][]) {
  const { s, dim } = makeMode(tool, base);
  s.showDimFields();
  for (const [i, text] of typed) typeInto(dim, i, text);
  s.lastCursor = cursor.clone();
  pressEnter(dim);
  return { s, dim };
}

describe("71b9955e/75d4e294/95108ab8: a draw-time typed value locks on commit", () => {
  it("a centre rectangle's typed width AND height both lock", () => {
    // corner ignored: W/H are typed
    const { s, dim } = multiClickTyped("centerRectangle", new THREE.Vector2(0, 0), new THREE.Vector2(30, 20), [[0, "60"], [1, "40"]]);
    expect(s.entities).toHaveLength(1);
    const rect = s.entities[0]!;
    expect(rect).toMatchObject({ type: "rectangle", width: 60, height: 40 });
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
    expect(governingDimAt(s.constraints, rect, "height")).not.toBe("free");
    expect(dim.isActive).toBe(false); // ...and the box still closes
  });

  it("a centre rectangle with only width typed locks width, leaves height free", () => {
    const { s } = multiClickTyped("centerRectangle", new THREE.Vector2(0, 0), new THREE.Vector2(30, 20), [[0, "60"]]);
    const rect = s.entities[0]!;
    expect(rect).toMatchObject({ type: "rectangle", width: 60, height: 40 }); // height from the cursor
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
    expect(governingDimAt(s.constraints, rect, "height")).toBe("free"); // left to the drag, as always
  });

  it("a 2-point circle's typed diameter locks on commit", () => {
    const { s, dim } = multiClickTyped("circle2", new THREE.Vector2(0, 0), new THREE.Vector2(5, 0), [[0, "20"]]);
    const circle = s.entities[0]!;
    expect(circle).toMatchObject({ type: "circle", radius: 10 });
    expect(s.constraints).toMatchObject([{ type: "diameter", circle: circle.id, value: 20 }]);
    expect(dim.isActive).toBe(false);
  });

  it("an un-typed 2-point circle (clicked size) stays free", () => {
    const { s } = multiClickTyped("circle2", new THREE.Vector2(0, 0), new THREE.Vector2(5, 0), []);
    const circle = s.entities[0]!;
    expect(circle).toMatchObject({ type: "circle", radius: 2.5 });
    expect(governingDimAt(s.constraints, circle, "diameter")).toBe("free");
  });

  it("a corner-to-corner rectangle's typed width/height locks the same way", () => {
    // cursor ignored: both fields are typed
    const { s } = dragDrawTyped("rectangle", new THREE.Vector2(0, 0), new THREE.Vector2(5, 5), [[0, "60"], [1, "40"]]);
    const rect = s.entities[0]!;
    expect(rect).toMatchObject({ type: "rectangle", width: 60, height: 40 });
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
    expect(governingDimAt(s.constraints, rect, "height")).not.toBe("free");
  });

  it("a drawn circle's typed diameter locks on commit", () => {
    // cursor distance ignored: diameter is typed
    const { s } = dragDrawTyped("circle", new THREE.Vector2(0, 0), new THREE.Vector2(5, 0), [[0, "20"]]);
    const circle = s.entities[0]!;
    expect(circle).toMatchObject({ type: "circle", radius: 10 });
    expect(s.constraints).toMatchObject([{ type: "diameter", circle: circle.id, value: 20 }]);
  });

  it("an un-typed drawn circle (dragged size) stays free, as before", () => {
    const { s } = dragDrawTyped("circle", new THREE.Vector2(0, 0), new THREE.Vector2(5, 0), []);
    const circle = s.entities[0]!;
    expect(governingDimAt(s.constraints, circle, "diameter")).toBe("free");
  });
});

describe("e9742a4f: retyping an EXISTING rectangle's dim now auto-locks too", () => {
  it("editDimension on a circle's diameter still auto-locks (drivingDimFor, unchanged)", () => {
    const { s } = makeMode("select");
    s.entities = [{ type: "circle", id: "c1", x: 0, y: 0, radius: 5 }];
    s.editDimension(0, "diameter", 30);
    expect(s.constraints).toMatchObject([{ type: "diameter", circle: "c1", value: 30 }]);
  });

  it("editDimension on a rectangle's width now auto-locks instead of staying free", () => {
    // No real solver in this stub, so force the no-solver fallback
    // (applyDrivingDimsDirectly) to observe the write synchronously — the
    // same path a machine with no solver takes in the real app.
    const { s } = makeMode("select", undefined, { solverDead: true });
    s.entities = [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 50 }];
    s.editDimension(0, "width", 60);
    const rect = s.entities[0]!;
    expect(rect).toMatchObject({ width: 60 });
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
  });
});
