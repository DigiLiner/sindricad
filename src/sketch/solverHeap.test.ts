// planegcs runs in a fixed 16 MB wasm heap (5 MB of it stack) and diagnoses a
// system with DENSE matrices, constraints by free parameters, several copies at
// once. Handed a whole sketch as one system, memory grew with the SQUARE of the
// sketch and a 350-entity sketch of rectangles, circles and arcs (the GH #17
// scaling probe's "mix" family) aborted it on its first solve: Aborted(OOM).
// SketchMode then marked the solver dead for the rest of the session, so drags
// stopped solving until the app was restarted.
//
// Two things are pinned here: a sketch made of independent parts is solved part
// by part, so it fits, with the same answer as one system; and a part that
// really is too big costs that one solve, not the solver.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
// how many times the solver's wasm module is started: once at first use, and
// once more after every solve that aborted it (solver.ts drops that module)
const { wasm } = vi.hoisted(() => {
  const wasm = { starts: 0 };
  const instantiate = WebAssembly.instantiate;
  (WebAssembly as { instantiate: unknown }).instantiate = (...a: Parameters<typeof instantiate>) => {
    wasm.starts++;
    return instantiate(...a);
  };
  return { wasm };
});
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { compileAndSolve } from "./sketchSolve";
import { solveSketch, SolverOutOfMemory, type SolveInput, type SConstraint } from "./solver";
import { liveSketch } from "./liveSketch.testkit";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { t } from "../i18n";

type Line = Extract<ResolvedEntity, { type: "line" }>;
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });

/** The GH #17 probe's "mix" sketch (probe-page.js makeDoc): N curves, as
 *  closed rectangles with H/V on every side and width and height on every
 *  second one, every fourth slot a circle with a diameter plus an arc. */
function mixSketch(n: number) {
  const entities: ResolvedEntity[] = [];
  const constraints: SketchConstraint[] = [];
  const slots = Math.ceil(n / 4);
  const cols = Math.ceil(Math.sqrt(slots * 1.5));
  let made = 0, dim = 0;
  for (let k = 0; k < slots && made < n; k++) {
    const cx = (k % cols) * 15, cy = Math.floor(k / cols) * 10;
    if (k % 4 === 3) {
      entities.push({ type: "circle", id: `c${k}`, x: cx + 3, y: cy + 3, radius: 2.5 });
      constraints.push({ type: "diameter", id: `d${dim++}`, circle: `c${k}`, value: 5 });
      entities.push({ type: "arc", id: `a${k}`, x1: cx + 7, y1: cy + 1, x2: cx + 7, y2: cy + 5, mx: cx + 9, my: cy + 3 });
      made += 2;
      continue;
    }
    const p = [[cx, cy], [cx + 10, cy], [cx + 10, cy + 6], [cx, cy + 6]];
    const ids = [0, 1, 2, 3].map((s) => `l${k}_${s}`);
    ids.forEach((id, s) => entities.push(line(id, p[s]![0]!, p[s]![1]!, p[(s + 1) % 4]![0]!, p[(s + 1) % 4]![1]!)));
    made += 4;
    for (let s = 0; s < 4; s++) constraints.push({ type: "coincident", e1: ids[s]!, p1: 1, e2: ids[(s + 1) % 4]!, p2: 0 });
    constraints.push({ type: "horizontal", line: ids[0]! }, { type: "horizontal", line: ids[2]! });
    constraints.push({ type: "vertical", line: ids[1]! }, { type: "vertical", line: ids[3]! });
    if (k % 2 === 0) {
      constraints.push({ type: "distance", id: `d${dim++}`, line: ids[0]!, value: 12 });
      constraints.push({ type: "distance", id: `d${dim++}`, line: ids[1]!, value: 7 });
    }
  }
  return { entities, constraints };
}

/** One connected staircase of `n` lines, H and V alternating, each with a
 *  length: a single part far past what one planegcs heap can diagnose. */
function staircase(n: number, x0 = 0) {
  const entities: ResolvedEntity[] = [];
  const constraints: SketchConstraint[] = [];
  let x = x0, y = 0;
  for (let i = 0; i < n; i++) {
    const [nx, ny] = i % 2 ? [x, y + 1] : [x + 1, y];
    entities.push(line(`s${i}`, x, y, nx, ny));
    constraints.push({ type: i % 2 ? "vertical" : "horizontal", line: `s${i}` });
    constraints.push({ type: "distance", id: `sd${i}`, line: `s${i}`, value: 1.5 });
    if (i) constraints.push({ type: "coincident", e1: `s${i - 1}`, p1: 1, e2: `s${i}`, p2: 0 });
    [x, y] = [nx, ny];
  }
  return { entities, constraints };
}

const len = (e: ResolvedEntity | undefined) => {
  const l = e as Line;
  return Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
};

describe("a sketch too big for one planegcs heap", () => {
  it("solves the GH #17 probe's 350-entity mixed sketch that aborted the solver on its first solve", async () => {
    const { entities, constraints } = mixSketch(400);
    const r = await compileAndSolve(entities, constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    // the solve really ran: the dimensioned rectangle took its sizes, the
    // circle its diameter, and the far corner of the last rectangle too
    const at = (id: string) => r.entities.find((e) => e.id === id);
    expect(len(at("l0_0"))).toBeCloseTo(12, 9);
    expect(len(at("l0_1"))).toBeCloseTo(7, 9);
    expect((at("c3") as Extract<ResolvedEntity, { type: "circle" }>).radius).toBeCloseTo(2.5, 9);
    expect(len(at("l96_0"))).toBeCloseTo(12, 9);
  }, 60_000);

  it("gives the same answer part by part as in one system", async () => {
    // Independent rectangles that share only a FIXED point (an origin two of
    // them are pinned to), with circles tangent to them, a redundant dimension,
    // a conflicting one, a drag and a mover anchor among them: everything the
    // split has to keep. Every shape is fully determined (placed by coordinates,
    // the pin, the drag or the anchor), because where planegcs leaves an
    // UNDER-constrained shape depends on the state of its heap: the same input
    // solved twice as one system came back up to 0.86 mm apart.
    const points: SolveInput["points"] = [{ id: "o", x: 0, y: 0, fixed: true }];
    const lines: SolveInput["lines"] = [];
    const circles: SolveInput["circles"] = [];
    const constraints: SConstraint[] = [];
    for (let k = 0; k < 40; k++) {
      const cx = (k % 8) * 20 + 0.3 * (k % 3), cy = Math.floor(k / 8) * 15 - 0.2 * (k % 5);
      const q = [0, 1, 2, 3].map((s) => `p${k}_${s}`);
      [[cx, cy], [cx + 10.4, cy + 0.3], [cx + 10, cy + 6.2], [cx - 0.1, cy + 6]].forEach(([x, y], s) =>
        points.push({ id: q[s]!, x: x!, y: y! }));
      const l = [0, 1, 2, 3].map((s) => `l${k}_${s}`);
      l.forEach((id, s) => lines.push({ id, p1: q[s]!, p2: q[(s + 1) % 4]! }));
      constraints.push(
        { id: `h${k}a`, type: "horizontal", line: l[0]! },
        { id: `h${k}b`, type: "horizontal", line: l[2]! },
        { id: `v${k}a`, type: "vertical", line: l[1]! },
        { id: `v${k}b`, type: "vertical", line: l[3]! },
        { id: `w${k}`, type: "distance", a: q[0]!, b: q[1]!, value: 10 + (k % 4) },
        { id: `t${k}`, type: "distance", a: q[1]!, b: q[2]!, value: 5 + (k % 3) },
      );
      if (k > 1 && k !== 4 && k !== 5) constraints.push({ id: `x${k}`, type: "coordX", p: q[0]!, value: cx + 0.5 }, { id: `y${k}`, type: "coordY", p: q[0]!, value: cy - 0.5 });
      if (k % 3 === 0) {
        points.push({ id: `cc${k}`, x: cx + 5, y: cy + 3 });
        circles.push({ id: `c${k}`, center: `cc${k}`, radius: 1 + (k % 2) });
        constraints.push(
          { id: `cd${k}`, type: "diameter", circle: `c${k}`, value: 2.5 },
          { id: `ct${k}`, type: "tangentLC", line: l[0]!, circle: `c${k}` },
          { id: `cx${k}`, type: "coordX", p: `cc${k}`, value: cx + 4 },
        );
      }
    }
    constraints.push(
      { id: "pin0", type: "coincident", a: "p0_0", b: "o" },
      { id: "pin1", type: "coincident", a: "p1_3", b: "o" },
      { id: "again", type: "distance", a: "p2_1", b: "p2_0", value: 12 }, // redundant
      { id: "clash", type: "distance", a: "p3_0", b: "p3_1", value: 40 }, // conflicting
    );
    const input: SolveInput = {
      points, lines, circles, constraints,
      drag: { point: "p4_2", x: 75, y: 9 },
      anchors: [{ point: "p5_0", x: 100, y: 0 }],
    };
    const whole = await solveSketch(input, Infinity);
    expect(whole.conflicts.sort()).toEqual(["clash", "w3"]);
    expect(whole.redundant).toEqual(["again"]);
    // the default budget, and one so small that nearly every shape is its own system
    for (const budget of [undefined, 2_000]) {
      const parts = await solveSketch(input, budget);
      expect(parts.ok).toBe(whole.ok);
      expect(parts.dof, `dof at budget ${budget}`).toBe(whole.dof);
      for (const k of ["conflicts", "redundant", "partiallyRedundant"] as const)
        expect([...parts[k]].sort(), k).toEqual([...whole[k]].sort());
      expect(Object.keys(parts.points).sort()).toEqual(Object.keys(whole.points).sort());
      for (const [id, p] of Object.entries(whole.points)) {
        if (/^(p3_|cc3$)/.test(id)) continue; // the conflicting rectangle: an unconverged answer nothing uses
        expect(parts.points[id]!.x, id).toBeCloseTo(p.x, 9);
        expect(parts.points[id]!.y, id).toBeCloseTo(p.y, 9);
      }
      for (const [id, r] of Object.entries(whole.circles)) if (id !== "c3") expect(parts.circles[id], id).toBeCloseTo(r, 9);
    }
  }, 60_000);

  it("refuses one part that really is too big, and the next solve runs on a fresh heap", async () => {
    const big = staircase(500);
    await expect(compileAndSolve(big.entities, big.constraints)).rejects.toBeInstanceOf(SolverOutOfMemory);
    // planegcs carries on past an abort, on a heap the unwound C++ never gave
    // back: on the module that aborted, this 200-step staircase (4 MB of a
    // fresh heap) runs out too. Measured, and the reason the module is dropped.
    const next = staircase(200);
    const r = await compileAndSolve(next.entities, next.constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(len(r.entities.find((e) => e.id === "s199"))).toBeCloseTo(1.5, 9);
  }, 60_000);
});

describe("SketchMode after a solve runs out of heap", () => {
  beforeEach(() => { toasts.length = 0; });

  /** a small square-cornered rectangle next to a staircase too big for any heap */
  function besideTooBig() {
    const big = staircase(500, 100);
    const rect = [line("r0", 0, 0, 10, 0), line("r1", 10, 0, 10, 6), line("r2", 10, 6, 0, 6), line("r3", 0, 6, 0, 0)];
    const cons: SketchConstraint[] = [
      ...[0, 1, 2, 3].map((s): SketchConstraint => ({ type: "coincident", e1: `r${s}`, p1: 1, e2: `r${(s + 1) % 4}`, p2: 0 })),
      { type: "horizontal", line: "r0" }, { type: "horizontal", line: "r2" },
      { type: "vertical", line: "r1" }, { type: "vertical", line: "r3" },
      ...big.constraints,
    ];
    return liveSketch([...rect, ...big.entities], cons);
  }

  it("says so once and keeps solving what fits, instead of turning the solver off", async () => {
    const live = besideTooBig();
    live.s.requestSolve();
    await live.settle();
    expect(live.s.solverDead, "the solver was turned off").toBe(false);
    expect(toasts).toEqual([t("sketch.solver.tooLarge")]);

    // a corner drag solves the rectangle's own cluster, which fits: the
    // corner follows and the sides it carries stay square
    await live.drag([10, 6], [14, 9]);
    const r1 = live.ent("r1") as Line, r2 = live.ent("r2") as Line;
    expect(r1.x2).toBeCloseTo(14, 6);
    expect(r1.y2).toBeCloseTo(9, 6);
    expect(r1.x1).toBeCloseTo(r1.x2, 9); // still vertical
    expect(r2.y1).toBeCloseTo(r2.y2, 9); // still horizontal
    // the release solved the whole sketch again and ran out again: still one message
    expect(toasts).toEqual([t("sketch.solver.tooLarge")]);
    expect(live.s.solverDead).toBe(false);
  }, 120_000);

  it("tries a part too big to solve once per drag, not on every frame", async () => {
    // Each failed try costs the solve plus a fresh wasm module: measured 28 to
    // 68 ms a frame on this fixture, a module start every frame (two for a
    // body drag), for an answer that cannot come until the gesture ends.
    const live = besideTooBig();
    live.s.requestSolve();
    await live.settle();
    const frames = async (from: [number, number], to: [number, number], n: number) => {
      const after: number[] = [];
      live.press(from[0], from[1]);
      for (let i = 1; i <= n; i++) {
        live.move(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n);
        await live.settle();
        after.push(wasm.starts);
      }
      return after;
    };

    // a point drag on the staircase: its cluster IS the part too big
    let before = wasm.starts;
    let after = await frames([101, 0], [101, -3], 12);
    expect(after[11]! - before, "module starts over 12 point-drag frames").toBeLessThanOrEqual(1);
    live.release();
    await live.settle();
    expect(wasm.starts - after[11]!, "the release tries again").toBe(1);

    // a body drag of the rectangle's bottom side solves the whole sketch,
    // which holds the staircase: the frame the drag starts on tries (the
    // pinned pass, then the free retry beneath it), and no later frame does
    before = wasm.starts;
    after = await frames([5, 0], [5, -3], 12);
    const trying = after.filter((n, i) => n > (i ? after[i - 1]! : before)).length;
    expect(trying, `frames that started a module: ${JSON.stringify([before, ...after])}`).toBe(1);
    expect(after[11]! - before).toBeLessThanOrEqual(2);
    // the side still follows the cursor, unsolved
    const r0 = live.ent("r0") as Line;
    expect(r0.y1).toBeCloseTo(-3, 6);
    expect(r0.y2).toBeCloseTo(-3, 6);
    live.release();
    await live.settle();
    expect(wasm.starts, "the release tries again").toBeGreaterThan(after[11]!);

    expect(toasts).toEqual([t("sketch.solver.tooLarge")]);
    expect(live.s.solverDead).toBe(false);
  }, 120_000);
});
