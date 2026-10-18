// Report c73b3174: "I want to make a line tangent to a circle FROM its end".
// Clicking the line's end and then the circle made the line tangent, but
// anywhere along it: the end stayed 0.255 mm off the circle, and the reporter
// had to add a Point-On and a Coincident by hand to get the joint. Thomas's
// call (2026-10-18): a Tangent pick that lands on a line's or an arc's own END
// makes that end touch the curve AND tangent there, in one step, whether or
// not the end is on the curve yet. A click on the line's body keeps the free
// tangency.
//
// Entered where the user enters: the real Tangent tool, the real trial and the
// real solve pump.

import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => {} }));
import { liveSketch } from "./liveSketch.testkit";
import { ConstraintTools } from "./constraintTools";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Circle = Extract<ResolvedEntity, { type: "circle" }>;

/** A live sketch whose constraint tools run the REAL trial (see
 *  coincidentMovesGroup.test.ts). */
async function opened(ents: ResolvedEntity[], cons: SketchConstraint[] = []) {
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

/** the reporter's shape: a line whose end is 2.2 mm off an r=10 circle */
const sketch = (): ResolvedEntity[] => [
  { type: "circle", id: "c", x: 0, y: 0, radius: 10 },
  { type: "line", id: "l", x1: 12.2, y1: 0, x2: 14, y2: 20 },
];

const offCircle = (c: Circle, p: { x: number; y: number }) => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - c.radius);
/** distance from the circle's centre to the line, less the radius: 0 when tangent */
const tangency = (l: Line, c: Circle) => {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return Math.abs(Math.abs((c.x - l.x1) * dy - (c.y - l.y1) * dx) / Math.hypot(dx, dy) - c.radius);
};

describe("Tangent from a line's end makes that end touch the curve and tangent there, in one step (c73b3174)", () => {
  it("the line's end first, then the circle", async () => {
    const live = await opened(sketch());
    expect(offCircle(live.ent("c") as Circle, { x: 12.2, y: 0 }), "CONTROL: the end starts off the circle").toBeGreaterThan(2);
    live.s.setTool("tangent");
    live.click(12.2, 0.2); // on the line's end
    live.click(0, 10); // the circle's rim
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: "l", p: 0, curve: "c" },
      { type: "tangent2", a: "l", b: "c" },
    ]);
    const l = live.ent("l") as Line, c = live.ent("c") as Circle;
    expect(offCircle(c, { x: l.x1, y: l.y1 }), "the end is not on the circle").toBeLessThan(1e-6);
    expect(tangency(l, c), "the line is not tangent").toBeLessThan(1e-6);
    // what was picked first moves: the circle stays where it was
    expect(Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.radius - 10)), "the circle moved").toBeLessThan(1e-9);
  });

  it("the circle first, then the line's end", async () => {
    const live = await opened(sketch());
    live.s.setTool("tangent");
    live.click(0, 10);
    live.click(12.2, 0.2);
    await live.settle();
    expect(live.s.constraints).toEqual([
      { type: "pointOn", e: "l", p: 0, curve: "c" },
      { type: "tangent2", a: "c", b: "l" },
    ]);
    const l = live.ent("l") as Line, c = live.ent("c") as Circle;
    expect(offCircle(c, { x: l.x1, y: l.y1 })).toBeLessThan(1e-6);
    expect(tangency(l, c)).toBeLessThan(1e-6);
  });

  it("CONTROL: a click on the line's body keeps the free tangency, with no hold", async () => {
    const live = await opened(sketch());
    live.s.setTool("tangent");
    live.click(13.1, 10); // the middle of the line
    live.click(0, 10);
    await live.settle();
    expect(live.s.constraints).toEqual([{ type: "tangent2", a: "l", b: "c" }]);
    const l = live.ent("l") as Line, c = live.ent("c") as Circle;
    expect(tangency(l, c)).toBeLessThan(1e-6);
    expect(offCircle(c, { x: l.x1, y: l.y1 }), "the end was pulled onto the circle anyway").toBeGreaterThan(0.1);
  });
});
