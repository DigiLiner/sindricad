// Mirror inside a sketch (SketchMode.mirrorClick): the reflection itself, and
// what it does to the constraints and dimensions the mirrored copy carries.
//
// The copy carries every constraint whose operands are all mirrored (the rule
// Copy has, id.copiedConstraints), and a reflection reverses handedness, so a
// constraint that states a direction or a side has to be read the mirrored
// way, or the solver pulls the copy back into the source's handedness:
//
//   - a signed angle (planegcs l2l_angle, from l1's direction to l2's)
//     negates;
//   - a signed X or Y distance negates across a line square to it, becomes
//     the other axis's across a 45 degree line, and holds nothing true across
//     any other line, so it stays behind there;
//   - Horizontal and Vertical stay as they are, or swap, across those same
//     lines. Across any other line the copy is turned off the axes, and what
//     they said between the mirrored lines is carried instead: parallel or
//     perpendicular to the first of them, as a rectangle turned off the axes
//     is held square by Perpendicular. On two POINTS (pointsHorizontal,
//     pointsVertical) they stay or swap the same way; across any other line
//     there is no line to carry them by, and they stay behind, as an X or Y
//     distance does;
//   - a label offset is a vector, and is mirrored as one.
//
// The rest (lengths, radii, unsigned distances, coincidences, tangency,
// symmetry) is the same on a mirror image. Tangency and the rim distances
// read their branch off the geometry when they compile, and the mirrored
// geometry gives the mirrored branch. An offset's sign stays: for a closed
// shape it says outward, which a mirror keeps, and a line pair is solved by
// its unsigned distance with the side read off the geometry (sketchSolve).

import type { PlaceOffset, SketchConstraint } from "../types";
import { remapConstraint } from "./id";

type Pt = { x: number; y: number };

/** A reflection across the infinite line through two points. */
export interface Reflection {
  point(p: Pt): Pt;
  /** its linear part, for a vector (a label offset) */
  vec(v: Pt): Pt;
  /** the line's direction, degrees */
  deg: number;
  /** "keep": the sketch axes land on themselves (a horizontal or a vertical
   *  line), "swap": on each other (45 degrees), "turn": on neither */
  axes: "keep" | "swap" | "turn";
  /** across a "keep" line, the sign an X distance takes (-1 across a
   *  vertical line); a Y distance takes the other. Across a "swap" line, the
   *  sign either takes as it becomes the other axis's. */
  sign: 1 | -1;
}

/** What counts as square to the axes, as the sine or cosine of twice the
 *  line's angle: the tolerance a mirrored rectangle has always used. */
const AXIS_TOL = 1e-6;

export function reflection(a: Pt, b: Pt): Reflection {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // v -> 2 (v.u) u - v, written out rather than through cos/sin of the angle
  // so that a horizontal or vertical line mirrors coordinates exactly
  const vec = (v: Pt): Pt => {
    const d = 2 * (v.x * ux + v.y * uy);
    return { x: d * ux - v.x, y: d * uy - v.y };
  };
  // the matrix is [[c, s], [s, -c]], c and s the cosine and sine of twice
  // the line's angle
  const c = ux * ux - uy * uy, s = 2 * ux * uy;
  const axes = Math.abs(s) <= AXIS_TOL ? "keep" : Math.abs(c) <= AXIS_TOL ? "swap" : "turn";
  return {
    point: (p) => {
      const v = vec({ x: p.x - a.x, y: p.y - a.y });
      return { x: a.x + v.x, y: a.y + v.y };
    },
    vec,
    deg: (Math.atan2(dy, dx) * 180) / Math.PI,
    axes,
    sign: (axes === "swap" ? s : c) < 0 ? -1 : 1,
  };
}

/** How a mirrored shape numbers what its source numbered: the source's point
 *  `p` is the copy's `point(p)`, and its side k the copy's `side(k)`, read
 *  from the other end when `reversed(k)`. */
export interface Renumber {
  point(p: number): number;
  side(k: number): number;
  reversed(k: number): boolean;
}

/** A rectangle's or polygon's: corner k (0..n-1) is the copy's `corners[k]`,
 *  and anything else (a centre) keeps its number. A mirror image goes round
 *  the other way, so side k, corner k to k+1, is the copy's side from corner
 *  `corners[k+1]` to `corners[k]`, read backwards. */
export function cornerRenumber(corners: readonly number[]): Renumber {
  const n = corners.length;
  const point = (p: number) => (Number.isInteger(p) && p >= 0 && p < n ? corners[p]! : p);
  return { point, side: (k) => point((k + 1) % n), reversed: () => true };
}

/** A slot's: its centres keep their numbers, its axis (side 2) runs the same
 *  way, and its two sides (0 left of the axis, 1 right of it and back) trade
 *  places, each read the other way round. */
export const SLOT_RENUMBER: Renumber = {
  point: (p) => p,
  side: (k) => (k === 0 ? 1 : k === 1 ? 0 : k),
  reversed: (k) => k === 0 || k === 1,
};

const mirroredPlace = (r: Reflection, o: PlaceOffset): PlaceOffset => {
  const v = r.vec({ x: o.ox, y: o.oy });
  // no -0: the undo history's JSON round trip would read it back as 0, and
  // the redone state would then differ from the one undone
  return { ox: v.x || 0, oy: v.y || 0 };
};

const fold = (deg: number) => {
  let d = deg;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
};

/** The constraints of a mirrored copy, `cons` naming the copies already
 *  (id.copiedConstraints), read the mirrored way (see the header).
 *  `renumber` holds the copies whose points and sides a mirror renumbers.
 *  `level` names lines that were horizontal in the source with no constraint
 *  saying so (the bottom side of a rectangle that came out as lines): across
 *  a "turn" line they take part in the relations Horizontal and Vertical
 *  leave behind. `wraps` records, by dimension id, how the expression of a
 *  parameter binding has to change for a value read the other way round:
 *  an X or Y distance that negates is bound to minus it, and an angle whose
 *  side is read backwards to its supplement (a binding sets an angle's
 *  magnitude, numFields.dimValueFromParam, and the sign stays the copy's). */
export function mirroredConstraints(
  cons: readonly SketchConstraint[],
  r: Reflection,
  renumber: ReadonlyMap<string, Renumber>,
  level: readonly string[] = [],
  wraps?: Map<string, (expr: string) => string>,
): SketchConstraint[] {
  const split = (id: string) => {
    const k = id.indexOf("~");
    return k < 0 ? null : { base: id.slice(0, k), k: Number(id.slice(k + 1)) };
  };
  /** the copy's side for a side operand (`R~k`), and whether it reads backwards */
  const sideOf = (id: string) => {
    const s = split(id);
    const rn = s && renumber.get(s.base);
    if (!s || !rn || !Number.isInteger(s.k)) return { id, reversed: false };
    return { id: `${s.base}~${rn.side(s.k)}`, reversed: rn.reversed(s.k) };
  };
  const op = (id: string) => sideOf(id).id;
  const pt = (e: string, p: number) => {
    const s = split(e);
    if (s) {
      const side = sideOf(e);
      return { e: side.id, p: side.reversed ? 1 - p : p };
    }
    const rn = renumber.get(e);
    return { e, p: rn ? rn.point(p) : p };
  };

  const out: SketchConstraint[] = [];
  const axisHeld: { line: string; h: boolean }[] = [];
  for (const c0 of cons) {
    const c = remapConstraint(c0, op, pt);
    if ("place" in c && c.place) c.place = mirroredPlace(r, c.place);
    if (c.type === "horizontal" || c.type === "vertical") {
      if (r.axes === "turn") axisHeld.push({ line: c.line, h: c.type === "horizontal" });
      else if (r.axes === "swap") out.push({ type: c.type === "horizontal" ? "vertical" : "horizontal", line: c.line });
      else out.push(c);
      continue;
    }
    if (c.type === "p2pDistanceX" || c.type === "p2pDistanceY") {
      if (r.axes === "turn") continue;
      const x = c.type === "p2pDistanceX";
      const sign = r.axes === "swap" || x ? r.sign : -r.sign;
      if (sign < 0 && c.id) wraps?.set(c.id, (e) => `-(${e})`);
      if (r.axes === "swap") out.push({ ...c, type: x ? "p2pDistanceY" : "p2pDistanceX", value: sign * c.value });
      else out.push({ ...c, value: sign * c.value });
      continue;
    }
    if (c.type === "pointsHorizontal" || c.type === "pointsVertical") {
      if (r.axes === "turn") continue;
      if (r.axes === "swap") out.push({ ...c, type: c.type === "pointsHorizontal" ? "pointsVertical" : "pointsHorizontal" });
      else out.push(c);
      continue;
    }
    if (c0.type === "angle" && c.type === "angle") {
      // a side read backwards turns its direction, and so the angle, by 180
      const turned = Number(sideOf(c0.l1).reversed) + Number(sideOf(c0.l2).reversed);
      if (turned % 2 && c.id) wraps?.set(c.id, (e) => `180 - (${e})`);
      out.push({ ...c, value: fold(-c.value + (turned % 2 ? 180 : 0)) });
      continue;
    }
    out.push(c);
  }
  // across a "turn" line: what Horizontal and Vertical said between the lines
  const held = [...axisHeld, ...level.map((line) => ({ line, h: true }))];
  const ref = held[0];
  for (const m of held.slice(1)) {
    if (!ref || m.line === ref.line) continue;
    out.push({ type: m.h === ref.h ? "parallel" : "perpendicular", l1: ref.line, l2: m.line });
  }
  return out;
}
