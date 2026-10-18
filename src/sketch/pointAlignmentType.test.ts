// Finding explore-sketcher-1016-4: a genuine 0 mm X or Y distance made with the
// Dimension tool was shown as a Horizontal/Vertical alignment (two H or V
// badges, no number), because the two-point Horizontal/Vertical tools stored
// their alignment as exactly that: an X/Y distance of 0 (d28dc27 then showed
// every such zero as an alignment). Thomas's call (2026-10-18): the alignment
// gets its own type, compiled to the same planegcs rule, and a zero distance
// from the Dimension tool reads as the distance it is.
//
// Entered where the user enters: the real Horizontal/Vertical clicks, the
// Dimension tool's own plan (resolveDim, which commitDim makes the constraint
// from), the real solver, and the inspector's commit (commitPanelDim).

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => {} }));
import { liveSketch } from "./liveSketch.testkit";
import { sketchDimRows, type SketchDimRow } from "./dimRows";
import { constraintGlyphs } from "./glyphs";
import { constraintDims } from "./entityDims";
import { compileAndSolve } from "./sketchSolve";
import { isDimError, resolveDim, type DimTarget } from "./dimensionTool";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

const A = { x: 10, y: 0 }, B = { x: 10, y: 20 }; // two points at the same X
const ents = (): ResolvedEntity[] => [
  { type: "point", id: "a", ...A },
  { type: "point", id: "b", ...B },
];

/** What the Dimension tool commits for a and b with its label dragged above
 *  them: the horizontal (X) distance, measured 0, its label placed. The id is
 *  the one setDrivingDimension stamps. */
function dimensionToolZero(): SketchConstraint {
  const pick = (e: ResolvedEntity, at: { x: number; y: number }): DimTarget =>
    ({ kind: "point", e, p: 0, pos: new THREE.Vector2(at.x, at.y) });
  const [ea, eb] = ents();
  const plan = resolveDim([pick(ea!, A), pick(eb!, B)], { cursor: new THREE.Vector2(10, 40) });
  if (isDimError(plan)) throw new Error(plan.error);
  const c = plan.make(plan.measure(), { ox: 0, oy: 30 });
  return { ...c, id: "c9" } as SketchConstraint;
}

const listed = (cons: SketchConstraint[]) =>
  sketchDimRows(ents(), cons).filter((r) => r.ref.kind === "constraint");

describe("a 0 mm distance made with the Dimension tool reads as a distance (explore-sketcher-1016-4)", () => {
  it("the tool's plan really is a horizontal distance of 0 (CONTROL: this is the case that was misread)", () => {
    expect(dimensionToolZero()).toMatchObject({ type: "p2pDistanceX", e1: "a", e2: "b", value: 0 });
  });

  it("is listed as a horizontal distance of 0, and has no H/V badge", () => {
    const cons = [dimensionToolZero()];
    const rows = listed(cons);
    expect(rows.map((r) => r.dim)).toEqual([t("inspector.sketchDim.kind.horizontal")]);
    expect(rows[0]!.valueMm).toBe(0);
    expect(constraintGlyphs(ents(), cons)).toEqual([]);
    // and, as before d28dc27, no label on the canvas: a dimension with no
    // length has no direction to draw along (constraintDims' meas < 1e-6)
    expect(constraintDims(ents(), cons)).toEqual([]);
  });

  it("CONTROL: Vertical on the same two points is still a V on each, and no dimension", () => {
    const live = liveSketch(ents());
    live.s.setTool("vertical");
    live.click(A.x, A.y);
    live.click(B.x, B.y);
    const cons = live.s.constraints;
    expect(cons).toEqual([{ type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 }]);
    expect(constraintGlyphs(ents(), cons).map((g) => g.label)).toEqual(["V", "V"]);
    expect(constraintDims(ents(), cons)).toEqual([]);
    expect(listed(cons).map((r) => r.dim)).toEqual([t("sketch.constraint.vertical")]);
  });
});

describe("the two-point alignments solve as the zero distances they were stored as", () => {
  const apart = (): ResolvedEntity[] => [
    { type: "point", id: "a", x: 0, y: 0 },
    { type: "point", id: "b", x: 3, y: 7 },
  ];
  const at = (r: { entities: ResolvedEntity[] }, id: string) => r.entities.find((e) => e.id === id) as { x: number; y: number };

  it("pointsVertical lines the two up (same X), and leaves Y alone", async () => {
    const r = await compileAndSolve(apart(), [{ type: "fix", e: "a", p: 0 }, { type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 }]);
    expect(r.ok && r.conflicts.length === 0).toBe(true);
    expect(Math.abs(at(r, "b").x - at(r, "a").x)).toBeLessThan(1e-9);
    expect(at(r, "b").y).toBeCloseTo(7, 9);
  });

  it("pointsHorizontal levels the two (same Y), and leaves X alone", async () => {
    const r = await compileAndSolve(apart(), [{ type: "fix", e: "a", p: 0 }, { type: "pointsHorizontal", e1: "a", p1: 0, e2: "b", p2: 0 }]);
    expect(r.ok && r.conflicts.length === 0).toBe(true);
    expect(Math.abs(at(r, "b").y - at(r, "a").y)).toBeLessThan(1e-9);
    expect(at(r, "b").x).toBeCloseTo(3, 9);
  });
});

describe("a number typed into an alignment's row makes it that X/Y distance, as before", () => {
  it("Horizontal on two points, given 5 in the inspector: a vertical distance of 5", async () => {
    const live = liveSketch([
      { type: "point", id: "a", x: 0, y: 0 },
      { type: "point", id: "b", x: 30, y: 4 },
    ], [{ type: "fix", e: "a", p: 0 }, { type: "pointsHorizontal", e1: "a", p1: 0, e2: "b", p2: 0 }]);
    live.s.requestSolve();
    await live.settle();
    const s = live.s as unknown as { commitPanelDim(row: SketchDimRow, raw: string): string | null };
    const row = sketchDimRows(live.s.entities, live.s.constraints).find((r) => r.ref.kind === "constraint");
    expect(row?.dim).toBe(t("sketch.constraint.horizontal"));
    expect(row?.valueMm).toBe(0);
    expect(s.commitPanelDim(row!, "5")).toBeNull();
    await live.settle();
    expect(live.s.constraints[1]).toMatchObject({ type: "p2pDistanceY", e1: "a", p1: 0, e2: "b", p2: 0, value: 5 });
    const b = live.ent("b") as { x: number; y: number };
    expect(b.y).toBeCloseTo(5, 6);
  });

  it("a value the row refuses leaves the alignment as it was", () => {
    const live = liveSketch(ents(), [{ type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 }]);
    const s = live.s as unknown as { commitPanelDim(row: SketchDimRow, raw: string): string | null };
    const row = sketchDimRows(live.s.entities, live.s.constraints).find((r) => r.ref.kind === "constraint")!;
    expect(s.commitPanelDim(row, "0")).not.toBeNull();
    expect(live.s.constraints).toEqual([{ type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 }]);
  });
});
