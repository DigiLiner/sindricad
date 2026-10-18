// "What you picked moves" (bug #86, Thomas's rule), checked in the two places
// a finding said it did not hold:
//
//  * explore-sketcher-1016-1: Coincident from a RIGID shape's point (a fully
//    dimensioned rectangle's corner), picked first, onto a free line picked
//    second was reported to move the LINE 22 mm. It does not, for a shape that
//    is free to move: both of the finding's shapes are put on the line here and
//    the line stays. The finding's shapes had a corner at (0, 0), which the
//    solver merged into the origin's own fixed point, so there the rectangle
//    could not move at all and the line was the only answer. Since 2026-10-19
//    only an explicit Coincident does that (originExplicitPin.test.ts runs the
//    finding's own repro). These stay as the guard for the rule.
//  * explore-sketcher-1016-2: a number typed into the row of a Horizontal made
//    between a free point (picked first) and a rectangle's corner shrank the
//    rectangle and moved the point only part of the way: a two-entity X/Y
//    distance solved with no bias at all.
//
// Entered where the user enters: the real Coincident and Horizontal tools,
// the real trial and solve pump, the inspector's commit (commitPanelDim).

import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => {} }));
import { liveSketch } from "./liveSketch.testkit";
import { ConstraintTools } from "./constraintTools";
import { rectCorners } from "./region";
import { sketchDimRows, type SketchDimRow } from "./dimRows";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;
type Line = Extract<ResolvedEntity, { type: "line" }>;
type Pt = Extract<ResolvedEntity, { type: "point" }>;

/** A live sketch whose constraint tools run the REAL trial (see
 *  coincidentMovesGroup.test.ts). */
async function opened(ents: ResolvedEntity[], cons: SketchConstraint[]) {
  const live = liveSketch(ents, cons);
  const s = live.s as unknown as {
    addTrialConstraint(c: SketchConstraint, moves?: string, holds?: readonly SketchConstraint[]): void;
    requestSolve(): void;
    constraintTools: ConstraintTools;
    filletFirst: number | null;
  };
  s.constraintTools = new ConstraintTools({
    tool: () => live.s.tool,
    entities: () => live.s.entities,
    constraints: () => live.s.constraints,
    pickTol: () => 0.5,
    getFilletFirst: () => s.filletFirst,
    setFilletFirst: (v) => { s.filletFirst = v; },
    requestSolve: () => s.requestSolve(),
    addConstraint: (c, moves, holds) => s.addTrialConstraint(c, moves, holds),
    warn() {},
    setPendingPoints() {},
  });
  live.s.requestSolve();
  await live.settle();
  return live;
}

/** a free, slanted line to the right of the shapes below */
const T: Line = { type: "line", id: "T", x1: 60, y1: -10, x2: 65, y2: 40 };
const lineMoved = (a: Line, b: Line) => Math.max(Math.hypot(a.x1 - b.x1, a.y1 - b.y1), Math.hypot(a.x2 - b.x2, a.y2 - b.y2));
const offLine = (l: Line, p: { x: number; y: number }) => {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return Math.abs((p.x - l.x1) * dy - (p.y - l.y1) * dx) / Math.hypot(dx, dy);
};
const corners = (r: Rect) => rectCorners(r.x, r.y, r.width, r.height);

describe("Coincident: a rigid shape's point picked first moves the shape onto a free line (explore-sketcher-1016-1, a guard)", () => {
  it("a rectangle with its width and height locked", async () => {
    const R: Rect = { type: "rectangle", id: "R", x: 20, y: 25, width: 40, height: 30 }; // centred: corners (0,10) to (40,40)
    const live = await opened([R, T], [
      { id: "c1", type: "distance", line: "R~0", value: 40 },
      { id: "c2", type: "distance", line: "R~3", value: 30 },
    ]);
    const corner = corners(live.ent("R") as Rect)[1]!; // bottom right
    expect([corner.x, corner.y]).toEqual([40, 10]);
    live.s.setTool("coincident");
    live.click(40, 10); // the corner, first
    live.click(62.5, 15); // the line's middle, second
    await live.settle();
    expect(live.s.constraints.filter((c) => c.type === "pointOn")).toEqual([{ type: "pointOn", e: "R", p: 1, curve: "T" }]);
    const t = live.ent("T") as Line, r = live.ent("R") as Rect;
    expect(lineMoved(T, t), "the free line moved").toBeLessThan(1e-6);
    expect(offLine(t, corners(r)[1]!), "the corner is not on the line").toBeLessThan(1e-6);
    expect([r.width, r.height].map((n) => Math.abs(n)), "the rectangle changed size").toEqual([40, 30].map((n) => expect.closeTo(n, 6)));
  });

  it("four lines held square, 40 by 30 (the finding's own fixture)", async () => {
    const L = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
    const live = await opened([L("L1", 0, 10, 40, 10), L("L2", 40, 10, 40, 40), L("L3", 40, 40, 0, 40), L("L4", 0, 40, 0, 10), T], [
      { type: "horizontal", line: "L1" }, { type: "vertical", line: "L2" },
      { type: "horizontal", line: "L3" }, { type: "vertical", line: "L4" },
      { type: "coincident", e1: "L1", p1: 1, e2: "L2", p2: 0 }, { type: "coincident", e1: "L2", p1: 1, e2: "L3", p2: 0 },
      { type: "coincident", e1: "L3", p1: 1, e2: "L4", p2: 0 }, { type: "coincident", e1: "L4", p1: 1, e2: "L1", p2: 0 },
      { id: "c1", type: "distance", line: "L1", value: 40 }, { id: "c2", type: "distance", line: "L2", value: 30 },
    ]);
    live.s.setTool("coincident");
    live.click(40, 10);
    live.click(62.5, 15);
    await live.settle();
    const on = live.s.constraints.filter((c) => c.type === "pointOn");
    expect(on).toHaveLength(1);
    const t = live.ent("T") as Line;
    expect(lineMoved(T, t), "the free line moved").toBeLessThan(1e-6);
    const l1 = live.ent("L1") as Line;
    expect(offLine(t, { x: l1.x2, y: l1.y2 }), "the corner is not on the line").toBeLessThan(1e-6);
    expect(Math.hypot(l1.x2 - l1.x1, l1.y2 - l1.y1)).toBeCloseTo(40, 6);
  });

  it("CONTROL: a rectangle free to change size still gets there, and the line still stays", async () => {
    const R: Rect = { type: "rectangle", id: "R", x: 20, y: 25, width: 40, height: 30 }; // centred: corners (0,10) to (40,40)
    const live = await opened([R, T], []);
    live.s.setTool("coincident");
    live.click(40, 10);
    live.click(62.5, 15);
    await live.settle();
    const t = live.ent("T") as Line;
    expect(lineMoved(T, t)).toBeLessThan(1e-6);
    expect(offLine(t, corners(live.ent("R") as Rect)[1]!)).toBeLessThan(1e-6);
  });
});

describe("a number typed into a Horizontal between a point and a shape's corner moves the point (explore-sketcher-1016-2)", () => {
  it("the point, picked first, takes the whole gap; the rectangle does not move", async () => {
    const R: Rect = { type: "rectangle", id: "R", x: 30, y: 20, width: 20, height: 20 }; // corners (20,10) to (40,30)
    const live = await opened([{ type: "point", id: "A", x: 5, y: 7 }, R], []);
    live.s.setTool("horizontal");
    live.click(5, 7); // the point, first
    live.click(20, 10); // the rectangle's bottom-left corner
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "pointsHorizontal", e1: "A", p1: 0, e2: "R", p2: 0 }]);
    expect((live.ent("A") as Pt).y, "the alignment moved the point, picked first").toBeCloseTo(10, 6);
    const before = live.ent("R") as Rect;

    const row = sketchDimRows(live.s.entities, live.s.constraints).find((r) => r.ref.kind === "constraint")!;
    const s = live.s as unknown as { commitPanelDim(row: SketchDimRow, raw: string): string | null };
    expect(s.commitPanelDim(row, "5")).toBeNull();
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "p2pDistanceY", e1: "A", p1: 0, e2: "R", p2: 0, value: 5 }]);
    const r = live.ent("R") as Rect;
    expect([r.x, r.y, r.width, r.height]).toEqual([before.x, before.y, before.width, before.height].map((n) => expect.closeTo(n, 6)));
    // value = corner minus point along Y: the point drops to 5
    expect((live.ent("A") as Pt).y).toBeCloseTo(5, 6);
  });

  it("the same for an older file's alignment (a zero distance marked as one)", async () => {
    const R: Rect = { type: "rectangle", id: "R", x: 30, y: 20, width: 20, height: 20 };
    const live = await opened([{ type: "point", id: "A", x: 5, y: 10 }, R], [
      { type: "p2pDistanceY", id: "c3", e1: "A", p1: 0, e2: "R", p2: 0, value: 0, alignment: true },
    ]);
    const row = sketchDimRows(live.s.entities, live.s.constraints).find((r) => r.ref.kind === "constraint")!;
    const s = live.s as unknown as { commitPanelDim(row: SketchDimRow, raw: string): string | null };
    expect(s.commitPanelDim(row, "5")).toBeNull();
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "p2pDistanceY", id: "c3", e1: "A", p1: 0, e2: "R", p2: 0, value: 5 }]);
    const r = live.ent("R") as Rect;
    expect([r.x, r.y, r.width, r.height]).toEqual([30, 20, 20, 20].map((n) => expect.closeTo(n, 6)));
    expect((live.ent("A") as Pt).y).toBeCloseTo(5, 6);
  });
});
