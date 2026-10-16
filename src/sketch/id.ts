// Stable per-entity identity for the sketcher. Constraints reference entities by
// id (never array index), so modify operations that reorder/split/remove
// entities can't silently repoint a constraint at the wrong geometry.
//
// Ids are a monotonic per-session counter shared by all families (`e0`, `p1`,
// `c2`, …). When a sketch is loaded, each family's note() bumps the counter past
// any saved ids so freshly created objects never collide with persisted ones.

import type { SketchConstraint } from "../types";

let counter = 0;

function idFamily(prefix: string) {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  return {
    next: (): string => `${prefix}${counter++}`,
    /** Reserve a loaded id so future next() calls won't reuse it. */
    note: (id: string | undefined): void => {
      if (!id) return;
      const m = re.exec(id);
      if (m) counter = Math.max(counter, Number(m[1]) + 1);
    },
  };
}

const entity = idFamily("e");
export const newEntityId = entity.next;
export const noteEntityId = entity.note;

/** Pattern ids: `p` prefix, so a pattern id and its derived entities ("p3#0")
 *  never collide with entity ids ("e3"). */
const pattern = idFamily("p");
export const newPatternId = pattern.next;
export const notePatternId = pattern.note;

/** Constraint ids (dimension constraints only): the stable identity a parameter
 *  binding references — the constraint array itself is spliced by edits. */
const constraint = idFamily("c");
export const newConstraintId = constraint.next;
export const noteConstraintId = constraint.note;

/** A dimension (value-bearing) constraint — the ones that carry a stable c-id.
 *  The single definition of the concept; the load migration and the editor both
 *  stamp through this predicate. */
export function isDimConstraint(c: SketchConstraint): c is SketchConstraint & { id?: string; value: number } {
  return "value" in c;
}

/** Every entity id a constraint names, rewritten through `op`. One arm per
 *  constraint type and no default, so a constraint type added later fails the
 *  type check here instead of being copied still naming the ORIGINAL ids
 *  (Copy sketch to plane, and Copy inside a sketch: copiedConstraints). */
export function remapConstraint(c: SketchConstraint, op: (id: string) => string): SketchConstraint {
  switch (c.type) {
    case "horizontal": case "vertical": case "distance":
      return { ...c, line: op(c.line) };
    case "parallel": case "perpendicular": case "equal": case "collinear": case "angle":
      return { ...c, l1: op(c.l1), l2: op(c.l2) };
    case "diameter":
      return { ...c, circle: op(c.circle) };
    case "tangent":
      return { ...c, line: op(c.line), circle: op(c.circle) };
    case "tangent2": case "equalRadius":
      return { ...c, a: op(c.a), b: op(c.b) };
    case "coincident": case "p2pDistance": case "p2pDistanceX": case "p2pDistanceY":
      return { ...c, e1: op(c.e1), e2: op(c.e2) };
    case "concentric": case "c2cDistance":
      return { ...c, c1: op(c.c1), c2: op(c.c2) };
    case "midpoint": case "p2lDistance":
      return { ...c, e: op(c.e), line: op(c.line) };
    case "pointOn":
      return { ...c, e: op(c.e), curve: op(c.curve) };
    case "splineTangent":
      return { ...c, spline: op(c.spline), other: op(c.other) };
    case "symmetric":
      return { ...c, e1: op(c.e1), e2: op(c.e2), line: op(c.line) };
    case "radius": case "fix":
      return { ...c, e: op(c.e) };
    case "radialGap":
      return { ...c, inner: op(c.inner), outer: op(c.outer) };
    case "c2lDistance":
      return { ...c, circle: op(c.circle), line: op(c.line) };
    case "p2cDistance":
      return { ...c, e: op(c.e), circle: op(c.circle) };
    case "offset":
      return { ...c, pairs: c.pairs.map((p) => ({ src: op(p.src), cpy: op(p.cpy) })) };
    default:
      return c satisfies never;
  }
}

/** `id` through `entIds` (old entity id -> new), keeping a compound shape's
 *  `~<k>` side suffix (`R~0` -> `R2~0`). Null when the entity is not in the map. */
export function mapOperandId(entIds: ReadonlyMap<string, string>, id: string): string | null {
  const k = id.indexOf("~");
  const to = entIds.get(k < 0 ? id : id.slice(0, k));
  if (to === undefined) return null;
  return k < 0 ? to : to + id.slice(k);
}

/** The constraints that come along when the entities in `entIds` are copied
 *  (in-sketch Copy, 6c0c9504): every one whose operands ALL name a copied
 *  entity, pointed at the copies. One that names anything else (an entity
 *  left behind, the origin, a projected curve the copy skipped) stays behind,
 *  so the copy is never tied to what it came from; an offset keeps just its
 *  pairs that were copied whole. A dimension keeps its value and gets an id of
 *  its own: a parameter binding names a dim by id, and the copy's is a plain
 *  number, not bound to the source's parameter. */
export function copiedConstraints(cons: readonly SketchConstraint[], entIds: ReadonlyMap<string, string>): SketchConstraint[] {
  const out: SketchConstraint[] = [];
  for (const c0 of cons) {
    let c = structuredClone(c0);
    if (c.type === "offset") {
      c.pairs = c.pairs.filter((pr) => mapOperandId(entIds, pr.src) !== null && mapOperandId(entIds, pr.cpy) !== null);
      if (!c.pairs.length) continue;
    }
    let outside = false;
    c = remapConstraint(c, (id) => {
      const to = mapOperandId(entIds, id);
      if (to === null) outside = true;
      return to ?? id;
    });
    if (outside) continue;
    if (isDimConstraint(c) && c.id) c.id = newConstraintId();
    out.push(c);
  }
  return out;
}
