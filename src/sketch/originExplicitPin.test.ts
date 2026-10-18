// Thomas, 2026-10-19: only an EXPLICIT Coincident (or Fix) pins a point to the
// sketch origin. A point that merely lies at (0, 0) is a free point like any
// other.
//
// Until now the solver merged every endpoint lying exactly on the origin into
// the origin's own fixed point (sketchSolve's mergeable points), so such a
// point was pinned with nothing on screen saying so: a rectangle whose corner
// happened to sit at (0, 0) could not be moved by a constraint, while a body
// drag carried it off without a word. The finding explore-sketcher-1016-1 was
// this: Coincident from that rectangle's other corner onto a free line moved
// the LINE, against "what you picked moves".
//
// Drawing onto the origin with the snap already records the Coincident
// (snapCoincidentGesture.test.ts); a spline's ends did not, and now do.
//
// Entered where the user enters: the real Coincident and Spline tools, the
// real trial, solve pump and point drag.

import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
import { liveSketch } from "./liveSketch.testkit";
import { ConstraintTools } from "./constraintTools";
import { compileAndSolve } from "./sketchSolve";
import { ORIGIN_ID, originGeometry } from "./origin";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

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

const L = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
/** the finding's free, slanted line */
const T = L("T", 60, -10, 65, 40);
const lineMoved = (a: Line, b: Line) => Math.max(Math.hypot(a.x1 - b.x1, a.y1 - b.y1), Math.hypot(a.x2 - b.x2, a.y2 - b.y2));
const offLine = (l: Line, p: { x: number; y: number }) => {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return Math.abs((p.x - l.x1) * dy - (p.y - l.y1) * dx) / Math.hypot(dx, dy);
};
/** the finding's square: four lines held 40 x 30, one corner ON the origin */
const square = (): ResolvedEntity[] => [L("L1", 0, 0, 40, 0), L("L2", 40, 0, 40, 30), L("L3", 40, 30, 0, 30), L("L4", 0, 30, 0, 0), T];
const squareRules = (): SketchConstraint[] => [
  { type: "horizontal", line: "L1" }, { type: "vertical", line: "L2" },
  { type: "horizontal", line: "L3" }, { type: "vertical", line: "L4" },
  { type: "coincident", e1: "L1", p1: 1, e2: "L2", p2: 0 }, { type: "coincident", e1: "L2", p1: 1, e2: "L3", p2: 0 },
  { type: "coincident", e1: "L3", p1: 1, e2: "L4", p2: 0 }, { type: "coincident", e1: "L4", p1: 1, e2: "L1", p2: 0 },
  { id: "c1", type: "distance", line: "L1", value: 40 }, { id: "c2", type: "distance", line: "L2", value: 30 },
];

describe("a corner that merely lies on the origin is free (explore-sketcher-1016-1, the finding's own repro)", () => {
  it("Coincident from the square's far corner onto the free line moves the SQUARE, and the line stays", async () => {
    const live = await opened(square(), squareRules());
    live.s.setTool("coincident");
    live.click(40, 0); // the corner, first
    live.click(62.5, 15); // the line's middle, second
    await live.settle();
    const t = live.ent("T") as Line, l1 = live.ent("L1") as Line;
    expect(lineMoved(T, t), "the free line moved").toBeLessThan(1e-6);
    expect(offLine(t, { x: l1.x2, y: l1.y2 }), "the corner is not on the line").toBeLessThan(1e-6);
    expect(Math.hypot(l1.x1, l1.y1), "CONTROL: the square really left the origin").toBeGreaterThan(1);
  });

  it("CONTROL: the same square held to the origin by a Coincident stays there, and the line comes to it", async () => {
    const live = await opened(square(), [...squareRules(), { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "L1", p2: 0 }]);
    live.s.setTool("coincident");
    live.click(40, 0);
    live.click(62.5, 15);
    await live.settle();
    const l1 = live.ent("L1") as Line, t = live.ent("T") as Line;
    expect(Math.hypot(l1.x1, l1.y1), "the anchored corner left the origin").toBeLessThan(1e-6);
    expect(offLine(t, { x: l1.x2, y: l1.y2 })).toBeLessThan(1e-6);
  });

  it("a Fix pins it too", async () => {
    const r = await compileAndSolve([...originGeometry(), L("a", 0, 0, 10, 0)], [
      { type: "fix", e: "a", p: 0 },
      { id: "c1", type: "p2pDistance", e1: ORIGIN_ID, p1: 0, e2: "a", p2: 1, value: 25 },
    ]);
    const a = r.entities.find((e) => e.id === "a") as Line;
    expect(r.ok && r.conflicts.length === 0).toBe(true);
    expect([a.x1, a.y1]).toEqual([0, 0]);
  });
});

describe("two ends both joined to the origin are not an over-defined sketch", () => {
  it("a line's end and a rectangle's corner, each with its own Coincident to the origin", async () => {
    const r = await compileAndSolve([...originGeometry(), L("a", 0, 0, 10, 5), { type: "rectangle", id: "R", x: -10, y: -5, width: 20, height: 10 }], [
      { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "a", p2: 0 },
      { type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "R", p2: 2 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.overDefined, "an amber glyph on a join that is fine (field report 356b2693)").toEqual([]);
  });
});

describe("dragging a point that lies on the origin", () => {
  it("moves it when nothing holds it there", async () => {
    const live = await opened([{ type: "point", id: "P", x: 0, y: 0 }, L("a", 20, 20, 30, 20)], [
      { id: "c1", type: "p2pDistance", e1: "P", p1: 0, e2: "a", p2: 0, value: Math.hypot(20, 20) },
    ]);
    await live.drag([0, 0], [-5, 3]);
    const p = live.ent("P") as Pt;
    expect(Math.hypot(p.x, p.y), "the free point did not follow the drag").toBeGreaterThan(1);
  });

  it("refuses, as before, when a Coincident holds it on the origin", async () => {
    toasts.length = 0;
    const live = await opened([{ type: "point", id: "P", x: 0, y: 0 }], [{ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: "P", p2: 0 }]);
    await live.drag([0, 0], [-5, 3]);
    const p = live.ent("P") as Pt;
    expect([p.x, p.y]).toEqual([0, 0]);
    expect(toasts.length, "the drag was refused without a word").toBeGreaterThan(0);
  });
});

describe("a spline drawn from the origin is joined to it", () => {
  it("its first point, snapped onto the origin, gets the Coincident a line's end would", async () => {
    const live = await opened([], []);
    live.s.setTool("spline");
    live.click(0, 0);
    live.click(10, 5);
    live.click(20, 0);
    live.click(20, 0); // the last point again: finish
    await live.settle();
    const sp = live.s.entities.find((e) => e.type === "spline");
    expect(sp).toBeDefined();
    expect(live.s.constraints).toEqual([{ type: "coincident", e1: ORIGIN_ID, p1: 0, e2: sp!.id, p2: 0 }]);
  });
});
