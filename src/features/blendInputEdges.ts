// The edges a fillet/chamfer is made FROM, frozen before its live preview
// replaces them on screen.
//
// The preview is the real blend, so the model on screen already has rounded or
// bevelled faces and the new edges bounding them. Those edges do not exist on
// the body the sidecar resolves the feature's selectors against (the body
// BEFORE the blend), so a click on one, or a tangent chain walking into one,
// stores a midpoint that by:"nearest" silently binds to whatever unrelated
// edge is closest there: a chamfer's 1 mm end edge bound the concave corner
// edge below it and filled the whole corner at 45 degrees (field report
// e470c0e2), a generated edge moved the chamfer onto edges never clicked
// (6c2fc3ba), and one exactly between two real edges failed the preview as
// "ambiguous edge reference" (55a4cca2). Picking, hover and the chain walk all
// read this snapshot instead, and it is what the tool draws as pickable, so an
// edge the blend generated is neither shown as pickable nor picked.

import * as THREE from "three";
import { BodyEdges, type EdgeRef } from "../viewport/edgeLines";
import { midMatchTol, nearestEdgeByMid, type Vec3 } from "../viewport/edgeMatch";
import { EDGE_HOVER, EDGE_PICKABLE } from "../viewport/colors3d";
import type { RebuildResult } from "../types";

const PICKABLE = new THREE.Color(EDGE_PICKABLE);
const HOVER = new THREE.Color(EDGE_HOVER);

export class BlendInputEdges {
  /** The input edges as line objects: drawn, raycast and painted. One per
   *  body, as the model's own are, so a pick still culls whole bodies by
   *  their bounding spheres on a large assembly (see edgeLines.ts). */
  readonly draws: BodyEdges[] = [];
  readonly refs: EdgeRef[] = [];
  /** the input's bounding-box diagonal, for scale-relative tolerances */
  readonly diag: number;
  private hovered: EdgeRef | null = null;

  constructor(edges: readonly Pick<EdgeRef, "id" | "body" | "points">[]) {
    // copied out of the model's refs: those belong to objects a rebuild disposes
    const byBody = new Map<string | undefined, RebuildResult["edges"]>();
    for (const e of edges) {
      let list = byBody.get(e.body);
      if (!list) byBody.set(e.body, (list = []));
      list.push(e.body === undefined ? { id: e.id, points: e.points } : { id: e.id, body: e.body, points: e.points });
    }
    for (const list of byBody.values()) {
      const draw = new BodyEdges(list, new THREE.Vector2(1, 1));
      draw.material.linewidth = 2.8; // as emphasizeEdges draws them
      draw.setColorAll(PICKABLE);
      // drawn after the model's own edges, so where an input edge is still on
      // screen unchanged it is this colour and not the idle one beneath it
      draw.object.renderOrder = 1;
      this.draws.push(draw);
      this.refs.push(...draw.refs);
    }
    const box = new THREE.Box3();
    for (const e of edges) for (const p of e.points) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
    this.diag = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length();
  }

  /** The input edge whose midpoint is nearest `mid`, within the edit-mode
   *  matching tolerance (as Viewport.edgeLineByMid does for the model). */
  byMid(mid: Vec3): EdgeRef | null {
    const i = nearestEdgeByMid(this.refs, mid, midMatchTol(this.diag));
    return i == null ? null : (this.refs[i] ?? null);
  }

  hover(ref: EdgeRef | null) {
    if (ref === this.hovered) return;
    if (this.hovered) this.hovered.draw.setColor(this.hovered.slot, PICKABLE);
    this.hovered = ref;
    if (ref) ref.draw.setColor(ref.slot, HOVER);
  }

  dispose() {
    for (const d of this.draws) d.dispose();
  }
}
