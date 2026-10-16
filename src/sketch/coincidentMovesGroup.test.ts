// Report d97616d8: "I made the circle coincident with the diagonal and the
// RECTANGLE moved too." The Coincident tool puts the picked point on the curve
// and arms the mover bias for that point's entity (bug #86: the point moves).
// But the circle was tied to three others by zero-gap alignments, so it could
// not move alone; the bias then had no clean answer and the solve spread the
// correction over everything it could reach, the rectangle included (0.148 mm
// on the reporter's document).
//
// Entered where the user enters: the real Coincident tool, the real trial and
// the real solve pump, on the reporter's own geometry.

import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => {} }));
import { liveSketch } from "./liveSketch.testkit";
import { ConstraintTools } from "./constraintTools";
import { rectCorners } from "./region";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Circle = Extract<ResolvedEntity, { type: "circle" }>;
type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;
type Line = Extract<ResolvedEntity, { type: "line" }>;

const R = 2.904828224079326;
/** The reporter's rectangle, its construction diagonal joined corner to corner,
 *  and the 2x2 grid of equal circles inside it, as the document held them
 *  before the four alignments (c89a43be) and the diagonal were added. */
function reporterSketch(shift = { x: 0, y: 0 }): { ents: ResolvedEntity[]; cons: SketchConstraint[] } {
  const rect: Rect = { type: "rectangle", id: "e247", x: -83.12044825076235, y: -185.18574732194784, width: 30, height: 40 };
  const [bl, , tr] = rectCorners(rect.x, rect.y, rect.width, rect.height);
  const c = (id: string, x: number, y: number): Circle => ({ type: "circle", id, x: x + shift.x, y: y + shift.y, radius: R });
  return {
    ents: [
      rect,
      c("e251", -92.08822971926188, -198.8674244581512),
      c("e252", -92.4202251445514, -173.63577213614832),
      c("e253", -75, -200),
      c("e254", -78.36575214062874, -177.28772181433294),
      { type: "point", id: "e255", x: -85.27655493724903, y: -201.16708864587585 },
      { type: "point", id: "e256", x: -85.27655493724903, y: -172.0593277493453 },
      { type: "line", id: "e258", x1: bl!.x, y1: bl!.y, x2: tr!.x, y2: tr!.y, construction: true },
    ],
    cons: [
      { id: "c248", line: "e247~0", type: "distance", value: 30 },
      { id: "c249", line: "e247~3", type: "distance", value: 40 },
      { a: "e251", b: "e252", type: "equalRadius" },
      { a: "e254", b: "e251", type: "equalRadius" },
      { a: "e253", b: "e251", type: "equalRadius" },
      { e1: "e255", e2: "e256", p1: 0, p2: 0, type: "p2pDistanceX", value: 0 },
      { e1: "e251", e2: "e252", p1: 0, p2: 0, type: "p2pDistanceX", value: 0 },
      { e1: "e253", e2: "e251", p1: 0, p2: 0, type: "p2pDistanceY", value: 0 },
      { e1: "e254", e2: "e252", p1: 0, p2: 0, type: "p2pDistanceY", value: 0 },
      { e1: "e254", e2: "e253", p1: 0, p2: 0, type: "p2pDistanceX", value: 0 },
      { e1: "e247", e2: "e258", p1: 0, p2: 0, type: "coincident" },
      { e1: "e247", e2: "e258", p1: 2, p2: 1, type: "coincident" },
    ],
  };
}

/** A live sketch whose constraint tools run the REAL trial: addTrialConstraint
 *  arms the mover bias and requestSolve runs the real pump. (The testkit's own
 *  host only records what a tool emits.) */
async function opened(shift?: { x: number; y: number }) {
  const { ents, cons } = reporterSketch(shift);
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
  // the document as it was opened: the alignments already solved
  live.s.requestSolve();
  await live.settle();
  return live;
}

const corners = (r: Rect) => rectCorners(r.x, r.y, r.width, r.height);
const rectShift = (a: Rect, b: Rect) => Math.max(...corners(a).map((q, k) => q.distanceTo(corners(b)[k]!)));
const offLine = (l: Line, p: { x: number; y: number }) => {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return Math.abs((p.x - l.x1) * dy - (p.y - l.y1) * dx) / Math.hypot(dx, dy);
};

describe("Coincident from an aligned circle to a line moves the circles, not the rectangle (d97616d8)", () => {
  for (const [name, shift] of [["the reporter's document", { x: 0, y: 0 }], ["the circles 1 mm further off the diagonal", { x: 0.8, y: -0.6 }]] as const) {
    it(`${name}: the circle lands on the diagonal and the rectangle does not move`, async () => {
      const live = await opened(shift);
      const before = live.ent("e247") as Rect;
      const c0 = live.ent("e251") as Circle;
      const diag0 = live.ent("e258") as Line;
      expect(offLine(diag0, c0), "CONTROL: the circle should start OFF the diagonal").toBeGreaterThan(0.05);

      live.s.setTool("coincident");
      live.click(c0.x, c0.y); // the circle's centre
      // the diagonal, well away from the circle and the corners
      live.click(diag0.x1 + 0.75 * (diag0.x2 - diag0.x1), diag0.y1 + 0.75 * (diag0.y2 - diag0.y1));
      await live.settle();

      const on = live.s.constraints.filter((c) => c.type === "pointOn");
      expect(on, "the tool did not put the centre on the diagonal").toEqual([{ type: "pointOn", e: "e251", p: 0, curve: "e258" }]);
      const after = live.ent("e247") as Rect;
      const c1 = live.ent("e251") as Circle;
      expect(offLine(live.ent("e258") as Line, c1), "the circle is not on the diagonal").toBeLessThan(1e-6);
      expect(rectShift(before, after), "the rectangle moved").toBeLessThan(1e-6);
      // the alignments still hold: the grid moved as one
      const [a, b, c, d] = ["e251", "e252", "e253", "e254"].map((id) => live.ent(id) as Circle);
      expect(Math.abs(a!.x - b!.x)).toBeLessThan(1e-6);
      expect(Math.abs(c!.y - a!.y)).toBeLessThan(1e-6);
      expect(Math.abs(d!.y - b!.y)).toBeLessThan(1e-6);
      expect(Math.abs(d!.x - c!.x)).toBeLessThan(1e-6);
    });
  }
});
