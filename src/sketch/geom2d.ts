// Small 2D geometry helpers for the sketch modify tools (trim, fillet).

import * as THREE from "three";

type V = THREE.Vector2;
type Pt = { x: number; y: number }; // structural: THREE.Vector2 or a plain point
const v = (x: number, y: number) => new THREE.Vector2(x, y);

/** intersection of two INFINITE lines (through p1p2 and p3p4); null if parallel */
export function lineIntersect(p1: V, p2: V, p3: V, p4: V): V | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  return v(p1.x + d1x * t, p1.y + d1y * t);
}

/** intersection point of two SEGMENTS, or null if they don't cross */
export function segIntersect(p1: V, p2: V, p3: V, p4: V): V | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return v(p1.x + d1x * t, p1.y + d1y * t);
}

/** intersection points of segment p1p2 with the full circle (center c, radius r) */
export function segCircleIntersect(p1: V, p2: V, c: V, r: number): V[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const fx = p1.x - c.x, fy = p1.y - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0 || a < 1e-12) return [];
  const sq = Math.sqrt(disc);
  const out: V[] = [];
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t >= -1e-6 && t <= 1 + 1e-6) out.push(v(p1.x + dx * t, p1.y + dy * t));
  }
  return out;
}

/** How close a curve may come to a circle and still TOUCH it, in mm. A tangency
 *  the solver satisfied is exact only to its convergence: a solved belt sketch
 *  (two circles, two lines, four tangents) left the line-circle discriminant at
 *  -1.11e-10, so an exact `disc < 0` test called a real tangency a miss about
 *  half the time, and trim deleted the whole curve instead of cutting at the
 *  touch. Relative above 1 mm because the noise scales with the radius.
 *
 *  It is used two ways, and neither may merge two crossings a user can see. A
 *  curve that MISSES the circle by no more than this touches it. A curve that
 *  cuts it touches only when its two crossings sit within this of their
 *  midpoint, measured ALONG the cut. A radial band there would merge real
 *  crossings up to 2.8e-3*r apart (0.056 mm at r=20), and the chord between
 *  them could not be trimmed at all. */
export const touchTol = (r: number) => 1e-6 * Math.max(1, r);

/** intersection points of the INFINITE line through p1p2 with the circle
 *  (c, r). The unclamped twin of segCircleIntersect: a corner miter lands beyond
 *  the offset segment's ends more often than not, so clamping to [0,1] would
 *  discard exactly the join we're looking for. A line that touches the circle
 *  (touchTol) gives one point, the foot of the centre on the line. */
export function circleLineIntersect(p1: V, p2: V, c: V, r: number): V[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return [];
  // the foot of the centre on the line, and how far the centre sits from it
  const t = ((c.x - p1.x) * dx + (c.y - p1.y) * dy) / len2;
  const fx = p1.x + dx * t, fy = p1.y + dy * t;
  const d = Math.hypot(c.x - fx, c.y - fy);
  if (d > r + touchTol(r)) return [];
  // half the chord, along the line; zero for a line that just misses
  const half = d < r ? Math.sqrt(r * r - d * d) : 0;
  if (half <= touchTol(r)) return [v(fx, fy)];
  const h = half / Math.sqrt(len2);
  return [v(fx - dx * h, fy - dy * h), v(fx + dx * h, fy + dy * h)];
}

/** intersection points of the two full circles (c1,r1) and (c2,r2) — 0, 1 or 2.
 *  Concentric or non-touching circles give none. The arc-to-arc companion to
 *  lineIntersect (line-line) and segCircleIntersect (line-arc), used to miter a
 *  corner where two offset arcs meet. Circles that touch (touchTol), outside or
 *  inside, give ONE point: the contact on the line of centres. */
export function circleCircleIntersect(c1: V, r1: number, c2: V, r2: number): V[] {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  const tol = touchTol(Math.max(r1, r2));
  if (d < 1e-9 || d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0; // half the common chord; zero for a near miss
  const mx = c1.x + (a * dx) / d, my = c1.y + (a * dy) / d;
  if (h <= tol) return [v(mx, my)]; // tangent: one point
  const ox = (-dy * h) / d, oy = (dx * h) / d;
  return [v(mx + ox, my + oy), v(mx - ox, my - oy)];
}

const TAU = Math.PI * 2;
/** CCW angular distance from `from` to `to`, always in [0, TAU) */
const ccwDelta = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

/** A curve the trim/extend crossing search tests against, exact wherever the
 *  sketch has an exact form: a straight segment, or a circle. An arc is its
 *  circle plus the CCW sweep from `a0` (a full circle sweeps TAU). */
export type Curve2 =
  | { kind: "seg"; a: V; b: V }
  | { kind: "round"; c: V; r: number; a0: number; sweep: number };

/** What a crossing is searched ALONG: the infinite line through a and b, or a
 *  full circle. Where along it the caller wants them is the caller's business:
 *  trim wants the inside of its curve, extend the outside. */
export type Carrier2 = { kind: "line"; a: V; b: V } | { kind: "circle"; c: V; r: number };

/** Whether `p` — already known to sit on `c`'s carrier, its line or circle —
 *  is within `c`'s own bounds: a segment's ends, or an arc's sweep. Pulled out
 *  of curveCrossings so a genuine two-curve crossing (both sides bounded,
 *  curveCurveIntersect below) can reuse the exact same bound check Trim/Extend
 *  already trust, rather than a second copy of the angle-slack arithmetic. */
function inCurveExtent(c: Curve2, p: V): boolean {
  if (c.kind === "seg") {
    const t = paramOnSeg(c.a, c.b, p);
    return t >= -1e-6 && t <= 1 + 1e-6;
  }
  if (c.sweep >= TAU) return true;
  // the same touchTol along the rim, so a crossing AT an arc's end still counts
  const slack = touchTol(c.r) / Math.max(c.r, 1e-9);
  const at = ccwDelta(c.a0, Math.atan2(p.y - c.c.y, p.x - c.c.x));
  return at <= c.sweep + slack || at >= TAU - slack;
}

/** Where `other` crosses or touches the carrier `on`.
 *
 *  Analytic for every pair a sketch draws: line-line, line-circle and
 *  circle-circle. Trim and extend used to intersect against an arc's or
 *  circle's TESSELLATION (48 chords per arc, 64 per circle), which cost them
 *  twice: a trimmed line ended on a chord, 0.009 mm off an r=20 arc, and a
 *  tangent touch lies outside the chord polygon, so it was never found at all.
 *  A touch within touchTol counts as ONE crossing at the contact point.
 *  Crossings beyond `other`'s own extent (a segment's ends, an arc's sweep) are
 *  dropped. */
export function curveCrossings(on: Carrier2, other: Curve2): V[] {
  const pts =
    other.kind === "seg"
      ? on.kind === "line"
        ? (() => { const x = lineIntersect(on.a, on.b, other.a, other.b); return x ? [x] : []; })()
        : circleLineIntersect(other.a, other.b, on.c, on.r)
      : on.kind === "line"
        ? circleLineIntersect(on.a, on.b, other.c, other.r)
        : circleCircleIntersect(on.c, on.r, other.c, other.r);
  return pts.filter((p) => inCurveExtent(other, p));
}

const carrierOf = (c: Curve2): Carrier2 =>
  c.kind === "seg" ? { kind: "line", a: c.a, b: c.b } : { kind: "circle", c: c.c, r: c.r };

/** Where two bounded curves genuinely CROSS, each curve's own extent checked —
 *  unlike curveCrossings, which bounds only `other` (right for Trim/Extend,
 *  which always cuts one curve against another that keeps going). A snap
 *  target for two curves that cross without sharing a drawn endpoint
 *  (bfe23a4b): a coordinate neither curve names on its own, found rather than
 *  assumed, and never a selectable sketch point in its own right. */
export function curveCurveIntersect(a: Curve2, b: Curve2): V[] {
  return curveCrossings(carrierOf(a), b).filter((p) => inCurveExtent(a, p));
}

/** parameter t in [0,1] of the closest point on segment p1p2 to q */
export function paramOnSeg(p1: Pt, p2: Pt, q: Pt): number {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy || 1;
  return ((q.x - p1.x) * dx + (q.y - p1.y) * dy) / len2;
}

/** distance from point q to segment p1p2 */
export function distToSeg(p1: Pt, p2: Pt, q: Pt): number {
  const t = Math.max(0, Math.min(1, paramOnSeg(p1, p2, q)));
  return Math.hypot(q.x - (p1.x + (p2.x - p1.x) * t), q.y - (p1.y + (p2.y - p1.y) * t));
}

/** Signed included angle (degrees, in (-180,180]) from line l1's direction to
 *  line l2's. Matches planegcs's l2l_angle sense, so seeding an angle dimension
 *  with it is a solve no-op. Used for the driving angle seed and the driven readout. */
export function signedAngleDeg(
  l1: { x1: number; y1: number; x2: number; y2: number },
  l2: { x1: number; y1: number; x2: number; y2: number },
): number {
  const a = Math.atan2(l1.y2 - l1.y1, l1.x2 - l1.x1);
  const b = Math.atan2(l2.y2 - l2.y1, l2.x2 - l2.x1);
  let d = ((b - a) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/** Fold a degree value into [0,180): an undirected line's own direction and
 *  its reverse (a+180) read the same here, which is exactly the ambiguity
 *  angleQuadrant resolves. */
const foldTo180 = (deg: number) => (((deg % 180) + 180) % 180);

/** Which of the two readings — signedAngleDeg's own magnitude ("direct"), or
 *  its supplement, 180 minus it ("supplement") — a label at `labelPos` is
 *  asking for. A line has no on-screen direction: drawing the same visible
 *  segment the other way round reverses signedAngleDeg's sign and can swap
 *  which of the two numbers it reports (field report, X-angle-supplement:
 *  30 degrees against the X axis read as 150). But the two lines cut the
 *  plane around their crossing into four wedges that alternate "direct",
 *  "supplement", "direct", "supplement" — a split that depends only on where
 *  the lines ARE, never on which end of either one was clicked first. Fusion's
 *  rule: read off whichever wedge the label sits in. Parallel lines never
 *  reach this (dimensionTool routes them to a distance dim instead). */
export function angleQuadrant(
  l1: { x1: number; y1: number; x2: number; y2: number },
  l2: { x1: number; y1: number; x2: number; y2: number },
  labelPos: Pt,
): "direct" | "supplement" {
  const ix = lineIntersect(v(l1.x1, l1.y1), v(l1.x2, l1.y2), v(l2.x1, l2.y1), v(l2.x2, l2.y2));
  if (!ix) return "direct"; // parallel (shouldn't happen here): no wedge to pick
  const a = (Math.atan2(l1.y2 - l1.y1, l1.x2 - l1.x1) * 180) / Math.PI;
  const bearing = (Math.atan2(labelPos.y - ix.y, labelPos.x - ix.x) * 180) / Math.PI;
  const m = signedAngleDeg(l1, l2);
  const g = foldTo180(bearing - a); // the label's direction from l1, undirected
  // The wedge adjacent to l1 on l2's side has width |m|; its antipode (same
  // fold) reads the same. Which side of the [0,180) fold that lands on
  // flips with m's sign, because l2 itself sits at g=m (not -m) for m<0.
  return (m >= 0 ? g <= Math.abs(m) : g >= 180 - Math.abs(m)) ? "direct" : "supplement";
}

/** Mirror image of `p` across the infinite line through l1p1/l1p2. The angle
 *  badge's "Flip side" reuses this on one of its two operand lines to move
 *  the label into the ADJACENT wedge (never the opposite one, which reads the
 *  same) — so it reclassifies angleQuadrant without moving `c.value` or any
 *  geometry; only where the label sits changes. */
export function reflectAcrossLine(l: { x1: number; y1: number; x2: number; y2: number }, p: Pt): V {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return v(p.x, p.y);
  const tt = ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2;
  const footX = l.x1 + dx * tt, footY = l.y1 + dy * tt;
  return v(2 * footX - p.x, 2 * footY - p.y);
}
