// A Raycaster that hit-tests objects where they ARE, not where they were last
// drawn.
//
// three's raycast reads each object's stored matrixWorld, and only a draw
// refreshes it (renderer.render updates the scene's world matrices). The
// render loop draws on demand, in an animation frame, so an object added or
// moved since the last frame is tested at its old place: a datum quad that
// setDatumPlanes just made sits at the origin until the next draw, and a tool's
// drag arrow at wherever its last frame put it. A click that beats that frame
// misses what is on screen. CI runners that held frames back hit exactly this
// (the Section arrow drag and the datum-plane pick, e2e-settle 2026-10-16).
//
// Only the targets of a pick are brought up to date, never the whole scene:
// a pick runs on every hover frame, and a 3,000-body assembly is ~12,000
// objects. Each target pays one matrix compose per level above it, which is
// small next to the raycast itself.
import * as THREE from "three";

export class PickRaycaster extends THREE.Raycaster {
  override intersectObject<T extends THREE.Object3D>(
    object: THREE.Object3D,
    recursive = true,
    intersects: THREE.Intersection<T>[] = [],
  ): THREE.Intersection<T>[] {
    object.updateWorldMatrix(true, recursive);
    return super.intersectObject(object, recursive, intersects);
  }

  override intersectObjects<T extends THREE.Object3D>(
    objects: THREE.Object3D[],
    recursive = true,
    intersects: THREE.Intersection<T>[] = [],
  ): THREE.Intersection<T>[] {
    for (const o of objects) o.updateWorldMatrix(true, recursive);
    return super.intersectObjects(objects, recursive, intersects);
  }
}
