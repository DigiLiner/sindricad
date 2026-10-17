// planegcs diagnoses a system with DENSE matrices, constraints by free
// parameters, several copies at once. In the published build's fixed 16 MB wasm
// heap (5 MB of it stack), a whole sketch handed over as one system grew with
// the SQUARE of the sketch, and a 350-entity sketch of rectangles, circles and
// arcs (the GH #17 scaling probe's "mix" family) aborted it on its first solve:
// Aborted(OOM). SketchMode then marked the solver dead for the rest of the
// session, so drags stopped solving until the app was restarted.
//
// Pinned here: a sketch made of independent parts is solved part by part, so it
// fits, with the same answer as one system; a part that really is too big costs
// that one solve, not the solver; and the vendored build's heap GROWS, so the
// staircase that is too big for a capped heap solves without the cap.
//
// The vendored heap grows to 128 MB, which no test here can afford to reach, so
// every test runs with growth refused past CAPPED_PAGES (the cap below): the
// REAL abort planegcs makes when a growth is refused, at a known limit.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
// Refuse wasm heap growth past `cap.pages` (64 KiB each), as the engine does at
// MAXIMUM_MEMORY: emscripten's growth then fails and the solve aborts.
const { cap } = vi.hoisted(() => {
  const cap = { pages: 300 };
  const grow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function (this: WebAssembly.Memory, delta: number) {
    if (this.buffer.byteLength / 65536 + delta > cap.pages) throw new RangeError("test heap cap");
    return grow.call(this, delta);
  };
  return { cap };
});
/** about 19 MB: the published 16 MB heap plus a little, so what was too big stays too big */
const CAPPED_PAGES = 300;
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
import { GcsWrapper } from "@salusoft89/planegcs";
import { liveSketch, solveClock } from "./liveSketch.testkit";
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
 *  length: at 500 a single part far past what a capped heap can diagnose. */
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
  beforeEach(() => { cap.pages = CAPPED_PAGES; });

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
    // back. Measured under this cap: a fresh module solves up to a 340-step
    // staircase (360 runs out), and the module that just aborted runs out on
    // 200. 320 is what only a fresh module can do: the reason it is dropped.
    const next = staircase(320);
    const r = await compileAndSolve(next.entities, next.constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(len(r.entities.find((e) => e.id === `s${next.entities.length - 1}`))).toBeCloseTo(1.5, 9);
  }, 60_000);

});

describe("SketchMode after a solve runs out of heap", () => {
  beforeEach(() => {
    toasts.length = 0;
    cap.pages = CAPPED_PAGES;
  });

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

    // A body drag solves only what the dragged side is joined to (GH #17), so
    // the module count no longer says whether a solve was tried: a failure on
    // a module that is already up starts nothing. Count the passes that ran
    // out instead; pump() logs each one.
    let outOfMemory = 0;
    const errors = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      if (a.some((x) => x instanceof SolverOutOfMemory)) outOfMemory++;
    });
    try {
      // the rectangle's bottom side: its part is the rectangle, which fits, so
      // every frame solves and nothing runs out
      await frames([5, 0], [5, -3], 12);
      expect(live.s.moveDrag, "a body drag").not.toBeNull();
      expect(outOfMemory, "drag frames that ran out").toBe(0);
      const r0 = live.ent("r0") as Line, r1 = live.ent("r1") as Line;
      expect(r0.y1).toBeCloseTo(-3, 6);
      expect(r0.y2).toBeCloseTo(-3, 6);
      expect(r1.x1).toBeCloseTo(r1.x2, 9); // solved: the side it carries stays vertical
      live.release();
      await live.settle();
      expect(outOfMemory, "the release solves the whole sketch, and tries the staircase").toBe(1);

      // a side of the staircase: its part IS the one too big. The frame the
      // drag starts on tries, no later frame does, and the release tries again
      outOfMemory = 0;
      const tries: number[] = [];
      // zoomed in far enough that the middle of a 1 mm step is not a vertex
      (live.s as unknown as { pickTol: () => number }).pickTol = () => 0.2;
      live.press(100.5, 0);
      expect(live.s.moveDrag, "a body drag").not.toBeNull();
      for (let i = 1; i <= 12; i++) {
        live.move(100.5, -i / 4);
        await live.settle();
        tries.push(outOfMemory);
      }
      expect(tries.filter((n, i) => n > (i ? tries[i - 1]! : 0)).length, `frames that ran out: ${JSON.stringify(tries)}`).toBe(1);
      // the side still follows the cursor, unsolved
      const s0 = live.ent("s0") as Line;
      expect(s0.y1).toBeCloseTo(-3, 6);
      expect(s0.y2).toBeCloseTo(-3, 6);
      live.release();
      await live.settle();
      expect(outOfMemory - tries[11]!, "the release tries again").toBe(1);
    } finally {
      errors.mockRestore();
    }

    expect(toasts).toEqual([t("sketch.solver.tooLarge")]);
    expect(live.s.solverDead).toBe(false);
  }, 120_000);

  /** a rectangle 6 high and, apart from it, a 20-line staircase */
  function rectAndStairs() {
    const big = staircase(20, 100);
    const rect = [line("r0", 0, 0, 10, 0), line("r1", 10, 0, 10, 6), line("r2", 10, 6, 0, 6), line("r3", 0, 6, 0, 0)];
    return liveSketch([...rect, ...big.entities], [
      ...[0, 1, 2, 3].map((s): SketchConstraint => ({ type: "coincident", e1: `r${s}`, p1: 1, e2: `r${(s + 1) % 4}`, p2: 0 })),
      { type: "horizontal", line: "r0" }, { type: "vertical", line: "r1" },
      { type: "horizontal", line: "r2" }, { type: "vertical", line: "r3" },
      { type: "distance", id: "rh", line: "r1", value: 6 },
      ...big.constraints,
    ]);
  }

  /** Walk a drag from `from` to `to` in `n` settled frames; how many solved */
  async function solvedFrames(live: ReturnType<typeof liveSketch>, from: [number, number], to: [number, number], n: number) {
    const solves = vi.spyOn(GcsWrapper.prototype, "solve");
    let frames = 0;
    try {
      live.press(from[0], from[1]);
      for (let i = 1; i <= n; i++) {
        const before = solves.mock.calls.length;
        live.move(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n);
        await live.settle();
        if (solves.mock.calls.length > before) frames++;
      }
    } finally {
      solves.mockRestore();
    }
    return frames;
  }

  // Every solve made to LOOK slow (solveClock), so none of this depends on the
  // machine: the budget is what is under test, not planegcs's speed.
  it("stops solving a slow part live for the rest of a point drag, and solves it on release", async () => {
    const live = rectAndStairs();
    live.s.requestSolve();
    await live.settle();
    // (the first solve gave the steps their 1.5 mm and put the free
    // staircase wherever planegcs left it: drag from where it is)
    const start = live.ent("s0") as Line, end = live.ent("s19") as Line;
    const [x, y, endY] = [start.x1, start.y1, end.y2];
    const cost = { ms: 1000 };
    const restore = solveClock(cost);
    try {
      // the first solved frame pays the warm-up and is not held to the
      // budget; the second is, takes too long, and no later frame solves
      expect(await solvedFrames(live, [x, y], [x, y - 4], 8), "frames solved").toBe(2);
      live.release();
      await live.settle();
    } finally {
      restore();
    }
    // the release solved to where the button came up: every step is H or V
    // with a fixed length, so the whole staircase moved down 4
    const s0 = live.ent("s0") as Line, last = live.ent("s19") as Line;
    expect(s0.x1).toBeCloseTo(x, 6);
    expect(s0.y1).toBeCloseTo(y - 4, 6);
    expect(last.y2 - last.y1).toBeCloseTo(1.5, 6);
    expect(last.y2).toBeCloseTo(endY - 4, 6);
    expect(toasts, "slowness says nothing").toEqual([]);
  }, 120_000);

  it("releases a body drag whose frames stopped solving where the button came up, solved", async () => {
    const live = rectAndStairs();
    live.s.requestSolve();
    await live.settle();
    const restore = solveClock({ ms: 1000 });
    try {
      // the rectangle's bottom side, dragged down 4: its frames stop solving
      // after the second, so the sides it carries are left behind live...
      expect(await solvedFrames(live, [5, 0], [5, -4], 8), "frames solved").toBe(2);
      expect(live.s.moveDrag, "a body drag").not.toBeNull();
      live.release();
      await live.settle();
    } finally {
      restore();
    }
    // ...and the release solves with the side held where the cursor left it,
    // so the 6 mm height brings the top down after it. Solved without the
    // hold, the release split the difference: each side about 2 mm off.
    const r0 = live.ent("r0") as Line, r1 = live.ent("r1") as Line, r2 = live.ent("r2") as Line;
    expect(r0.y1).toBeCloseTo(-4, 6);
    expect(r0.y2).toBeCloseTo(-4, 6);
    expect(r2.y1).toBeCloseTo(2, 6);
    expect(r2.y2).toBeCloseTo(2, 6);
    expect(r1.x1).toBeCloseTo(r1.x2, 9); // still square
  }, 120_000);

  it("lands a slow point drag on its own shapes, even when the whole sketch is too big to settle", async () => {
    // The rectangle beside the 500-line staircase, every solve made to look a
    // second long: its corner drag stops solving live after the second frame.
    // The release lands the newest move on the rectangle first, as a frame
    // would have; the whole-sketch settle after it runs out of heap, and used
    // to be the only solve the release had, so the corner stayed behind.
    const live = besideTooBig();
    live.s.requestSolve();
    await live.settle();
    const restore = solveClock({ ms: 1000 });
    try {
      await live.drag([10, 6], [14, 9]);
    } finally {
      restore();
    }
    const r1 = live.ent("r1") as Line, r2 = live.ent("r2") as Line;
    expect(r1.x2).toBeCloseTo(14, 6);
    expect(r1.y2).toBeCloseTo(9, 6);
    expect(r1.x1).toBeCloseTo(r1.x2, 9);
    expect(r2.y1).toBeCloseTo(r2.y2, 9);
    expect(live.s.solverDead).toBe(false);
  }, 120_000);

  it("keeps solving live when only the first frame is slow (a cold start)", async () => {
    const live = rectAndStairs();
    live.s.requestSolve();
    await live.settle();
    // the drag's first solve looks a second long, every one after it instant:
    // a cold JIT or a module start on a slow machine, not a slow part
    const cost = { ms: 1000 };
    const restore = solveClock(cost);
    const timed = GcsWrapper.prototype.solve;
    GcsWrapper.prototype.solve = function (this: GcsWrapper, ...a: Parameters<typeof timed>) {
      const r = timed.apply(this, a);
      cost.ms = 0;
      return r;
    };
    try {
      expect(await solvedFrames(live, [10, 6], [14, 10], 8), "rectangle frames solved").toBe(8);
      live.release();
      await live.settle();
    } finally {
      restore();
    }
    expect((live.ent("r1") as Line).x2).toBeCloseTo(14, 6);
  }, 120_000);
});

// LAST in the file on purpose: a wasm heap never shrinks, so after this the
// module holds enough memory that no capped test after it could run out.
describe("the vendored heap grows", () => {
  it("solves the staircase that is too big for a capped heap", async () => {
    cap.pages = 2048; // the vendored MAXIMUM_MEMORY, 128 MB
    const big = staircase(500);
    const r = await compileAndSolve(big.entities, big.constraints);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(len(r.entities.find((e) => e.id === "s499"))).toBeCloseTo(1.5, 9);
  }, 60_000);
});
