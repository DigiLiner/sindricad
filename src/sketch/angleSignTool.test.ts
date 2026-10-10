// Extends angleSign.test.ts (the resolveDim-level repro) one layer up, through
// the real SketchMode click→type→Enter path (harness lifted from
// smartDimensionLine.test.ts) — the box must SHOW the magnitude a user reads
// off the geometry, and committing it must not flip the line. See
// angleSign.test.ts for the field report and root cause.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { installFakeDocument } from "../ui/fakeDom.testkit";
import { constraintDims } from "./entityDims";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

installFakeDocument(); // setPrompt looks for #prompt and finds none
vi.stubGlobal("requestAnimationFrame", () => 0);

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

const { SketchMode } = await import("./sketchMode");
const { DimInput } = await import("./dimInput");

const v = (x: number, y: number) => new THREE.Vector2(x, y);
// b: (10,10)->(36,25), atan2(15,26) ≈ +29.98°, "rising" — the field report's line
const B: ResolvedEntity = { type: "line", id: "b", x1: 10, y1: 10, x2: 36, y2: 25 };
// h: a plain horizontal line, standing in for the X origin axis in the report
const H: ResolvedEntity = { type: "line", id: "h", x1: 0, y1: 0, x2: 50, y2: 0 };
const TOL = 0.9;

function makeMode(realBox = true, entities: ResolvedEntity[] = [B, H]) {
  const s = Object.create(SketchMode.prototype) as InstanceType<typeof SketchMode>;
  const state = s as unknown as Record<string, unknown>;
  const stubBox = {
    isActive: false,
    show() { stubBox.isActive = true; },
    hide() { stubBox.isActive = false; },
    updateFromCursor() {},
    isUserDriven: () => false,
    isEdited: () => false,
    getRaw: () => "",
    setClickThrough() {},
    focus() {},
    position() {},
  };
  const dim = realBox ? new DimInput() : stubBox;
  Object.assign(state, {
    active: true,
    tool: "dimension",
    entities,
    constraints: [] as SketchConstraint[],
    dimPicks: [], dimPlan: null, dimPlace: null, dimPlaced: false, dimBoxAt: null,
    dimFieldKey: "", dimPlanKey: "", dimTangentArmed: false,
    referenceMode: false, solverDead: false,
    pendingBindings: new Map(), editingId: null, store: null,
    conflictIdx: new Set<number>(), overIdx: new Set<number>(),
    lastCursor: new THREE.Vector2(),
    dim,
    dims: { clearSelection() {} },
    doublePress: () => false,
    rightDownAt: null,
    boxSel: null,
    pickTol: () => TOL,
    planePoint: (e: { clientX: number; clientY: number }) => v(e.clientX, e.clientY),
    viewport: { pixelWorldSize: () => 0.1 },
    plane: { origin: new THREE.Vector3() },
    overlay: { setPreview() {} },
    dimTargetObjects: () => [],
    dimPreviewSegs: () => [],
    positionDimBox: () => {},
    requestSolve: () => {},
  });
  const ev = (p: THREE.Vector2) => ({ button: 0, clientX: p.x, clientY: p.y, preventDefault() {} });
  const call = (name: string, ...args: unknown[]) => (s as unknown as Record<string, (...a: unknown[]) => void>)[name]!.apply(s, args);
  return {
    s, state,
    down: (p: THREE.Vector2) => call("onPointerDown", ev(p)),
    enter: () => call("commitDim"),
    constraints: () => state.constraints as SketchConstraint[],
    lock: (cIndex: number, valueMm: number) => call("lockPlacedDim", cIndex, valueMm),
  };
}

/** The live value box's field — the last input appended to the fake DOM body. */
function boxField(): { value: string; dispatch(type: string): void } {
  type El = { tagName: string; children: El[]; value: string; dispatch(type: string): void };
  const out: El[] = [];
  const walk = (el: El) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk((globalThis as unknown as { document: { body: El } }).document.body);
  return out.at(-1)!;
}

const MID_B = v(23, 17.5); // midpoint of b
const MID_H = v(25, 0); // midpoint of h

describe("T2: creation box for an angle dimension (b then h)", () => {
  it("shows the magnitude, not the signed measurement", () => {
    const m = makeMode();
    m.down(MID_B); // pick b
    m.down(MID_H); // pick h -> resolves the angle plan
    expect(Number(boxField().value)).toBeCloseTo(29.98, 1);
  });

  it("typing 30 and Enter stores the NEGATIVE of what was typed (the measurement's sign)", () => {
    const m = makeMode();
    m.down(MID_B);
    m.down(MID_H);
    const f = boxField();
    f.value = "30";
    f.dispatch("input");
    m.enter();
    expect(m.constraints()).toEqual([expect.objectContaining({ type: "angle", l1: "b", l2: "h", value: -30 })]);
  });

  it("untouched Enter commits the measured value, not its positive readout", () => {
    const m = makeMode();
    m.down(MID_B);
    m.down(MID_H);
    m.enter();
    expect(m.constraints()).toHaveLength(1);
    const c = m.constraints()[0] as SketchConstraint & { value: number };
    expect(c.value).toBeCloseTo(-29.98, 1);
  });
});

describe("T3: picking the same pair in reverse keeps the line still", () => {
  it("retyping the badge's own number on the flipped pick order does not move b", () => {
    // An existing {l1:b, l2:h, value:-30}-ish constraint (what T2 stores).
    const existing: SketchConstraint = { type: "angle", l1: "b", l2: "h", value: -30 } as SketchConstraint;
    const m = makeMode(true);
    (m.state.constraints as SketchConstraint[]).push(existing);
    m.down(MID_H); // pick h FIRST this time
    m.down(MID_B); // then b
    const f = boxField();
    expect(Number(f.value)).toBeCloseTo(29.98, 1); // the badge's own magnitude
    f.dispatch("input"); // untouched: commits the measurement itself
    m.enter();
    const made = m.constraints().filter((c) => c !== existing || true);
    const last = made.at(-1) as SketchConstraint & { l1: string; l2: string; value: number };
    expect(last).toMatchObject({ type: "angle", l1: "h", l2: "b" });
    expect(last.value).toBeCloseTo(30, 1); // positive: same geometry, opposite pick order
  });
});

describe("T7: Lock Dimension on a reference angle freezes the LIVE measurement", () => {
  it("locks at the measured ~-30, not the stale stored +30, and b does not move", () => {
    const m = makeMode();
    // a reference dim whose stored value went stale (b moved since it last
    // drove): the live measurement from b to h is ~-29.98, but the field still
    // reads the old +30.
    const existing: SketchConstraint = { type: "angle", l1: "b", l2: "h", value: 30, driven: true } as SketchConstraint;
    (m.state.constraints as SketchConstraint[]).push(existing);

    // exactly what the badge's menu does: read the row's own (cIndex, valueMm)
    // and hand them to lockPlacedDim (sketchMode.ts's onLock).
    const d = constraintDims(m.state.entities as ResolvedEntity[], m.constraints()).find((x) => x.kind === "angle")!;
    expect(d.driven).toBe(true);
    expect(d.valueMm).toBeCloseTo(29.98, 1); // the badge showed a magnitude

    // lockPlacedDim's own concern ends at the constraint it writes; the rest of
    // refreshActive() is full-UI machinery (overlay, glyphs, text panel) this
    // harness does not stand up.
    m.state.refreshActive = () => {};
    m.lock(d.cIndex, d.valueMm);

    const c = m.constraints()[0] as SketchConstraint & { value: number; driven?: boolean };
    expect(c.driven).toBeUndefined(); // now driving
    expect(c.value).toBeCloseTo(-29.98, 1); // the SIGNED measurement, not +30 and not +29.98
    // b itself never moved
    const b = (m.state.entities as ResolvedEntity[]).find((e) => e.id === "b");
    expect(b).toEqual(B);
  });
});
