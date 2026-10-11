// X-angle-supplement (field report, beta 0.1.244 follow-up): a line's stored
// direction (start->end) is invisible on screen, so signedAngleDeg(l1, l2)
// (geom2d.ts) — which the solver's own angle constraint matches exactly —
// can read a line's angle to another line, OR that angle's 180-degree
// supplement, depending on which end it was drawn from. A line drawn
// right-to-left against the X axis used to show 150 degrees for an angle a
// user plainly sees as 30.
//
// The fix (geom2d.angleQuadrant): read the angle off the WEDGE the label
// sits in, which depends only on where the two lines are, not which end
// either was drawn from. Four independent call sites needed it: creating a
// dimension (dimensionTool.lineLine), displaying an existing one
// (entityDims.constraintDims), retyping an existing one's value
// (sketchMode.writeDimValue, via angleAsStoredValue), and the new "Flip
// side" menu action (sketchMode.flipAngleSide), which moves the label into
// the OTHER wedge without touching the constraint's stored value.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

const toasts: string[] = [];
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { isDimError, resolveDim, type DimTarget } from "./dimensionTool";
import { compileAndSolve } from "./sketchSolve";
import { constraintDims } from "./entityDims";
import { angleQuadrant, reflectAcrossLine } from "./geom2d";
import { ORIGIN_X_ID } from "./origin";
import { SketchMode } from "./sketchMode";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

describe("X-angle-supplement: a right-to-left line's angle to the X axis", () => {
  // Same visible line as angleSign.test.ts's `b` (10,10)->(36,25), which reads
  // 30 degrees, but drawn the other way round: (36,25)->(10,10). Identical on
  // screen, reversed start/end in storage.
  const bReversed = line("b", 36, 25, 10, 10);
  const axisX = line(ORIGIN_X_ID, -10_000, 0, 10_000, 0);

  it("reads 30 degrees at creation, the angle a user sees on screen (dimensionTool.resolveDim)", () => {
    const picks: DimTarget[] = [{ kind: "entity", e: bReversed }, { kind: "entity", e: axisX }];
    const res = resolveDim(picks);
    if (isDimError(res)) throw new Error(`expected a plan, got error "${res.error}"`);
    expect(res.kind).toBe("angle");
    expect(res.measure()).toBeCloseTo(30, 0);
  });

  it("typing the shown 30 moves nothing — the line keeps its on-screen angle", async () => {
    const picks: DimTarget[] = [{ kind: "entity", e: bReversed }, { kind: "entity", e: axisX }];
    const res = resolveDim(picks);
    if (isDimError(res)) throw new Error(`expected a plan, got error "${res.error}"`);
    const constraint = res.make(30);
    const r = await compileAndSolve([axisX, bReversed], [constraint]);
    expect(r.ok).toBe(true);
    const solved = r.entities.find((e) => e.id === "b");
    if (solved?.type !== "line") throw new Error("line lost");
    // visual angle of the solved line to the X axis, independent of which end
    // is start/end
    const dx = solved.x2 - solved.x1, dy = solved.y2 - solved.y1;
    const visual = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
    expect(Math.min(visual, 180 - visual)).toBeCloseTo(30, 0);
  });

  it("displaying an existing placed dim reads the same wedge (entityDims.constraintDims)", () => {
    // What dimensionTool stores for the reversed-line case above: the raw
    // signedAngleDeg magnitude (~150), not the 30 the badge shows — plus an
    // explicit `place` (even {0,0} at the default anchor), which is what
    // distinguishes this from a document saved before X-angle-supplement
    // existed (see the "legacy document" describe block below).
    const cons: SketchConstraint[] = [
      { type: "angle", l1: "b", l2: ORIGIN_X_ID, value: 150, place: { ox: 0, oy: 0 } },
    ];
    const dims = constraintDims([bReversed, axisX], cons);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.valueMm).toBeCloseTo(30, 0);
  });

  it("the actual bug this replaces: signedAngleDeg alone reads the supplement, 150", () => {
    // Documents why the fix is needed — the raw directed measurement, with no
    // quadrant awareness, is the wrong number for this geometry.
    const picks: DimTarget[] = [{ kind: "entity", e: bReversed }, { kind: "entity", e: axisX }];
    const res = resolveDim(picks);
    if (isDimError(res)) throw new Error(`expected a plan, got error "${res.error}"`);
    const constraint = res.make(30) as SketchConstraint & { value: number };
    expect(Math.abs(constraint.value)).toBeCloseTo(150, 0);
  });
});

describe("angleQuadrant / reflectAcrossLine", () => {
  const l1 = { x1: 0, y1: 0, x2: -10, y2: -5.7735 }; // direction ~210°: same line as 30°, reversed
  const l2 = { x1: -100, y1: 0, x2: 100, y2: 0 }; // the X axis

  it("classifies a label in the near wedge as direct, the far one as supplement", () => {
    expect(angleQuadrant(l1, l2, { x: 10, y: -1 })).toBe("direct");
    expect(angleQuadrant(l1, l2, { x: 10, y: 1 })).toBe("supplement");
  });

  it("reflecting a label across l1 moves it into the other wedge", () => {
    const p = { x: 10, y: 1 };
    const before = angleQuadrant(l1, l2, p);
    const reflected = reflectAcrossLine(l1, p);
    const after = angleQuadrant(l1, l2, reflected);
    expect(after).not.toBe(before);
  });
});

describe("retyping an existing placed angle badge is a no-op (sketchMode.writeDimValue)", () => {
  interface Priv {
    entities: ResolvedEntity[];
    constraints: SketchConstraint[];
    angleAsStoredValue(c: SketchConstraint & { value: number }, val: number): number;
    flipAngleSide(cIndex: number): void;
    viewport: { pixelWorldSize: (o: unknown) => number };
    plane: { origin: unknown };
    refreshActive: () => void;
    onState?: () => void;
  }

  function makeMode(entities: ResolvedEntity[], constraints: SketchConstraint[]) {
    const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
    Object.assign(s, {
      entities,
      constraints,
      viewport: { pixelWorldSize: () => 0.01 },
      plane: { origin: new THREE.Vector3(0, 0, 0) },
      refreshActive: () => {},
      onState: undefined,
    });
    return s as unknown as SketchMode & Priv;
  }

  it("retyping the shown magnitude (30) reproduces the same stored value", () => {
    const l1e = line("b", 36, 25, 10, 10);
    const axis = line(ORIGIN_X_ID, -10_000, 0, 10_000, 0);
    const c: SketchConstraint & { value: number } =
      { type: "angle", l1: "b", l2: ORIGIN_X_ID, value: 150, place: { ox: 0, oy: 0 } };
    const s = makeMode([l1e, axis], [c]);
    const stored = s.angleAsStoredValue(c, 30);
    expect(Math.abs(stored)).toBeCloseTo(150, 0);
  });

  it("Flip side reclassifies the quadrant without touching the stored value", () => {
    const l1e = line("b", 36, 25, 10, 10);
    const axis = line(ORIGIN_X_ID, -10_000, 0, 10_000, 0);
    const c: SketchConstraint & { value: number } =
      { type: "angle", l1: "b", l2: ORIGIN_X_ID, value: 150, place: { ox: 0, oy: 0 } };
    const s = makeMode([l1e, axis], [c]);
    const before = constraintDims([l1e, axis], s.constraints)[0]!;
    expect(before.valueMm).toBeCloseTo(30, 0);
    s.flipAngleSide(0);
    expect((s.constraints[0] as SketchConstraint & { value: number }).value).toBe(150); // untouched
    const after = constraintDims([l1e, axis], s.constraints)[0]!;
    expect(after.valueMm).toBeCloseTo(150, 0); // now reads the other wedge
  });
});

describe("a legacy document (saved before X-angle-supplement) keeps its old reading", () => {
  // Code review finding: a document saved under the OLD plain abs(value)
  // convention (no quadrant concept, no `place` field at all) must load
  // showing exactly the value it was saved with — not its supplement — even
  // though the new quadrant machinery, left ungated, would recompute off the
  // DEFAULT (unplaced) anchor and can disagree with what the old convention
  // showed. l1 is horizontal, l2 is at 150 degrees to it; an old-style save
  // of a 30-degree constraint stored the plain magnitude, 30, with no place.
  const l1 = line("l1", -60, 0, -40, 0);
  const l2 = line("l2", 0, 0, -10 * Math.cos((150 * Math.PI) / 180), -10 * Math.sin((150 * Math.PI) / 180));

  it("constraintDims reads the saved value verbatim, not its supplement", () => {
    const cons: SketchConstraint[] = [{ type: "angle", l1: "l1", l2: "l2", value: 30 }];
    const dims = constraintDims([l1, l2], cons);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.valueMm).toBeCloseTo(30, 0);
  });
});
