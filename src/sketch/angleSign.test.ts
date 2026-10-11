// Field report (2026-10-10, beta 0.1.244): a sketch on XY has one line `b`
// from (10,10) to (36,25) — already at +30° to the X axis. Dimension tool:
// click `b`, then click the X origin axis. The prompt reads "Angle: type the
// included angle". Typing 30 + Enter stores
// {type:"angle", l1:"b", l2:"__originX__", value:30} and the solver FLIPS the
// line to -30° (rising became falling), although it already satisfied a
// 30-degree angle. Reported as "pretty broken" by a user asking about
// predictability.
//
// Root cause: the stored value WAS signedAngleDeg(l1, l2) (geom2d.ts) taken
// verbatim from whatever the user typed, discarding the sign the geometry
// already had. The fix: an angle dimension's number is a MAGNITUDE (the same
// rule `offset` already follows in document/numFields.ts) — typing or naming
// a parameter never changes which side of l2 the line sits on; only the live
// measurement (when the dimension is created) or the existing stored value
// (when it is edited) decides the sign.
//
// This test exercises the real path: resolveDim (the dimension tool's
// plan/commit code, exactly as sketchMode wires picks → plan.make(value))
// feeding the real planegcs solver (compileAndSolve), the same two steps a
// user's click-click-type-Enter drives.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { isDimError, resolveDim, type DimTarget } from "./dimensionTool";
import { compileAndSolve } from "./sketchSolve";
import { ORIGIN_X_ID } from "./origin";
import type { ResolvedEntity } from "./snap";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

describe("angle dimension to the X origin axis keeps the line's sign", () => {
  const b = line("b", 10, 10, 36, 25); // atan2(15, 26) ≈ +30.02°, "rising"
  const axisX = line(ORIGIN_X_ID, -10_000, 0, 10_000, 0);

  it("typing the already-satisfied included angle (30) must not flip the line", async () => {
    // exactly the dimension tool's pick→plan step: click b, then click the axis
    const picks: DimTarget[] = [{ kind: "entity", e: b }, { kind: "entity", e: axisX }];
    const res = resolveDim(picks);
    if (isDimError(res)) throw new Error(`expected a plan, got error "${res.error}"`);
    expect(res.kind).toBe("angle");

    // the box now shows a MAGNITUDE — what a user reading "my line is already
    // at 30° to the axis" expects — not the signed -30 the raw measurement
    // used to leak into the field.
    expect(res.measure()).toBeCloseTo(30, 0);

    // the user types "30" (the included angle they can see is already true)
    // and hits Enter: exactly resolveDim's plan.make(value). The STORED value
    // keeps the measurement's sign (-30): typing the magnitude shown moves
    // nothing.
    const constraint = res.make(30);
    expect(constraint).toEqual({ type: "angle", l1: "b", l2: ORIGIN_X_ID, value: -30, place: { ox: 0, oy: 0 } });

    const r = await compileAndSolve([axisX, b], [constraint]);
    expect(r.ok).toBe(true);
    const solvedB = r.entities.find((e) => e.id === "b");
    if (solvedB?.type !== "line") throw new Error("line lost");
    const deg = (Math.atan2(solvedB.y2 - solvedB.y1, solvedB.x2 - solvedB.x1) * 180) / Math.PI;

    // THE BUG: the line already satisfied a 30-degree angle to the axis, and
    // the user typed exactly that number — it must hold its orientation
    // (rising, +30°), not flip to falling (-30°).
    expect(deg).toBeCloseTo(30, 0);
  });

  it("typing a different magnitude (45) still keeps the line rising", async () => {
    const picks: DimTarget[] = [{ kind: "entity", e: b }, { kind: "entity", e: axisX }];
    const res = resolveDim(picks);
    if (isDimError(res)) throw new Error(`expected a plan, got error "${res.error}"`);
    const constraint = res.make(45);
    expect(constraint).toEqual({ type: "angle", l1: "b", l2: ORIGIN_X_ID, value: -45, place: { ox: 0, oy: 0 } });

    const r = await compileAndSolve([axisX, b], [constraint]);
    expect(r.ok).toBe(true);
    const solvedB = r.entities.find((e) => e.id === "b");
    if (solvedB?.type !== "line") throw new Error("line lost");
    const deg = (Math.atan2(solvedB.y2 - solvedB.y1, solvedB.x2 - solvedB.x1) * 180) / Math.PI;
    expect(deg).toBeCloseTo(45, 0);
  });

  it("picking the pair in the opposite order flips the stored sign, not the line", () => {
    // axis first, then b: the measured sign reverses, so the stored sign
    // reverses with it — the constraint still describes the SAME geometry.
    const picks: DimTarget[] = [{ kind: "entity", e: axisX }, { kind: "entity", e: b }];
    const res = resolveDim(picks);
    if (isDimError(res)) throw new Error(`expected a plan, got error "${res.error}"`);
    expect(res.measure()).toBeCloseTo(30, 0);
    const constraint = res.make(30);
    expect(constraint).toEqual({ type: "angle", l1: ORIGIN_X_ID, l2: "b", value: 30, place: { ox: 0, oy: 0 } });
  });
});
