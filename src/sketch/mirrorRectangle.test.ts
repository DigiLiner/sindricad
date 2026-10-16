// Mirror a rectangle across a slanted line. A rectangle is square to the sketch
// axes by definition (types.ts has no angle), and reflectEntity reflected only
// its centre and kept width and height: across a 30 degree line the copy came
// out axis-aligned, its corners up to 16 mm from the true mirror image, and at
// 45 degrees its width and height were not swapped. Its area was right every
// time, so an area check passes on the broken copy: these tests compare the
// corners.
//
// Everything goes in through the Mirror tool, the way the user does it: select
// the rectangle, pick Mirror, click the mirror line.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch } from "./liveSketch.testkit";
import { detectRegions, rectCorners } from "./region";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Rect = Extract<ResolvedEntity, { type: "rectangle" }>;

const R: Rect = { type: "rectangle", id: "R", x: 20, y: 10, width: 30, height: 20 };

/** an axis line from (60,0) at `deg` degrees, 40 long */
const axisAt = (deg: number): Line => {
  const r = (deg * Math.PI) / 180;
  return { type: "line", id: "M", x1: 60, y1: 0, x2: 60 + 40 * Math.cos(r), y2: 40 * Math.sin(r) };
};
const mid = (l: Line): [number, number] => [(l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2];

/** reflect p across the infinite line through m's ends (written out here, not
 *  borrowed from the code under test) */
const reflect = (m: Line, p: { x: number; y: number }) => {
  const r = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
  const ux = Math.cos(r), uy = Math.sin(r);
  const d = (p.x - m.x1) * ux + (p.y - m.y1) * uy;
  const fx = m.x1 + d * ux, fy = m.y1 + d * uy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
};

const shoelace = (pts: readonly THREE.Vector2[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** every point of `got` is within tol of one of `want`, and the other way round */
function sameSet(got: { x: number; y: number }[], want: { x: number; y: number }[], tol = 1e-9) {
  const near = (p: { x: number; y: number }, qs: { x: number; y: number }[]) =>
    Math.min(...qs.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
  for (const p of got) expect(near(p, want)).toBeLessThan(tol);
  for (const q of want) expect(near(q, got)).toBeLessThan(tol);
}

/** select R (by `selectAt` when given, the way the user clicks it), pick
 *  Mirror, click the axis */
async function mirror(axis: Line, selectAt?: [number, number]) {
  toasts.length = 0;
  const live = liveSketch([axis, { ...R }]);
  if (selectAt) {
    live.click(selectAt[0], selectAt[1]);
    expect(live.s.selected.size).toBe(1);
  } else live.s.selected.add("R");
  live.s.setTool("mirror");
  const before = new Set(live.s.entities.map((e) => e.id));
  live.click(...mid(axis));
  await live.settle();
  return { live, copies: live.s.entities.filter((e) => !before.has(e.id)) };
}

/** the angle at corner b between b->a and b->c, in degrees */
const angleAt = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
  const u = { x: a.x - b.x, y: a.y - b.y }, v = { x: c.x - b.x, y: c.y - b.y };
  return (Math.acos((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))) * 180) / Math.PI;
};

describe("Mirror a rectangle across a line", () => {
  it("across a 30 degree line, the copy is four lines on the reflected corners, held square", async () => {
    const M = axisAt(30);
    const { live, copies } = await mirror(M, [20, 20]); // the user clicks R's top side
    const want = rectCorners(R.x, R.y, R.width, R.height).map((p) => reflect(M, p));
    // (32.5,-47.63) (47.5,-21.65) (64.82,-31.65) (49.82,-57.63), a rectangle turned 60 degrees
    expect(copies.map((e) => e.type)).toEqual(["line", "line", "line", "line"]);
    const lines = copies as Line[];
    sameSet(lines.flatMap((l) => [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]), want);
    // a closed loop: each line starts where the one before it ends
    for (let k = 0; k < 4; k++) {
      const l = lines[k]!, n = lines[(k + 1) % 4]!;
      expect(Math.hypot(l.x2 - n.x1, l.y2 - n.y1)).toBeLessThan(1e-9);
    }
    // three Perpendicular holds on the copy's lines, nothing else
    const ids = new Set(lines.map((l) => l.id));
    expect(live.s.constraints).toHaveLength(3);
    for (const c of live.s.constraints) {
      expect(c.type).toBe("perpendicular");
      const p = c as { l1: string; l2: string };
      expect(ids.has(p.l1) && ids.has(p.l2)).toBe(true);
    }
    // the source is untouched
    expect(live.ent("R")).toEqual(R);
    // the solver sees one square loop with the corners joined: M 4 + R 4 + 5
    expect(live.s.overIdx.size).toBe(0);
    expect(live.s.lastDof).toBe(13);
    // a region of its own, the source's size, on the far side of the line
    const regions = detectRegions("s", live.s.entities);
    const dst = regions.find((r) => r.entityIds.length === 4 && r.entityIds.every((id) => ids.has(id)));
    const src = regions.find((r) => r.entityIds.length === 1 && r.entityIds[0] === "R");
    expect(dst, "the mirrored rectangle is a region").toBeDefined();
    expect(shoelace(dst!.loop)).toBeCloseTo(600, 6);
    const side = (p: { x: number; y: number }) => Math.sign((M.x2 - M.x1) * (p.y - M.y1) - (M.y2 - M.y1) * (p.x - M.x1));
    expect(side(dst!.interior)).not.toBe(0);
    expect(side(dst!.interior)).toBe(-side(src!.interior));
    // the user is told why it is lines now
    expect(toasts).toEqual([t("sketch.transform.mirrorRectangleToLines", { count: 1 })]);
  });

  it("one undo straight after the mirror takes the four lines and their holds away together", async () => {
    const { live } = await mirror(axisAt(30));
    expect(live.s.undoEdit()).toBe(true);
    await live.settle();
    expect(live.s.entities.filter((e) => !e.id.startsWith("__")).map((e) => e.id).sort()).toEqual(["M", "R"]);
    expect(live.s.constraints).toEqual([]);
  });

  it("the mirrored copy stays square when a corner is dragged", async () => {
    const { live, copies } = await mirror(axisAt(30));
    const ids = copies.map((e) => e.id);
    const first = copies[0] as Line;
    const from = { x: first.x1, y: first.y1 };
    live.s.setTool("select"); // Mirror stays armed after its click
    await live.drag([from.x, from.y], [from.x + 3, from.y - 2]);
    const lines = ids.map((id) => live.ent(id) as Line);
    // the solved corner moved
    expect(Math.hypot(lines[0]!.x1 - from.x, lines[0]!.y1 - from.y)).toBeGreaterThan(1);
    // still closed and still square
    for (let k = 0; k < 4; k++) {
      const l = lines[k]!, n = lines[(k + 1) % 4]!;
      expect(Math.hypot(l.x2 - n.x1, l.y2 - n.y1)).toBeLessThan(1e-9);
      expect(angleAt({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }, { x: n.x2, y: n.y2 })).toBeCloseTo(90, 6);
    }
    expect(live.s.overIdx.size).toBe(0);
    expect(live.s.lastDof).toBe(13);
    const regions = detectRegions("s", live.s.entities);
    expect(regions.some((r) => r.entityIds.length === 4 && r.entityIds.every((id) => ids.includes(id)))).toBe(true);
  });

  it("across a 45 degree line, the copy is one rectangle with width and height swapped", async () => {
    const M = axisAt(45);
    const { live, copies } = await mirror(M);
    expect(copies).toHaveLength(1);
    const c = copies[0] as Rect;
    expect(c.type).toBe("rectangle");
    expect(c.width).toBeCloseTo(20, 9);
    expect(c.height).toBeCloseTo(30, 9);
    expect(c.x).toBeCloseTo(70, 9);
    expect(c.y).toBeCloseTo(-40, 9);
    sameSet(rectCorners(c.x, c.y, c.width, c.height), rectCorners(R.x, R.y, R.width, R.height).map((p) => reflect(M, p)));
    expect(live.s.constraints).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("across a vertical line, the copy is the same rectangle as before this fix", async () => {
    const M: Line = { type: "line", id: "M", x1: 50, y1: 0, x2: 50, y2: 40 };
    const { live, copies } = await mirror(M);
    expect(copies).toHaveLength(1);
    const { id: _id, ...copy } = copies[0] as Rect;
    expect(copy).toEqual({ type: "rectangle", x: 80, y: 10, width: 30, height: 20 });
    expect(live.s.constraints).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("a construction rectangle mirrors as construction lines", async () => {
    toasts.length = 0;
    const M = axisAt(30);
    const live = liveSketch([M, { ...R, construction: true }]);
    live.s.selected.add("R");
    live.s.setTool("mirror");
    live.click(...mid(M));
    await live.settle();
    const copies = live.s.entities.filter((e) => e.type === "line" && e.id !== "M" && !e.id.startsWith("__"));
    expect(copies).toHaveLength(4);
    for (const c of copies) expect(c.construction).toBe(true);
  });
});
