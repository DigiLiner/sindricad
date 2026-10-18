// Mirror carries the constraints and dimensions inside the mirrored set, the
// rule Copy has had since 0.1.254 (6c0c9504): every one whose operands are all
// mirrored comes along, pointed at the copies, and one naming anything else
// (the mirror line, an entity left behind) stays behind. What a reflection
// changes has to change with it, or the copy is held to the ORIGINAL's
// handedness and the solver drags it out of shape:
//
//   - a signed angle reads the other way round (its value negates);
//   - a signed X or Y distance negates across a line square to it, swaps axes
//     across a 45 degree line, and means nothing across any other line;
//   - Horizontal and Vertical hold only across a line that keeps the axes;
//     across a slanted line they are carried as the relations they stated
//     between the mirrored lines (parallel, perpendicular);
//   - a shape whose corners and sides are numbered (rectangle, polygon, slot)
//     numbers them differently on its mirror image, so what names a corner or a
//     side is renumbered, and a side read the other way round turns an angle
//     on it by 180 degrees.
//
// Everything goes in through the Mirror tool, and the judge is the real
// planegcs solve: the copy has to settle exactly on the mirror image of its
// source, and hold its shape when one of its dimensions is edited, without
// the original moving.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch } from "./liveSketch.testkit";
import { signedAngleDeg } from "./geom2d";
import { lineOperand } from "./entityDims";
import { polygonPoints, rectCorners } from "./region";
import { noteConstraintId } from "./id";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type P = { x: number; y: number };

/** reflect p across the infinite line through m's ends (written out here, not
 *  borrowed from the code under test) */
const reflect = (m: Line, p: P): P => {
  const r = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
  const ux = Math.cos(r), uy = Math.sin(r);
  const d = (p.x - m.x1) * ux + (p.y - m.y1) * uy;
  const fx = m.x1 + d * ux, fy = m.y1 + d * uy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
};
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });
const axisAt = (deg: number, x0 = 60): Line => {
  const r = (deg * Math.PI) / 180;
  return line("M", x0, -20, x0 + 80 * Math.cos(r), -20 + 80 * Math.sin(r));
};
const mid = (l: Line): [number, number] => [(l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2];

/** The points an entity is drawn through, in its own order: what a mirror
 *  image is compared on (a line's ends, a circle's centre and a point on its
 *  rim, an arc's three points, every corner of a shape). */
function pointsOf(e: ResolvedEntity): P[] {
  switch (e.type) {
    case "line": return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    case "circle": return [{ x: e.x, y: e.y }];
    case "arc": return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.mx, y: e.my }];
    case "point": return [{ x: e.x, y: e.y }];
    case "rectangle": return rectCorners(e.x, e.y, e.width, e.height);
    case "polygon": return polygonPoints(e.x, e.y, e.radius, e.sides, (e.angle * Math.PI) / 180);
    case "slot": return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    default: return [];
  }
}
const sizeOf = (e: ResolvedEntity): number[] =>
  e.type === "circle" || e.type === "polygon" ? [e.radius] : e.type === "slot" ? [e.width] : [];

/** the copy of `src` among `copies`: its mirror image, point for point (a
 *  polygon's or rectangle's corners as a set: a mirror numbers them anew) */
function imageOf(m: Line, src: ResolvedEntity, copies: ResolvedEntity[], tol = 1e-6): ResolvedEntity | undefined {
  const want = pointsOf(src).map((p) => reflect(m, p));
  const asSet = src.type === "polygon" || src.type === "rectangle";
  return copies.find((c) => {
    if (c.type !== src.type) return false;
    const got = pointsOf(c);
    if (got.length !== want.length || sizeOf(c).some((v, i) => Math.abs(v - sizeOf(src)[i]!) > tol)) return false;
    if (asSet) return want.every((w) => got.some((g) => Math.hypot(g.x - w.x, g.y - w.y) < tol));
    return want.every((w, i) => Math.hypot(got[i]!.x - w.x, got[i]!.y - w.y) < tol);
  });
}

interface Mode {
  writeDimValue(c: SketchConstraint & { value: number }, v: number): void;
  conflict: boolean;
  redoEdit(): boolean;
}

/** select `ids`, pick Mirror, click the axis; the copies once the solve settled */
async function mirror(axis: Line, ents: ResolvedEntity[], cons: SketchConstraint[], ids: string[]) {
  for (const c of cons) if ("id" in c && c.id) noteConstraintId(c.id); // as opening the sketch does
  const live = liveSketch([axis, ...ents], structuredClone(cons));
  // settle the source first: the solver's write-back rounds the last digit
  // of a coordinate, and "the source did not move" is judged against that
  live.s.requestSolve();
  await live.settle();
  const before = { entities: structuredClone(live.s.entities), constraints: structuredClone(live.s.constraints) };
  for (const id of ids) live.s.selected.add(id);
  live.s.setTool("mirror");
  live.click(...mid(axis));
  await live.settle();
  const known = new Set(before.entities.map((e) => e.id));
  const copies = live.s.entities.filter((e) => !known.has(e.id));
  const added = live.s.constraints.slice(before.constraints.length);
  return { live, before, copies, added, mode: live.s as unknown as Mode };
}

/** the solve settled clean: nothing red, nothing amber */
const clean = (live: ReturnType<typeof liveSketch>, mode: Mode) => {
  expect(mode.conflict, "no conflict").toBe(false);
  expect([...live.s.overIdx], "nothing redundant").toEqual([]);
};

/** every coordinate to 1e-9: a re-solve may move the last digit */
const rounded = (es: ResolvedEntity[]) => JSON.parse(JSON.stringify(es, (_k, v: unknown) => (typeof v === "number" ? +v.toFixed(9) : v))) as unknown;
const len = (e: ResolvedEntity | undefined) => (e?.type === "line" ? Math.hypot(e.x2 - e.x1, e.y2 - e.y1) : NaN);

describe("Mirror across a line square to the axes", () => {
  // two lines turning a corner, a slanted line off it ending in a tangent arc,
  // a circle placed from the first line's start, and two points symmetric
  // about the vertical line. Every constraint already holds.
  const R2 = 5 * Math.SQRT2;
  const ENTS = (): ResolvedEntity[] => [
    line("a", 10, 10, 30, 10),
    line("b", 30, 10, 30, 25),
    line("c", 30, 25, 20, 35),
    { type: "circle", id: "k", x: 15, y: 20, radius: 3 },
    { type: "arc", id: "q", x1: 20, y1: 35, x2: 10, y2: 35, mx: 15, my: 30 + R2 },
    { type: "point", id: "p1", x: 26, y: 18 },
    { type: "point", id: "p2", x: 34, y: 18 },
  ];
  const BC = signedAngleDeg(ENTS()[1] as Line, ENTS()[2] as Line); // 45
  const CONS = (): SketchConstraint[] => [
    { type: "horizontal", line: "a" },
    { type: "vertical", line: "b" },
    { type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 },
    { type: "coincident", e1: "b", p1: 1, e2: "c", p2: 0 },
    { type: "coincident", e1: "c", p1: 1, e2: "q", p2: 0 },
    { type: "distance", id: "c1", line: "a", value: 20 },
    { type: "distance", id: "c2", line: "b", value: 15 },
    { type: "angle", id: "c3", l1: "b", l2: "c", value: BC, place: { ox: -3, oy: 2 } },
    { type: "radius", id: "c4", e: "k", value: 3 },
    { type: "p2pDistanceX", id: "c5", e1: "a", p1: 0, e2: "k", p2: 0, value: 5, place: { ox: 0, oy: -4 } },
    { type: "p2pDistanceY", id: "c6", e1: "a", p1: 0, e2: "k", p2: 0, value: 10 },
    { type: "tangent2", a: "c", b: "q" },
    { type: "radius", id: "c7", e: "q", value: R2 },
    { type: "symmetric", e1: "p1", p1: 0, e2: "p2", p2: 0, line: "b" },
    // ties the circle to the mirror line itself: stays behind
    { type: "p2lDistance", id: "c8", e: "k", p: 0, line: "M", value: 35 },
  ];
  const SEL = ["a", "b", "c", "k", "q", "p1", "p2"];
  const AXIS = line("M", 50, -10, 50, 60);

  it("brings every constraint inside the set, with the signed values read the mirrored way", async () => {
    const { added, copies } = await mirror(AXIS, ENTS(), CONS(), SEL);
    const to = (id: string) => imageOf(AXIS, ENTS().find((e) => e.id === id)!, copies)!.id;
    for (const id of SEL) expect(imageOf(AXIS, ENTS().find((e) => e.id === id)!, copies), `the copy of ${id} is its mirror image`).toBeDefined();
    const dims = added.flatMap((c) => ("id" in c && c.id ? [c.id] : []));
    expect(added).toEqual([
      { type: "horizontal", line: to("a") },
      { type: "vertical", line: to("b") },
      { type: "coincident", e1: to("a"), p1: 1, e2: to("b"), p2: 0 },
      { type: "coincident", e1: to("b"), p1: 1, e2: to("c"), p2: 0 },
      { type: "coincident", e1: to("c"), p1: 1, e2: to("q"), p2: 0 },
      { type: "distance", id: dims[0], line: to("a"), value: 20 },
      { type: "distance", id: dims[1], line: to("b"), value: 15 },
      // the angle reads the other way round, and its label sits on the mirrored side
      { type: "angle", id: dims[2], l1: to("b"), l2: to("c"), value: -BC, place: { ox: 3, oy: 2 } },
      { type: "radius", id: dims[3], e: to("k"), value: 3 },
      // across a vertical line an X distance turns round and a Y distance does not
      { type: "p2pDistanceX", id: dims[4], e1: to("a"), p1: 0, e2: to("k"), p2: 0, value: -5, place: { ox: 0, oy: -4 } },
      { type: "p2pDistanceY", id: dims[5], e1: to("a"), p1: 0, e2: to("k"), p2: 0, value: 10 },
      { type: "tangent2", a: to("c"), b: to("q") },
      { type: "radius", id: dims[6], e: to("q"), value: R2 },
      { type: "symmetric", e1: to("p1"), p1: 0, e2: to("p2"), p2: 0, line: to("b") },
    ]);
    for (const id of dims) expect(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]).not.toContain(id);
  });

  it("the copy settles on the exact mirror image, and holds its shape when a copied dimension is edited", async () => {
    const { live, before, copies, added, mode } = await mirror(AXIS, ENTS(), CONS(), SEL);
    clean(live, mode);
    // where the solve left the copies: still the mirror image of the sources
    for (const id of SEL) expect(imageOf(AXIS, ENTS().find((e) => e.id === id)!, live.s.entities.filter((e) => copies.some((c) => c.id === e.id)))).toBeDefined();
    const ids = new Map(SEL.map((id) => [id, imageOf(AXIS, ENTS().find((e) => e.id === id)!, copies)!.id]));
    // stretch the copy's first line from 20 to 26 through its own dimension
    const dist = added.find((c) => c.type === "distance" && c.line === ids.get("a")) as SketchConstraint & { value: number };
    mode.writeDimValue(dist, 26);
    await live.settle();
    clean(live, mode);
    const e = (id: string) => live.ent(ids.get(id)!) as Line;
    expect(len(e("a"))).toBeCloseTo(26, 6);
    expect(e("a").y1 - e("a").y2, "still horizontal").toBeCloseTo(0, 9);
    expect(e("b").x1 - e("b").x2, "still vertical").toBeCloseTo(0, 9);
    expect(len(e("b"))).toBeCloseTo(15, 6);
    expect(signedAngleDeg(e("b"), e("c")), "the mirrored angle").toBeCloseTo(-BC, 6);
    const k = live.ent(ids.get("k")!) as Extract<ResolvedEntity, { type: "circle" }>;
    expect(k.x - e("a").x1, "the X distance, mirrored").toBeCloseTo(-5, 6);
    expect(k.y - e("a").y1).toBeCloseTo(10, 6);
    // the original did not move
    for (const id of [...SEL, "M"]) expect(live.ent(id)).toEqual(before.entities.find((x) => x.id === id));
  });

  it("one Undo takes the copies and their constraints away together, and Redo brings both back", async () => {
    const { live, before, mode } = await mirror(AXIS, ENTS(), CONS(), SEL);
    const after = { entities: structuredClone(live.s.entities), constraints: structuredClone(live.s.constraints) };
    expect(after.constraints.length, "the mirror brought constraints").toBeGreaterThan(before.constraints.length);
    expect(live.s.undoEdit()).toBe(true);
    await live.settle();
    expect(rounded(live.s.entities)).toEqual(rounded(before.entities));
    expect(live.s.constraints).toEqual(before.constraints);
    mode.redoEdit();
    await live.settle();
    expect(rounded(live.s.entities)).toEqual(rounded(after.entities));
    expect(live.s.constraints).toEqual(after.constraints);
  });
});

describe("Mirror across a slanted line", () => {
  // a rectangle with its width and height locked, a line off its top-right
  // corner at a dimensioned angle to its bottom side, and an L of two lines
  // held Horizontal and Vertical
  const ENTS = (): ResolvedEntity[] => [
    { type: "rectangle", id: "R", x: 20, y: 10, width: 30, height: 20 },
    line("L", 35, 20, 45, 30),
    line("h", 0, 40, 10, 40),
    line("v", 0, 40, 0, 50),
  ];
  const CONS = (): SketchConstraint[] => [
    { type: "distance", id: "c1", line: "R~0", value: 30 },
    { type: "distance", id: "c2", line: "R~1", value: 20 },
    { type: "coincident", e1: "L", p1: 0, e2: "R", p2: 2 },
    { type: "angle", id: "c3", l1: "R~0", l2: "L", value: 45, place: { ox: 2, oy: 1 } },
    { type: "horizontal", line: "h" },
    { type: "vertical", line: "v" },
    { type: "coincident", e1: "h", p1: 0, e2: "v", p2: 0 },
    { type: "distance", id: "c4", line: "h", value: 10 },
    // an X distance means nothing once the copy is turned: stays behind
    { type: "p2pDistanceX", id: "c5", e1: "h", p1: 1, e2: "L", p2: 1, value: 35 },
  ];
  const AXIS = axisAt(30);

  it("the copy is held to the shape the source had, and settles on its mirror image", async () => {
    const { live, before, copies, added, mode } = await mirror(AXIS, ENTS(), CONS(), ["R", "L", "h", "v"]);
    clean(live, mode);
    // the rectangle came out as four lines on its reflected corners
    const want = rectCorners(20, 10, 30, 20).map((p) => reflect(AXIS, p));
    const sides = copies.filter((e) => e.type === "line" && pointsOf(e).every((p) => want.some((w) => Math.hypot(w.x - p.x, w.y - p.y) < 1e-6))) as Line[];
    expect(sides).toHaveLength(4);
    const Lc = imageOf(AXIS, ENTS()[1]!, copies) as Line, hc = imageOf(AXIS, ENTS()[2]!, copies) as Line, vc = imageOf(AXIS, ENTS()[3]!, copies) as Line;
    expect(Lc && hc && vc, "every line has its mirror image").toBeTruthy();
    // no X distance and no Horizontal or Vertical came along: they would hold
    // the copy to the source's axes
    expect(added.some((c) => c.type === "p2pDistanceX" || c.type === "p2pDistanceY" || c.type === "horizontal" || c.type === "vertical")).toBe(false);
    // the L's corner is still square, and the angle reads the other way round
    const side0 = sides.find((s) => Math.hypot(s.x1 - want[0]!.x, s.y1 - want[0]!.y) < 1e-6)!;
    const ang = added.find((c) => c.type === "angle") as Extract<SketchConstraint, { type: "angle" }>;
    expect(ang).toMatchObject({ l1: side0.id, l2: Lc.id, value: -45 });
    // edit the copy's angle: only the copy of L turns, the rest keeps its shape
    mode.writeDimValue(ang, 60);
    await live.settle();
    clean(live, mode);
    const by = new Map(live.s.entities.map((e) => [e.id, e]));
    const s0 = lineOperand(by, side0.id)!, l2 = lineOperand(by, Lc.id)!;
    expect(Math.abs(signedAngleDeg(s0, l2))).toBeCloseTo(60, 6);
    for (let k = 0; k < 4; k++) {
      const a = by.get(sides[k]!.id) as Line, b = by.get(sides[(k + 1) % 4]!.id) as Line;
      expect(Math.abs((a.x2 - a.x1) * (b.x2 - b.x1) + (a.y2 - a.y1) * (b.y2 - b.y1)), "square corners").toBeLessThan(1e-6);
    }
    const H = by.get(hc.id) as Line, V = by.get(vc.id) as Line, S0 = by.get(side0.id) as Line;
    expect(Math.abs((H.x2 - H.x1) * (V.x2 - V.x1) + (H.y2 - H.y1) * (V.y2 - V.y1)), "the L stays square").toBeLessThan(1e-6);
    expect(Math.abs((H.x2 - H.x1) * (S0.y2 - S0.y1) - (H.y2 - H.y1) * (S0.x2 - S0.x1)), "and parallel to the rectangle's bottom, as in the source").toBeLessThan(1e-6);
    expect(len(H)).toBeCloseTo(10, 6);
    expect(Math.hypot(S0.x2 - S0.x1, S0.y2 - S0.y1)).toBeCloseTo(30, 6);
    // the source did not move
    for (const e of ENTS()) expect(live.ent(e.id)).toEqual(before.entities.find((x) => x.id === e.id));
  });
});

describe("Mirror across a 45 degree line", () => {
  const ENTS = (): ResolvedEntity[] => [
    { type: "rectangle", id: "R", x: 20, y: 10, width: 30, height: 20 },
    { type: "point", id: "pt", x: 45, y: 0 },
    line("h", 0, 40, 10, 40),
  ];
  const CONS = (): SketchConstraint[] => [
    { type: "p2pDistanceX", id: "c1", e1: "R", p1: 1, e2: "pt", p2: 0, value: 10 },
    { type: "p2pDistanceY", id: "c2", e1: "R", p1: 1, e2: "pt", p2: 0, value: 0 },
    { type: "horizontal", line: "h" },
    { type: "p2pDistance", id: "c3", e1: "R", p1: 2, e2: "h", p2: 1, value: Math.hypot(35 - 10, 20 - 40) },
  ];
  const AXIS = line("M", 60, -20, 100, 20);

  it("a rectangle stays one, X distances become Y and Horizontal becomes Vertical, on the right corners", async () => {
    const { live, before, copies, added, mode } = await mirror(AXIS, ENTS(), CONS(), ["R", "pt", "h"]);
    clean(live, mode);
    const R2 = imageOf(AXIS, ENTS()[0]!, copies)!, P2 = imageOf(AXIS, ENTS()[1]!, copies)!, h2 = imageOf(AXIS, ENTS()[2]!, copies)!;
    expect(R2.type).toBe("rectangle");
    // corner 1 (bottom right) reflects to the copy's corner that sits there
    const want1 = reflect(AXIS, rectCorners(20, 10, 30, 20)[1]!), want2 = reflect(AXIS, rectCorners(20, 10, 30, 20)[2]!);
    const r = R2 as Extract<ResolvedEntity, { type: "rectangle" }>;
    const k1 = rectCorners(r.x, r.y, r.width, r.height).findIndex((p) => Math.hypot(p.x - want1.x, p.y - want1.y) < 1e-6);
    const k2 = rectCorners(r.x, r.y, r.width, r.height).findIndex((p) => Math.hypot(p.x - want2.x, p.y - want2.y) < 1e-6);
    expect(added.map((c) => ({ ...c, id: undefined }))).toEqual([
      { type: "p2pDistanceY", id: undefined, e1: R2.id, p1: k1, e2: P2.id, p2: 0, value: 10 },
      { type: "p2pDistanceX", id: undefined, e1: R2.id, p1: k1, e2: P2.id, p2: 0, value: 0 },
      { type: "vertical", line: h2.id },
      { type: "p2pDistance", id: undefined, e1: R2.id, p1: k2, e2: h2.id, p2: 1, value: Math.hypot(35 - 10, 20 - 40) },
    ]);
    for (const e of ENTS()) expect(live.ent(e.id)).toEqual(before.entities.find((x) => x.id === e.id));
  });
});

describe("Mirror renumbers the corners and sides of a polygon and a slot", () => {
  const ENTS = (): ResolvedEntity[] => [
    { type: "polygon", id: "P", x: 20, y: 20, radius: 10, sides: 6, angle: 10 },
    { type: "slot", id: "S", x1: 40, y1: 10, x2: 60, y2: 25, width: 6 },
  ];
  /** a line from polygon corner 1, a point on the slot's side 0, a line at an
   *  angle to the polygon's side 0 */
  const extra = () => {
    const [P, S] = ENTS() as [Extract<ResolvedEntity, { type: "polygon" }>, Extract<ResolvedEntity, { type: "slot" }>];
    const v = polygonPoints(P.x, P.y, P.radius, P.sides, (P.angle * Math.PI) / 180);
    const by = new Map<string, ResolvedEntity>([["P", P], ["S", S]]);
    const side0 = lineOperand(by, "S~0")!;
    const onSide = { x: (side0.x1 + side0.x2) / 2, y: (side0.y1 + side0.y2) / 2 };
    const ln = line("ln", v[1]!.x, v[1]!.y, v[1]!.x - 5, v[1]!.y + 12);
    const pside = lineOperand(by, "P~0")!;
    return {
      ents: [ln, { type: "point", id: "pt", x: onSide.x, y: onSide.y } as ResolvedEntity],
      cons: [
        { type: "coincident", e1: "ln", p1: 0, e2: "P", p2: 1 },
        { type: "pointOn", e: "pt", p: 0, curve: "S~0" },
        { type: "angle", id: "c1", l1: "P~0", l2: "ln", value: signedAngleDeg(pside, ln), place: { ox: 1, oy: 1 } },
        { type: "distance", id: "c2", line: "ln", value: 13 },
      ] as SketchConstraint[],
    };
  };
  it("across a horizontal line, the copy settles on the mirror image with every relation in place", async () => {
    const { ents, cons: kept } = extra();
    const AXIS = line("M", -20, -5, 100, -5);
    const { live, before, copies, added, mode } = await mirror(AXIS, [...ENTS(), ...ents], kept, ["P", "S", "ln", "pt"]);
    clean(live, mode);
    expect(added).toHaveLength(kept.length);
    const all = [...ENTS(), ...ents];
    for (const e of all) expect(imageOf(AXIS, e, live.s.entities.filter((x) => copies.some((c) => c.id === x.id))), `${e.id} settled on its mirror image`).toBeDefined();
    const P2 = imageOf(AXIS, all[0]!, copies) as Extract<ResolvedEntity, { type: "polygon" }>;
    const ln2 = imageOf(AXIS, all[2]!, copies) as Line;
    // the copy of corner 1 is corner 5 of the copy (a hexagon numbers its
    // mirror image the other way round), and the angle on side 0 (corner 0 to
    // 1) is on the copy's side 5 (corner 5 to 0), read from its other end
    expect(added[0]).toEqual({ type: "coincident", e1: ln2.id, p1: 0, e2: P2.id, p2: 5 });
    const ang = added[2] as Extract<SketchConstraint, { type: "angle" }>;
    expect(ang.l1).toBe(`${P2.id}~5`);
    const by = new Map(live.s.entities.map((e) => [e.id, e]));
    expect(signedAngleDeg(lineOperand(by, ang.l1)!, lineOperand(by, ang.l2)!), "the stored angle is the one the copy has").toBeCloseTo(ang.value, 9);
    // edit the copied line's length: it stays on the polygon's corner and at its angle
    mode.writeDimValue(added[3] as SketchConstraint & { value: number }, 20);
    await live.settle();
    clean(live, mode);
    const by2 = new Map(live.s.entities.map((e) => [e.id, e]));
    const l2 = by2.get(ln2.id) as Line;
    expect(len(l2)).toBeCloseTo(20, 6);
    expect(signedAngleDeg(lineOperand(by2, ang.l1)!, l2)).toBeCloseTo(ang.value, 6);
    for (const e of all) expect(live.ent(e.id)).toEqual(before.entities.find((x) => x.id === e.id));
  });
});
