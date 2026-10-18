// The 9 constraint-tool click flows (horizontal/vertical/parallel/perpendicular/
// equal/tangent/coincident/concentric/symmetric): each adds a persistent geometric
// constraint that the solver maintains alongside every other constraint already on
// the sketch. Operates purely through the ConstraintHost accessor SketchMode
// provides — no state is copied, so this collaborator always sees SketchMode's
// live entities/constraints.

import { t } from "../i18n";
import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { coincKey } from "./sketchSolve";
import { POLYGON_CENTRE, RECT_CENTRE, asRound, curveKind, dimRefPoints, lineOperand, lineOperandAt, refPoint, refPointNear, slotAxisAt } from "./entityDims";
import { distToSeg } from "./geom2d";
import { isOriginGeometry } from "./origin";
import { splineEndIndices } from "./spline";
import type { SketchTool } from "./sketchMode";

export const CONSTRAINT_TOOLS = new Set<SketchTool>([
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "coincident",
  "concentric",
  "symmetric",
  "midpoint",
  "collinear",
  "fix",
]);

/** What a click landed on, expressed as a constraint OPERAND rather than as an
 *  entity. The two differ for the shapes: a rectangle presents four line
 *  operands (`<rectId>~<k>`), a polygon one per side and a slot its two sides
 *  and its axis, and none of them an operand of its own, so an entity id is
 *  not enough to say what was clicked. */
interface Operand {
  /** the id to put in the constraint — a rect EDGE, not the rectangle */
  id: string;
  /** "spline" only where a flow asks for one (pickOperand's `splines`): Tangent */
  kind: "line" | "circle" | "arc" | "spline";
  /** the entity it came from: needed for the projected-is-fixed message, and to
   *  tell "another edge of the same rectangle" from "the same operand twice" */
  ent: ResolvedEntity;
  /** index into the live entity list, for the host's first-pick highlight */
  index: number;
}

const isRoundOp = (o: Operand) => o.kind === "circle" || o.kind === "arc";

/** The two operand keys a plain two-operand relation constraint names, sorted
 *  so the pair reads the same whichever order it was clicked in; null for
 *  every other constraint type (holds, splines — those are not what
 *  f3cb1331/X-double-tangent are about).
 *
 *  p2pDistanceX/p2pDistanceY key on the POINT (`e#p`), not the entity, since
 *  that is what Horizontal/Vertical's two-point pick names (ed07f912) — a
 *  repeat click on the same pair of points must refuse the same way a repeat
 *  Parallel does, rather than stacking a second zero-value constraint on top
 *  of the first. */
function relationPair(c: SketchConstraint): [string, string] | null {
  switch (c.type) {
    case "parallel": case "perpendicular": case "collinear": case "equal":
      return [c.l1, c.l2].sort() as [string, string];
    case "equalRadius": case "tangent2":
      return [c.a, c.b].sort() as [string, string];
    case "concentric":
      return [c.c1, c.c2].sort() as [string, string];
    case "p2pDistanceX": case "p2pDistanceY":
      return [`${c.e1}#${c.p1}`, `${c.e2}#${c.p2}`].sort() as [string, string];
    default:
      return null;
  }
}

/** Whether `constraints` already holds a constraint of the SAME relation
 *  between the same two operands as `c` (either pick order) — parallel,
 *  perpendicular, collinear, equal, equalRadius, tangent2, concentric and
 *  p2pDistanceX/Y all mean the same thing a second time, so a repeat click
 *  (or a second route to the same pair) should add nothing rather than an
 *  identical, redundant constraint. Shared by every site that can create one
 *  of these: a tool click, the right-click menu, and the tangent/
 *  perpendicular a line or arc infers while being drawn (GH f3cb1331,
 *  X-double-tangent, ed07f912). */
export function alreadyRelates(constraints: readonly SketchConstraint[], c: SketchConstraint): boolean {
  const pair = relationPair(c);
  if (!pair) return false;
  return constraints.some((k) => {
    if (k.type !== c.type) return false;
    const kp = relationPair(k);
    return !!kp && kp[0] === pair[0] && kp[1] === pair[1];
  });
}

/** Whether two constraints are literally the SAME one — same type, same
 *  operands, same value — order-independent for `coincident` (a point-pair,
 *  like the relations above). Used only to dedupe the `hold` a tangency
 *  brings along (cdd04fd1): a line's own end already pinned to the other
 *  curve by an earlier pick (Trim's keep-tangency, autoConstrain-while-
 *  drawing, an earlier tangent click on the same joint) must not get a
 *  second, identical pointOn/coincident stacked on top of the first — two
 *  identical constraints solve the same as one, but only one of them is ever
 *  reachable to delete. */
function constraintEquals(a: SketchConstraint, b: SketchConstraint): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "coincident" && b.type === "coincident") {
    return (a.e1 === b.e1 && a.p1 === b.p1 && a.e2 === b.e2 && a.p2 === b.p2)
      || (a.e1 === b.e2 && a.p1 === b.p2 && a.e2 === b.e1 && a.p2 === b.p1);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `holds` with anything `constraints` already has stripped out — the same
 *  "don't add it twice" protection `alreadyRelates` gives the constraint
 *  itself, extended to the pointOn/coincident hold riding along with a
 *  tangency (GH f3cb1331, X-double-tangent): a second tangent click onto a
 *  joint Trim's keep-tangency or autoConstrain-while-drawing already pinned
 *  used to add a second, identical hold on top of the first. Returns
 *  `undefined` rather than `[]` once everything is filtered out, matching
 *  the "no holds" shape the rest of this file already uses. */
export function dedupeHolds(
  constraints: readonly SketchConstraint[],
  holds: readonly SketchConstraint[] | undefined,
): SketchConstraint[] | undefined {
  if (!holds || !holds.length) return undefined;
  const kept = holds.filter((h) => !constraints.some((k) => constraintEquals(k, h)));
  return kept.length ? kept : undefined;
}

/** the ENTITY an operand id belongs to — `R~2` belongs to the rectangle `R` */
const baseOf = (id: string) => { const t = id.indexOf("~"); return t < 0 ? id : id.slice(0, t); };

/** Whether point `p` of `e` (dimRefPoints numbering) is one the solver MERGES
 *  with whatever else sits at its position: an end, a corner, a sketch point.
 *  A centre is not: it keeps a solver point of its own (sketchSolve.getPoint),
 *  and that includes a rectangle's, a polygon's and both of a slot's. */
const merges = (e: ResolvedEntity | undefined, p: number): boolean => {
  if (!e || e.type === "circle" || e.type === "slot") return false;
  if (e.type === "arc") return p !== 2;
  if (e.type === "rectangle") return p !== RECT_CENTRE;
  if (e.type === "polygon") return p !== POLYGON_CENTRE;
  if (e.type === "projected") return e.curve.kind !== "circle" && !(e.curve.kind === "arc" && p === 2);
  return true;
};

/** The slice of SketchMode these click flows read/write — live accessors, not copies. */
export interface ConstraintHost {
  /** current active sketch tool (drives which constraint flow fires) */
  tool(): SketchTool;
  /** live entity list — never copied */
  entities(): ResolvedEntity[];
  /** live constraint list — never copied; constraint flows push onto it */
  constraints(): SketchConstraint[];
  /** pick tolerance in plane units, scaled to current zoom */
  pickTol(): number;
  /** shared "first pick" slot for two-step line/entity flows — also used by
   *  SketchMode's own fillet tool (filletClick/modifyHover); reset to null on
   *  every setTool() */
  getFilletFirst(): number | null;
  setFilletFirst(idx: number | null): void;
  /** kick the solve pump after a constraint changes */
  requestSolve(): void;
  /** surface a user-facing warning (SketchMode routes it to the toast layer —
   *  kept an accessor so these flows stay DOM-free/unit-testable) */
  warn(msg: string): void;
  /** Show (or clear) the endpoints this flow is holding, so the user can see
   *  that a pick landed. Coincident's first click used to leave NO trace at all
   *  — the tool looked broken until the second click happened to work.
   *
   *  A LIST, because symmetric holds two points before it asks for its axis and
   *  a single marker could only ever show one of them: its middle click landed
   *  with no feedback whatsoever. Pass [] to clear. */
  setPendingPoints(ps: { x: number; y: number }[]): void;
  /** Push a constraint and solve. The host REMOVES it again if that solve turns
   *  out to conflict: an unsatisfiable constraint left sitting in the sketch
   *  poisons every later one, because the whole system stops solving and nothing
   *  moves. Reported in the app 2026-08-15 — after one bad Collinear, a perfectly
   *  good Parallel on other lines also appeared to do nothing.
   *
   *  `moves` names the ENTITY that solve should move — the first-picked operand
   *  of a two-pick flow (bug #86; see DimPlan.moves for why the geometry cannot
   *  answer this on its own). A one-pick flow has no second operand to hold
   *  still and passes nothing.
   *
   *  `holds` are constraints `c` needs to mean what it says (a spline
   *  tangency's On, splineTangentFor): pushed with it, in the one undo step,
   *  and withdrawn with it if that solve conflicts. */
  addConstraint(c: SketchConstraint, moves?: string, holds?: readonly SketchConstraint[]): void;
}


/** What each tool needs under the cursor. Used only for the "nothing here"
 *  message, so a miss names the target instead of looking like a dead tool.
 *  A rectangle EDGE is a line to every one of these, and a rectangle CORNER is
 *  an endpoint — say so, because a user who has just been told "needs a line"
 *  after clicking a rectangle side has been told the wrong thing. */
const WANTS: Partial<Record<SketchTool, string>> = {
  horizontal: "sketch.constraint.wants.horizontal",
  vertical: "sketch.constraint.wants.vertical",
  parallel: "sketch.constraint.wants.parallel",
  perpendicular: "sketch.constraint.wants.perpendicular",
  collinear: "sketch.constraint.wants.collinear",
  equal: "sketch.constraint.wants.equal",
  tangent: "sketch.constraint.wants.tangent",
  concentric: "sketch.constraint.wants.concentric",
  coincident: "sketch.constraint.wants.coincident",
  midpoint: "sketch.constraint.wants.midpoint",
  symmetric: "sketch.constraint.wants.symmetric",
  fix: "sketch.constraint.wants.fix",
};

/** A nullable plane point as the list `setPendingPoints` takes — a point the
 *  flow could not resolve shows nothing rather than a marker at the origin. */
const pts = (...ps: ({ x: number; y: number } | null)[]): { x: number; y: number }[] =>
  ps.filter((q): q is { x: number; y: number } => q !== null);



/** One pick a spline tangency is made from: the operand id the constraint
 *  names, the entity it belongs to, and where it was clicked. */
export interface TangentPick {
  id: string;
  ent: ResolvedEntity;
  at: { x: number; y: number };
}

/** How far a spline's end may sit from the curve it meets and still be a
 *  JOINT a tangency can be made at: a micron, so an end snapped there or
 *  joined by Coincident always is one, and an end left loose beside the curve
 *  is not. Being this close is not the same as being HELD there (the solver
 *  merges by coincKey's rounded position, and only the curve's own ends), so
 *  splineTangentFor adds the hold whenever the end is not one point with the
 *  curve's. */
const JOINT_TOL = 1e-3;

type XY = { x: number; y: number };

/** A curve operand's geometry for joint-finding: how far a point sits off it
 *  (0 when ON it), and its own addressable ends (empty for a circle, or for a
 *  slot's side — a slot's ends are not mergeable there, sketchSolve). Shared
 *  by splineTangentFor and lineArcEndJoint below: both ask the same two
 *  questions of the curve a tangency is being made to — "does this point sit
 *  on it" and "is it already one of the curve's own ends". */
function curveGeom(id: string, ent: ResolvedEntity, entities: readonly ResolvedEntity[]): { dist: (p: XY) => number; ends: XY[] } {
  const seg = lineOperand(new Map(entities.map((e) => [e.id, e])), id);
  const round = seg ? null : asRound(ent);
  const arc = ent.type === "arc" ? ent : ent.type === "projected" && ent.curve.kind === "arc" ? ent.curve : null;
  const ends: XY[] = seg ? (ent.type === "slot" ? [] : [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }])
    : arc ? [{ x: arc.x1, y: arc.y1 }, { x: arc.x2, y: arc.y2 }]
    : [];
  const dist = (p: XY) => seg ? distToSeg({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, p)
    : round ? Math.abs(Math.hypot(p.x - round.x, p.y - round.y) - round.r)
    : Infinity;
  return { dist, ends };
}

type SplineTangent = Extract<SketchConstraint, { type: "splineTangent" }>;

/** The `splineTangent` a spline pick and an `other` pick make, or the message
 *  saying why there is none.
 *
 *  The tangency is made at a JOINT: an end of the spline that sits on the
 *  other curve (a line operand's segment, a circle's or an arc's whole circle,
 *  or another spline's end). The constraint holds the direction only
 *  (types.ts), so with no joint it would turn the spline's end to a curve it
 *  does not touch, which is no tangency anyone asked for. When both ends of
 *  the spline sit on the curve, the one nearer where it was clicked.
 *
 *  And because it holds the direction only, the end has to be KEPT on the
 *  curve by something else, or the first solve swings it off: a spline
 *  snapped onto a line's middle came out running beside the line, 3.8 mm off
 *  it, and one on a circle 2.8 mm outside it. An end the solver merges with
 *  the curve's own end (same coincKey, the curve's ends mergeable) is one
 *  point with it and needs nothing. Any other joint comes with `hold`: an On
 *  (pointOn) for a line, circle or arc, a Coincident between two splines'
 *  ends, the constraint the snap that put the end there never recorded. None
 *  when `constraints` already holds the end there.
 *
 *  Refused for a closed spline (it has no end) and for one drawn before
 *  splines were built as drawn: the model builds that one as a different curve
 *  from the one the tangency would hold, so the model would not be tangent.
 *  Pure, so the Tangent tool and the right-click menu make the same one. */
export function splineTangentFor(
  spline: TangentPick,
  other: TangentPick,
  entities: readonly ResolvedEntity[],
  constraints: readonly SketchConstraint[] = [],
): { c: SplineTangent; hold?: SketchConstraint } | { why: string } {
  const s = spline.ent;
  if (s.type !== "spline") return { why: t("sketch.constraint.splineTangentNoJoint") };
  const o = other.ent;
  const unusable = (e: ResolvedEntity) =>
    e.type !== "spline" ? null
    : e.closed ? t("sketch.constraint.splineTangentClosed")
    : !e.asDrawn ? t("sketch.constraint.splineTangentOld")
    : null;
  const why = unusable(s) ?? unusable(o);
  if (why) return { why };
  if (o.id === s.id) return { why: t("sketch.constraint.splineTangentSelf") };
  const endsOf = (e: Extract<ResolvedEntity, { type: "spline" }>) =>
    splineEndIndices(e).map((k, end) => ({ end: end as 0 | 1, pos: e.points[k]! }));
  const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
  const merged = (a: XY, b: XY) => coincKey(a.x, a.y) === coincKey(b.x, b.y);
  const joints: { end: 0 | 1; otherEnd?: 0 | 1; score: number; held: boolean }[] = [];
  if (o.type === "spline") {
    for (const a of endsOf(s)) {
      for (const b of endsOf(o)) {
        if (dist(a.pos, b.pos) <= JOINT_TOL) {
          joints.push({ end: a.end, otherEnd: b.end, score: dist(a.pos, spline.at) + dist(b.pos, other.at), held: merged(a.pos, b.pos) });
        }
      }
    }
  } else {
    const { dist: offCurve, ends: curveEnds } = curveGeom(other.id, o, entities);
    for (const a of endsOf(s)) {
      if (offCurve(a.pos) <= JOINT_TOL) joints.push({ end: a.end, score: dist(a.pos, spline.at), held: curveEnds.some((q) => merged(a.pos, q)) });
    }
  }
  const best = joints.reduce<(typeof joints)[number] | null>((x, y) => (!x || y.score < x.score ? y : x), null);
  if (!best) return { why: t("sketch.constraint.splineTangentNoJoint") };
  const c: SplineTangent = {
    type: "splineTangent", spline: s.id, end: best.end, other: other.id,
    ...(best.otherEnd !== undefined ? { otherEnd: best.otherEnd } : {}),
  };
  if (best.held) return { c };
  // a point index names a spline's first point by 0 and its last by any other
  const isEnd = (e: string, p: number, id: string, end: 0 | 1 | undefined) =>
    e === id && (end === undefined || (p === 0 ? 0 : 1) === end);
  const mine = (e: string, p: number) => isEnd(e, p, s.id, best.end);
  const theirs = (e: string, p: number) => isEnd(e, p, o.id, best.otherEnd);
  const holds = constraints.some((k) =>
    k.type === "coincident" ? (mine(k.e1, k.p1) && theirs(k.e2, k.p2)) || (mine(k.e2, k.p2) && theirs(k.e1, k.p1))
    : k.type === "pointOn" ? mine(k.e, k.p) && k.curve === other.id
    : k.type === "midpoint" ? mine(k.e, k.p) && k.line === other.id
    : false);
  if (holds) return { c };
  const hold: SketchConstraint = best.otherEnd !== undefined
    ? { type: "coincident", e1: s.id, p1: best.end, e2: o.id, p2: best.otherEnd }
    : { type: "pointOn", e: s.id, p: best.end, curve: other.id };
  return { c, hold };
}

/** The line/arc-endpoint equivalent of splineTangentFor's joint: a plain line
 *  or arc has no `hold` machinery of its own, but a click landing at/near one
 *  of ITS OWN ends means the same thing a spline's end does — anchor the
 *  tangency there instead of leaving it free to touch anywhere (GH cdd04fd1:
 *  "I can't click an endpoint on the line and make it tangential from that
 *  endpoint").
 *
 *  That end need not be on `other` yet: the hold puts it there in the same
 *  step (c73b3174, Thomas 2026-10-18, reversing cdd04fd1's "an endpoint merely
 *  close to the curve is still a free tangency" for this gesture only). The
 *  reporter had to add the Point-On by hand after a tangent that touched
 *  further along the line. Clicking the line's middle stays a free tangency.
 *
 *  `pick` is whichever of the two curves this is finding the OWN endpoint on;
 *  `other` is what it has to be a joint WITH. Null when `pick` is not a line
 *  or arc (a circle has no end to anchor), or when the click did not land near
 *  one of its ends. Of two ends in reach (a short line), one already on
 *  `other` wins, else the nearer. `held` means the end is already one point
 *  with `other`'s own end (coincKey), which needs no extra hold to stay there. */
function lineArcEndJoint(
  pick: TangentPick,
  other: TangentPick,
  entities: readonly ResolvedEntity[],
  clickTol: number,
): { end: 0 | 1; pos: XY; held: boolean } | null {
  const e = pick.ent;
  const ends: { end: 0 | 1; pos: XY }[] =
    e.type === "line" ? [{ end: 0, pos: { x: e.x1, y: e.y1 } }, { end: 1, pos: { x: e.x2, y: e.y2 } }]
    : e.type === "arc" ? [{ end: 0, pos: { x: e.x1, y: e.y1 } }, { end: 1, pos: { x: e.x2, y: e.y2 } }]
    : [];
  if (!ends.length) return null;
  const { dist: offOther, ends: otherEnds } = curveGeom(other.id, other.ent, entities);
  const merged = (a: XY, b: XY) => coincKey(a.x, a.y) === coincKey(b.x, b.y);
  const reach = (q: { pos: XY }) => Math.hypot(q.pos.x - pick.at.x, q.pos.y - pick.at.y);
  const inReach = ends.filter((q) => reach(q) <= clickTol).sort((q, r) => reach(q) - reach(r));
  const near = inReach.find((q) => offOther(q.pos) <= JOINT_TOL) ?? inReach[0];
  return near ? { end: near.end, pos: near.pos, held: otherEnds.some((q) => merged(near.pos, q)) } : null;
}

export class ConstraintTools {
  constructor(private host: ConstraintHost) {}

  // coincident/symmetric/midpoint all start from an endpoint pick. We stash the
  // first pick (and, for symmetric, the second) on filletFirst-style state.
  private pendingEndpoint: { id: string; idx: number } | null = null;
  private pendingEndpoint2: { id: string; idx: number } | null = null;
  /** the first operand of a two-pick flow; valid ONLY while filletFirst is set */
  private firstOperand: Operand | null = null;
  /** where Coincident's held curve was clicked, for resolvePointOn's second
   *  try; read only alongside firstOperand */
  private firstAt: THREE.Vector2 | null = null;

  /** whether an endpoint-based flow (coincident/symmetric/midpoint) is mid-pick */
  hasPending(): boolean {
    return this.pendingEndpoint != null || this.pendingEndpoint2 != null;
  }
  /** abandon any in-progress endpoint pick (tool switch, Escape, session end) */
  resetPending() {
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.firstOperand = null;
    this.firstAt = null;
    this.host.setPendingPoints([]); // the marker must not outlive the pick
  }

  /** The OPERAND id a two-pick flow is currently holding, or null.
   *
   *  `filletFirst` holds an ENTITY index, which is all SketchMode's own fillet
   *  tool needs and is what its Escape path reads — but it cannot say WHICH of a
   *  rectangle's four line operands was picked, so the first-pick highlight lit
   *  all four sides when the user had armed one. This is the missing half, and
   *  it is deliberately read-only: the index stays the single source of "am I
   *  armed", so nothing here can leave a pick alive that Escape cannot clear. */
  heldOperandId(): string | null {
    return this.host.getFilletFirst() == null ? null : (this.firstOperand?.id ?? null);
  }

  /** Report a click that found no usable target. Every tool routes misses here:
   *  a constraint tool that does nothing and says nothing is indistinguishable
   *  from a broken one, which is exactly how Coincident read (GitHub #17). */
  private missed() {
    const tool = this.host.tool();
    this.host.warn(t("sketch.constraint.miss", {
      tool: t(`sketch.constraint.${tool}`),
      wants: t(WANTS[tool] ?? "sketch.constraint.wants.default"),
    }));
  }

  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). */
  click(p: THREE.Vector2) {
    const tool = this.host.tool();
    if (tool === "coincident") return this.coincidentClick(p);
    // point-based constraints pick the nearest endpoint, not an entity body
    if (tool === "symmetric" || tool === "midpoint") {
      return this.pointConstraintClick(p);
    }
    if (tool === "fix") return this.fixClick(p);
    if (tool === "tangent") return this.tangentClick(p);
    if (tool === "equal") return this.equalClick(p);
    if (tool === "concentric") return this.concentricClick(p);
    if (tool === "horizontal" || tool === "vertical") return this.axisClick(p, tool);

    // line-based constraints (parallel/perpendicular/collinear)
    const op = this.pickOperand(p);
    if (!op || op.kind !== "line") return this.missed();
    // two-line constraints: first click stores, second applies. The FIRST pick
    // is the one that moves (bug #86) — `ent.id` rather than the operand id,
    // because a rect edge's mover is its rectangle.
    const pair = this.holdPair(op);
    if (!pair) return;
    const [a, b] = pair;
    const moves = a.ent.id;
    if (tool === "parallel") this.addConstraint({ type: "parallel", l1: a.id, l2: b.id }, moves);
    else if (tool === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a.id, l2: b.id }, moves);
    else if (tool === "collinear") this.addConstraint({ type: "collinear", l1: a.id, l2: b.id }, moves);
  }

  /** Horizontal/Vertical: a line BODY makes the whole line square to that
   *  axis, as it always did. Two POINTS instead level (or line up) the gap
   *  between them on that axis, at zero — the existing `p2pDistanceX`/
   *  `p2pDistanceY` the Dimension tool's point-to-point pick already emits
   *  for any two points, just pinned to 0 instead of whatever gap they
   *  happen to be apart. Nothing new is invented for this (ed07f912): "level
   *  these two points" had no tool at all, since the whole-line reading only
   *  ever answers for a SINGLE line's own two ends.
   *
   *  A point under the cursor wins over a line body only when it is at
   *  least as close as the line — see `axisPickPoint`. A lone line can still
   *  be squared by clicking its BODY, away from either end. */
  private axisClick(p: THREE.Vector2, tool: "horizontal" | "vertical") {
    if (this.pendingEndpoint) {
      // completing an armed two-point pick: a point under the cursor always
      // finishes it (there is no line reading to fall back to mid-pick)
      const ep = this.pickEndpoint(p, this.pendingEndpoint);
      if (!ep) return this.missed(); // a point is armed; a miss must not silently drop it
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      this.host.setPendingPoints([]);
      if (a.id === ep.id && a.idx === ep.idx) return this.missed(); // the same point twice holds nothing
      // horizontal LEVELS (equal Y), vertical LINES UP (equal X) — see sketchSolve
      const type = tool === "horizontal" ? "p2pDistanceY" : "p2pDistanceX";
      this.addConstraint({ type, e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx, value: 0 }, a.id);
      return;
    }
    const ep = this.axisPickPoint(p);
    if (ep) {
      this.pendingEndpoint = ep;
      this.host.setPendingPoints(pts(this.endpointXY(ep)));
      return;
    }
    const op = this.pickOperand(p);
    if (!op || op.kind !== "line") return this.missed();
    // constraining the projected line ITSELF is meaningless — it's fixed.
    // (Tested on the ENTITY, not on `kind`: a rect edge is a line operand and
    // is perfectly constrainable, it just isn'tool a `line` entity.)
    if (op.ent.type === "projected") return this.host.warn(PROJECTED_FIXED_MSG);
    this.addConstraint({ type: tool, line: op.id });
  }

  /** Horizontal/Vertical's first-click precedence between a point and a line
   *  body under the same cursor position: the point wins UNLESS a line is
   *  strictly closer. A line's own endpoint sits on its own body too, so
   *  without a tie-break, the common gesture — squaring a whole line by
   *  clicking near its end, not its exact middle — silently armed a two-point
   *  pick instead (regression: a point always won outright). Shared with
   *  `hoverPoint` so the highlight never disagrees with the click. */
  private axisPickPoint(p: THREE.Vector2): { id: string; idx: number } | null {
    const ep = this.pickEndpoint(p, null);
    if (!ep) return null;
    const op = this.pickOperand(p);
    if (!op || op.kind !== "line") return ep;
    const seg = lineOperand(new Map(this.host.entities().map((e) => [e.id, e])), op.id);
    const at = seg ? this.endpointXY(ep) : null;
    if (!seg || !at) return ep;
    const lineDist = distToSeg({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, p);
    const pointDist = Math.hypot(at.x - p.x, at.y - p.y);
    return lineDist < pointDist ? null : ep;
  }

  /** THE operand under the cursor. The shapes are the reason this exists: a
   *  rectangle, polygon or slot presents line operands and none of its own, so
   *  "which entity" is not the same question as "which operand" — see
   *  entityDims.lineOperandAt for why the seam is there and not in curveKind.
   *  `skip` leaves one entity out, for resolvePointOn's second try.
   *
   *  A slot's AXIS is inside the slot, where no curve is, so it is taken only
   *  when the click found nothing else of the user's (slotAxisAt). */
  private pickOperand(p: THREE.Vector2, skip: string | null = null, splines = false): Operand | null {
    const all = this.host.entities();
    const entities = skip == null ? all : all.filter((e) => e.id !== skip);
    const tol = this.host.pickTol();
    const ent = entities[pickEntity(entities, p, tol)];
    // your own geometry beats the origin's (pickEntity), and a slot's axis is
    // yours: a slot drawn along the X axis has its axis on top of it
    if (!ent || isOriginGeometry(ent.id)) {
      const axis = slotAxisAt(entities, p, tol);
      const slot = axis ? all.find((e) => e.id === axis.slice(0, axis.indexOf("~"))) : undefined;
      if (axis && slot) return { id: axis, kind: "line", ent: slot, index: all.indexOf(slot) };
      if (!ent) return null;
    }
    const index = all.indexOf(ent);
    if (ent.type === "spline") return splines ? { id: ent.id, kind: "spline", ent, index } : null;
    const lineId = lineOperandAt(ent, p);
    if (lineId) return { id: lineId, kind: "line", ent, index };
    const k = curveKind(ent);
    return k === "circle" || k === "arc" ? { id: ent.id, kind: k, ent, index } : null;
  }

  /** The shared two-pick handshake: returns [first, second] once a second
   *  operand lands, null while arming the first or on a repeat of the same one.
   *
   *  `filletFirst` stays the single source of "am I armed", because SketchMode
   *  clears it on Escape and on setTool and knows nothing about the operand slot
   *  beside it — reading the operand only while filletFirst is set is what keeps
   *  a first pick from surviving an Escape. */
  private holdPair(op: Operand): [Operand, Operand] | null {
    if (this.host.getFilletFirst() == null) {
      this.host.setFilletFirst(op.index);
      this.firstOperand = op;
      return null;
    }
    const first = this.firstOperand;
    this.host.setFilletFirst(null);
    this.firstOperand = null;
    // The SAME operand twice is a miss; two different EDGES of one rectangle are
    // not (making two of its sides equal is a legitimate, useful pick).
    if (!first || first.id === op.id) { this.missed(); return null; }
    return [first, op];
  }

  /** nearest addressable POINT to p — a line/arc/spline end, a point entity, a
   *  RECTANGLE CORNER, or a circle/arc CENTRE.
   *
   *  The search itself is entityDims.refPointNear, which the Select tool's
   *  click goes through too (GH #17's point-level selection), so a point it
   *  selects is the point a constraint tool would have picked there.
   *
   *  It enumerates `dimRefPoints`, which is the document's one answer to "which
   *  points does this entity expose, and under which index". Borrowing it rather
   *  than keeping a second list here is the whole point: this used to have an
   *  arm per entity type and no arm for `circle`, so a circle's centre was
   *  addressable by every dimension and by `fix` and reachable by no constraint
   *  at all. Coincident aimed at one armed nothing and said "click the ends of
   *  the lines", which reads as a dead tool (reported 2026-09-01). An arc's
   *  centre was in the same position, one index further along.
   *
   *  Rectangle corners keep the spelling the document already uses everywhere —
   *  the rectangle's own id with `idx` = the corner index 0..3 — and not the
   *  edge form `R~k` p0/p1: that reaches the same solver point, but nothing that
   *  renders a point operand (glyphs.refPos) can decode it, so such a constraint
   *  would be invisible and undeletable.
   *
   *  `held` is the point a flow is already holding. Any OTHER point under the
   *  cursor beats it, however much nearer the held one is: two ends a few
   *  hundredths of a millimetre apart are exactly the gap Coincident exists to
   *  close, and the second click, landing where the first did, used to resolve
   *  to the first pick again and be refused as the same point twice (field
   *  report 356b2693, a 0.02 mm gap that kept an offset outline open). The held
   *  point is still returned when it is the only one there, so a genuine
   *  repeat click keeps its own message. */
  private pickEndpoint(
    p: THREE.Vector2,
    held: { id: string; idx: number } | null = null,
  ): { id: string; idx: number } | null {
    const tol = this.host.pickTol();
    const best = refPointNear(this.host.entities(), p, tol, held);
    if (best || !held) return best;
    const at = this.endpointXY(held);
    return at && (at.x - p.x) ** 2 + (at.y - p.y) ** 2 <= tol * tol ? held : null;
  }

  /** Plane coords of the addressable point under `p`, or null. For the hover
   *  highlight, and deliberately routed through the SAME pick the click flows
   *  use (plain pickEndpoint, or axisPickPoint for Horizontal/Vertical's
   *  first click): if these two ever disagree the highlight becomes a lie,
   *  which is the failure this whole affordance exists to remove (a target
   *  you can see but not hit is the GH #17 shape, and one you can hit but not
   *  see is what rectangle corners were until this release). */
  hoverPoint(p: THREE.Vector2): { x: number; y: number } | null {
    const tool = this.host.tool();
    const axisFirstClick = (tool === "horizontal" || tool === "vertical") && !this.pendingEndpoint;
    const ep = axisFirstClick ? this.axisPickPoint(p) : this.pickEndpoint(p, this.pendingEndpoint);
    return ep ? this.endpointXY(ep) : null;
  }

  /** Where a picked point reference IS, so the host can mark it on screen —
   *  resolved through `refPoint`, which is the same list pickEndpoint picked it
   *  out of. One list, so a point that can be picked is always one that can be
   *  shown, and the two cannot drift apart. */
  private endpointXY(ep: { id: string; idx: number }): { x: number; y: number } | null {
    const e = this.host.entities().find((x) => x.id === ep.id);
    const q = e ? refPoint(e, ep.idx) : null;
    return q ? { x: q.x, y: q.y } : null;
  }

  /** Coincident: two points, or a point and a curve, in either order.
   *
   *  Two points join (`coincident`). A point and a line, circle or arc put the
   *  point ON the curve (`pointOn`: the infinite line, the whole circle, see
   *  types.ts). Two line BODIES still mean Collinear.
   *
   *  The point is what moves, whichever was clicked first: the gesture is "put
   *  this point on that line", and the first-pick rule the other two-pick flows
   *  follow (bug #86) would swing a line clicked first over to the point
   *  instead. A point that cannot move (the origin, a fixed or projected point)
   *  leaves the bias nothing to hold, so the solve moves the curve to it.
   *
   *  Until this existed, the point-then-line order said "click the second
   *  ENDPOINT" and the line-then-point order dropped the held line without a
   *  word (TA 38391076, Doug 21): there was no way at all to put a point on a
   *  line. */
  private coincidentClick(p: THREE.Vector2) {
    const held = this.host.getFilletFirst() == null ? null : this.firstOperand;
    const ep = this.pickEndpoint(p, this.pendingEndpoint);
    if (ep) {
      if (held) {
        // a curve first, then the point to put on it
        this.host.setFilletFirst(null);
        this.firstOperand = null;
        return this.pointOn(ep, held, this.firstAt ?? p);
      }
      if (!this.pendingEndpoint) {
        this.pendingEndpoint = ep;
        this.host.setPendingPoints(pts(this.endpointXY(ep)));
        return;
      }
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      this.host.setPendingPoints([]);
      // Two points of the SAME entity: refused, but no longer in silence. It
      // used to fall through a bare `if (a.id !== ep.id)` — no constraint, no
      // message, and the pending marker wiped on the way out, which is the
      // dead-tool reading this whole pass exists to remove. Newly easy to hit
      // now that rectangle corners are pickable: both corners of a rectangle
      // carry the rectangle's own id, so clicking any two of them lands here.
      //
      // Refusing is right on the geometry as well as the affordance. Joining
      // two corners of one rectangle annihilates it in a single solve, and
      // joining a line's two ends collapses it — the guard would refuse the
      // solve anyway, one step later and with less to say about why.
      if (a.id === ep.id) {
        this.host.warn(
          a.idx === ep.idx
            ? t("sketch.constraint.samePointTwice")
            : t("sketch.constraint.sameShape"),
        );
        return;
      }
      this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx }, a.id);
      return;
    }

    // No point under the cursor: a curve, or nothing at all. Nothing at all
    // used to be a bare `return`: no constraint, no message, no highlight,
    // indistinguishable from a broken tool, and the reason both a field
    // reporter and the author concluded sketch lines were not selectable.
    const op = this.pickOperand(p);
    if (!op) {
      this.host.warn(t("sketch.constraint.coincidentMiss"));
      return; // keep whatever is held: a stray click must not lose the first pick
    }
    if (this.pendingEndpoint) {
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      this.host.setPendingPoints([]);
      return this.pointOn(a, op, p);
    }
    if (!held) {
      this.host.setFilletFirst(op.index);
      this.firstOperand = op;
      this.firstAt = p.clone();
      return;
    }
    this.host.setFilletFirst(null);
    this.firstOperand = null;
    if (held.id === op.id) return;
    // Two line BODIES: apply collinear, the way SolidWorks and Fusion do,
    // instead of doing nothing. A shape's side is a line like any other.
    if (held.kind === "line" && op.kind === "line") {
      this.addConstraint({ type: "collinear", l1: held.id, l2: op.id }, held.ent.id);
      this.host.warn(t("sketch.constraint.collinearApplied"));
      return;
    }
    this.host.warn(t("sketch.constraint.pointOnNeedsPoint"));
  }

  /** Put a picked point on a curve operand, or say why not (resolvePointOn).
   *  `at` is where the curve was clicked. */
  private pointOn(pt: { id: string; idx: number }, curve: Operand, at: THREE.Vector2) {
    const r = this.resolvePointOn(pt, curve, at);
    if (!r) {
      this.host.warn(t("sketch.constraint.pointOnOwnCurve"));
      return;
    }
    this.addConstraint({ type: "pointOn", e: r.pt.id, p: r.pt.idx, curve: r.curve.id }, r.pt.id);
  }

  /** The `pointOn` a point and a curve picked at `at` make, or null when it has
   *  to be refused.
   *
   *  Two ends or corners at one position are one point to the solver
   *  (coincKey), so a corner two shapes share belongs to both, and an edge two
   *  shapes share is under the cursor twice. Which shape's name a click took
   *  came down to list order or a float's last digit, and on two stacked
   *  rectangles that share a corner and an edge (the TA 38391076 document) most
   *  clicks were refused as "belongs to the curve you picked", for a pair the
   *  user never meant. So before refusing, the same position is tried under
   *  another shape's name (nameOffCurve), and then another shape's curve under
   *  `at`: an edge two shapes share is the other shape's edge just as much. */
  private resolvePointOn(
    pt: { id: string; idx: number },
    curve: Operand,
    at: THREE.Vector2,
  ): { pt: { id: string; idx: number }; curve: Operand } | null {
    const named = this.nameOffCurve(pt, curve);
    if (named) return { pt: named, curve };
    const other = this.pickOperand(at, curve.ent.id);
    const otherNamed = other ? this.nameOffCurve(pt, other) : null;
    return other && otherNamed ? { pt: otherNamed, curve: other } : null;
  }

  /** The point `pt`, or another one at its position (your own geometry before
   *  the origin, as pickEntity prefers it), that `curve` can take
   *  (takesPoint); null when none can. */
  private nameOffCurve(pt: { id: string; idx: number }, curve: Operand): { id: string; idx: number } | null {
    if (this.takesPoint(curve, pt)) return pt;
    const pos = this.endpointXY(pt);
    if (!pos) return null;
    const key = coincKey(pos.x, pos.y);
    const others = this.host.entities().filter((e) => e.id !== pt.id && e.id !== curve.ent.id);
    others.sort((a, b) => Number(isOriginGeometry(a.id)) - Number(isOriginGeometry(b.id)));
    for (const e of others) {
      for (const r of dimRefPoints(e)) {
        const q = { id: e.id, idx: r.p };
        if (coincKey(r.pos.x, r.pos.y) === key && this.takesPoint(curve, q)) return q;
      }
    }
    return null;
  }

  /** Whether `curve` can take the point `pt`, judged by SOLVER point, not by
   *  entity id. Never a point of the curve's own entity: a line's end is on it
   *  already, a circle's centre on its own rim collapses it, and a rectangle
   *  corner on its own opposite side folds the rectangle flat. And the same
   *  for another shape's point MERGED with one of those (sketchSolve.getPoint):
   *  it may sit on the curve only as one of the curve's ENDS, which it is on
   *  already. That one is kept, the way a Coincident of two joined points is:
   *  the join is by position only, a Move of one shape breaks it, and this
   *  then holds the corner on the edge. A centre keeps a solver point of its
   *  own, so it is never one of another shape's points, however close. */
  private takesPoint(curve: Operand, pt: { id: string; idx: number }): boolean {
    const owner = curve.ent;
    if (pt.id === owner.id) return false;
    const pos = this.endpointXY(pt);
    if (!pos || !merges(this.entityById(pt.id), pt.idx)) return true;
    const key = coincKey(pos.x, pos.y);
    const sameKey = (q: { x: number; y: number }) => coincKey(q.x, q.y) === key;
    if (!dimRefPoints(owner).some((r) => merges(owner, r.p) && sameKey(r.pos))) return true;
    const seg = curve.kind === "line" ? lineOperand(new Map([[owner.id, owner]]), curve.id) : null;
    const ends = seg ? [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }]
      : curve.kind === "arc" ? dimRefPoints(owner).filter((r) => r.p < 2).map((r) => r.pos)
        : [];
    return ends.some(sameKey);
  }

  private entityById(id: string): ResolvedEntity | undefined {
    return this.host.entities().find((x) => x.id === id);
  }

  /** What the Coincident hover lights: the curve a click at `p` would take,
   *  through the same pickOperand and resolvePointOn the click goes through.
   *  So it is the other shape's edge where a held point would be refused on
   *  the nearer one, and nothing on a slot's round end. */
  hoverCurve(p: THREE.Vector2): ResolvedEntity | null {
    const near = this.pickOperand(p);
    const held = this.pendingEndpoint;
    const op = near && held ? (this.resolvePointOn(held, near, p)?.curve ?? near) : near;
    if (!op) return null;
    if (op.id === op.ent.id) return op.ent;
    const seg = lineOperand(new Map([[op.ent.id, op.ent]]), op.id);
    return seg ? ({ type: "line", id: op.id, ...seg } as ResolvedEntity) : null;
  }

  private pointConstraintClick(p: THREE.Vector2) {
    const tool = this.host.tool();
    if (tool === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.pickEndpoint(p);
        if (!ep) return this.missed();
        this.pendingEndpoint = ep;
        this.host.setPendingPoints(pts(this.endpointXY(ep)));
        return;
      }
      const op = this.pickOperand(p);
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      this.host.setPendingPoints([]);
      // compared by OWNING ENTITY, not by operand id: centring a rectangle's
      // corner on one of that same rectangle's edges is a self-referential
      // squash, and `R~0` would not equal `R` on a bare id compare
      if (op && op.kind === "line" && baseOf(op.id) !== ep.id) {
        // the POINT was picked first, so the point is what moves (bug #86)
        this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: op.id }, ep.id);
      } else this.missed();
      return;
    }
    // symmetric: pick endpoint A, endpoint B, then the axis line
    if (!this.pendingEndpoint) {
      const ep = this.pickEndpoint(p);
      if (!ep) return this.missed();
      this.pendingEndpoint = ep;
      this.host.setPendingPoints(pts(this.endpointXY(ep)));
      return;
    }
    if (!this.pendingEndpoint2) {
      const ep = this.pickEndpoint(p, this.pendingEndpoint);
      if (!ep) return this.missed();
      // Two corners of the SAME rectangle is the useful symmetric pick (that is
      // what "centre this rectangle on the axis" means), so the distinctness
      // test is per POINT here, not per entity — two picks of one line's two
      // ends stay legal for the same reason.
      //
      // Per solver point, though, not per id: pickEndpoint now passes over the
      // held point to the other curve's end beside it, and at a shared corner
      // that end is the SAME solver point. Mirroring a point onto itself pins
      // it to the axis, which nobody asked for by clicking a corner twice.
      const held = this.endpointXY(this.pendingEndpoint), at = this.endpointXY(ep);
      const samePoint = (ep.id === this.pendingEndpoint.id && ep.idx === this.pendingEndpoint.idx)
        || (!!held && !!at && coincKey(held.x, held.y) === coincKey(at.x, at.y));
      if (samePoint) {
        // Clicking the SAME point twice used to fall out of here having done and
        // said nothing, holding a pick the user could not tell was still held.
        this.host.warn(t("sketch.constraint.alreadyPicked"));
        return;
      }
      this.pendingEndpoint2 = ep;
      // BOTH points are now held, and both are marked. With one marker the
      // second pick landed with no feedback at all, so the middle of a
      // three-click gesture looked like nothing had happened.
      this.host.setPendingPoints(
        pts(this.endpointXY(this.pendingEndpoint), this.endpointXY(ep)),
      );
      return;
    }
    // third click: the symmetry axis line
    const op = this.pickOperand(p);
    const a = this.pendingEndpoint, b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.host.setPendingPoints([]);
    // three picks, and the first is still the mover: A swings onto B's mirror
    // rather than the pair meeting in the middle
    if (op && op.kind === "line") this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: op.id }, a.id);
  }

  /** Two-pick flow shared by tangent/equal/concentric: returns [first, second]
   *  once a second valid operand lands (both pass `ok`, distinct); null while
   *  arming the first pick or on an invalid pick. Uses the filletFirst slot as
   *  the armed flag — see holdPair for why the operand rides beside it. */
  /** Two-click operand pick, reporting its OWN misses.
   *
   *  It has to, because `null` means two different things here and the callers
   *  could not tell them apart: "that click found nothing" and "that click armed
   *  the first of two". Every caller used to answer both with `missed()`, so the
   *  opening click of Tangent, Equal and Concentric told the user "Nothing to
   *  constrain there" about a pick that had landed perfectly well and was
   *  waiting for its partner. That is the dead-tool signature the whole
   *  affordance pass exists to remove, reading out loud on a tool that worked.
   *
   *  `holdPair` above already had this shape; this brings the two into line. */
  private pickPair(p: THREE.Vector2, ok: (o: Operand) => boolean, splines = false): [Operand, Operand, THREE.Vector2] | null {
    const op = this.pickOperand(p, null, splines);
    if (!op || !ok(op)) { this.missed(); return null; }
    if (this.host.getFilletFirst() == null) {
      this.host.setFilletFirst(op.index);
      this.firstOperand = op;
      this.firstAt = p.clone();
      return null; // armed, not missed: say nothing
    }
    const first = this.firstOperand;
    const firstAt = this.firstAt ?? p;
    this.host.setFilletFirst(null);
    this.firstOperand = null;
    this.firstAt = null;
    if (!first || first.id === op.id) { this.missed(); return null; }
    return [first, op, firstAt];
  }

  /** tangent between two curves: line/circle/arc, in any mix except line+line.
   *  Emits the general `tangent2`; the compiler picks the right planegcs variant.
   *  A SPLINE goes tangent at its end, to the curve that end meets
   *  (splineTangentFor), in either pick order; the first pick still moves. */
  private tangentClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, () => true, true); // every operand is a tangency-capable curve
    if (!pair) return; // pickPair already said whatever needed saying
    const [first, e, firstAt] = pair;
    const a = { id: first.id, ent: first.ent, at: firstAt }, b = { id: e.id, ent: e.ent, at: p };
    if (first.kind === "spline" || e.kind === "spline") {
      const ents = this.host.entities(), cons = this.host.constraints();
      const r = first.kind === "spline" ? splineTangentFor(a, b, ents, cons) : splineTangentFor(b, a, ents, cons);
      if ("why" in r) return this.host.warn(r.why);
      return this.addConstraint(r.c, first.ent.id, r.hold ? [r.hold] : undefined);
    }
    // two lines cannot be tangent — say so rather than swallowing the pick
    if (first.kind === "line" && e.kind === "line") return this.missed();
    // A click at/near a line or arc's OWN endpoint anchors the tangency there,
    // putting that end on the other curve when it is not on it yet (cdd04fd1,
    // c73b3174) — tried in both pick orders, since either curve can be the one
    // with the end.
    const tol = this.host.pickTol();
    const ents = this.host.entities();
    const onA = lineArcEndJoint(a, b, ents, tol);
    const [owner, curve, joint] = onA ? [a, b, onA] : [b, a, lineArcEndJoint(b, a, ents, tol)];
    if (joint) {
      const hold: SketchConstraint = { type: "pointOn", e: owner.id, p: joint.end, curve: curve.id };
      return this.addConstraint({ type: "tangent2", a: first.id, b: e.id }, first.ent.id, joint.held ? undefined : [hold]);
    }
    this.addConstraint({ type: "tangent2", a: first.id, b: e.id }, first.ent.id);
  }

  /** equal: two lines share length, or two circles/arcs share radius. */
  private equalClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, () => true);
    if (!pair) return; // pickPair already said whatever needed saying
    const [first, e] = pair;
    if (first.kind === "line" && e.kind === "line") {
      this.addConstraint({ type: "equal", l1: first.id, l2: e.id }, first.ent.id);
    } else if (isRoundOp(first) && isRoundOp(e)) {
      this.addConstraint({ type: "equalRadius", a: first.id, b: e.id }, first.ent.id);
    } else {
      // A line and a circle. Both picks were valid targets, so `missed` would be
      // a lie, and falling off the end here is worse: it consumed two clicks,
      // emitted nothing and said nothing, which is precisely how a working tool
      // reads as broken. There is no meaning to give it — a length and a radius
      // are not the same measurement — so say that.
      this.host.warn(t("sketch.constraint.equalMismatch"));
    }
  }

  private concentricClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isRoundOp); // circles and arcs both carry a center
    if (!pair) return; // pickPair already said whatever needed saying
    this.addConstraint({ type: "concentric", c1: pair[0].id, c2: pair[1].id }, pair[0].ent.id);
  }

  /** fix/lock: pin the nearest addressable point of any entity. Reuses
   *  dimRefPoints (line/arc endpoints, arc/circle centers, rect corners, spline
   *  ends) so the `p`-index convention lives in exactly one place. */
  private fixClick(p: THREE.Vector2) {
    const tol = this.host.pickTol();
    let best: { id: string; p: number } | null = null;
    let bestD = tol * tol;
    for (const e of this.host.entities()) {
      if (e.type === "projected") continue; // already fixed — fixing it is meaningless
      for (const r of dimRefPoints(e)) {
        const dx = r.pos.x - p.x, dy = r.pos.y - p.y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { id: e.id, p: r.p }; }
      }
    }
    if (best) return this.addConstraint({ type: "fix", e: best.id, p: best.p });
    // no addressable point — explain a click on projected geometry (skipped
    // above: it is already fixed) instead of silently doing nothing. This
    // specific message beats the generic one, so it goes first.
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, tol);
    if (entities[idx]?.type === "projected") return this.host.warn(PROJECTED_FIXED_MSG);
    return this.missed();
  }

  private addConstraint(c: SketchConstraint, moves?: string, holds?: readonly SketchConstraint[]) {
    // A relation this pair already has (parallel ×N, two tangents on the same
    // pair) is refused with a word rather than piled on again — the duplicate
    // was silent before, and read as the tool doing nothing the first time.
    if (alreadyRelates(this.host.constraints(), c)) {
      this.host.warn(t("sketch.constraint.alreadyRelated"));
      return;
    }
    this.host.addConstraint(c, moves, dedupeHolds(this.host.constraints(), holds));
  }
}
