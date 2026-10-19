// Where the perspective camera spends its depth precision.
//
// A perspective depth buffer resolves roughly d^2 / (near * 2^bits) at distance
// d, so it is the NEAR plane that decides precision, and the camera used to
// hold it at a fixed 0.1 mm (far 10 m) whatever it looked at. With a 16-bit
// buffer, which is all WebGL guarantees, that cannot tell apart two surfaces
// 0.5 mm apart at 265 mm away: they take turns in front and the loser shows
// through in bands. Field case: Doug's miter gauge STEP, 2026-10, where the
// "squiggles" were the slot wall and hidden edges fighting the top face.
// Rendered with an emulated 16-bit buffer, 7,760 pixels differed from the
// 24-bit render at his angle; with near at half the camera's distance from the
// model, 37.
//
// So near follows the distance from the camera to the nearest thing drawn,
// every drawn thing, not just the model: sketches, gizmos, datum quads, the
// ground grid. Pulled out too far it would cut into one of them, and a clipped
// model is a much worse bug than squiggles, so the rule errs small: inside any
// object's box the old 0.1 mm stands.
//
// The orthographic camera does not need any of this: its depth is linear, so
// its fixed slab already resolves 0.3 mm at 16 bits everywhere.

import * as THREE from "three";
import { isSaneBox } from "./modelBox";

/** The near plane the perspective camera always had, in mm, and the floor: a
 *  camera inside the model's box keeps it. */
export const PERSP_NEAR_MIN = 0.1;
/** The far plane it always had, in mm, and the floor: content further out than
 *  this raises it. Depth precision barely depends on far, so there is nothing
 *  to win by pulling it in, and a fixed floor forgives a box that is stale. */
export const PERSP_FAR_MIN = 10000;
/** Near as a share of the nearest distance that is provably safe (see
 *  perspDepthRange). Half, for what a box does not account for: a line or a
 *  point drawn a few pixels wide, a gizmo rescaled since the box was read. */
const NEAR_MARGIN = 0.5;
/** Far as a multiple of the farthest drawn point. */
const FAR_MARGIN = 1.5;
/** Near and far move in steps of 2^(1/STEPS_PER_OCTAVE), rounded toward
 *  "draws more", so a static view, or a slow orbit, does not rebuild the
 *  projection every frame and the depth values do not shimmer while it moves. */
const STEPS_PER_OCTAVE = 4;

/** How far the drawn content reaches from the camera, in mm: the distance to
 *  the nearest point of any object's box (0 inside one), and to the farthest. */
export interface DepthSpan {
  nearest: number;
  farthest: number;
}

export function emptySpan(): DepthSpan {
  return { nearest: Infinity, farthest: 0 };
}

const farCorner = new THREE.Vector3();

/** Fold one world-space box into `span`, as seen from `eye`. */
export function addBoxSpan(box: THREE.Box3, eye: THREE.Vector3, span: DepthSpan): void {
  if (!isSaneBox(box)) return; // empty, or OCCT's ±1e100 "unbounded": nothing real to measure
  span.nearest = Math.min(span.nearest, box.distanceToPoint(eye));
  farCorner.set(
    Math.max(Math.abs(eye.x - box.min.x), Math.abs(eye.x - box.max.x)),
    Math.max(Math.abs(eye.y - box.min.y), Math.abs(eye.y - box.max.y)),
    Math.max(Math.abs(eye.z - box.min.z), Math.abs(eye.z - box.max.z)),
  );
  span.farthest = Math.max(span.farthest, farCorner.length());
}

const scratchBox = new THREE.Box3();

/** Call `visit` with the world box of every object under `root` that would be
 *  drawn: visible itself and up its chain, and carrying geometry. `skip`'s
 *  subtree is left out. Reads matrixWorld as it stands, so update it first. */
function forEachDrawnBox(root: THREE.Object3D, visit: (box: THREE.Box3) => void, skip?: THREE.Object3D): void {
  if (!root.visible || root === skip) return;
  const geo = (root as { geometry?: THREE.BufferGeometry }).geometry;
  if (geo instanceof THREE.BufferGeometry) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (geo.boundingBox) visit(scratchBox.copy(geo.boundingBox).applyMatrix4(root.matrixWorld));
  }
  for (const child of root.children) forEachDrawnBox(child, visit, skip);
}

/** Fold every drawn object under `root` (but `skip`'s subtree) into `span`. */
export function addSceneSpan(root: THREE.Object3D, eye: THREE.Vector3, span: DepthSpan, skip?: THREE.Object3D): void {
  forEachDrawnBox(root, (b) => addBoxSpan(b, eye, span), skip);
}

/** The world box of every drawn object under `root`, one per object. Kept
 *  apart rather than unioned: between two bodies of an assembly the camera is
 *  inside their union but outside both, and only the boxes themselves say so. */
export function drawnBoxes(root: THREE.Object3D): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  forEachDrawnBox(root, (b) => {
    if (isSaneBox(b)) out.push(b.clone());
  });
  return out;
}

const stepDown = (v: number) => 2 ** (Math.floor(Math.log2(v) * STEPS_PER_OCTAVE) / STEPS_PER_OCTAVE);
const stepUp = (v: number) => 2 ** (Math.ceil(Math.log2(v) * STEPS_PER_OCTAVE) / STEPS_PER_OCTAVE);

/** The perspective near and far planes for content spanning `span`, for a
 *  camera with vertical field of view `fovDeg` and the given aspect.
 *
 *  Why it cannot clip: a point at distance d from the camera, seen at angle a
 *  off the view axis, sits at depth d cos(a), and on screen a is at most the
 *  angle to a frustum CORNER. No drawn point is nearer than span.nearest, so no
 *  drawn point on screen is shallower than span.nearest x cos(corner angle).
 *  Near goes at a margin inside that. */
export function perspDepthRange(span: DepthSpan, fovDeg: number, aspect: number): { near: number; far: number } {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  const cornerCos = 1 / Math.sqrt(1 + tanHalf * tanHalf * (1 + aspect * aspect));
  const safe = span.nearest * cornerCos * NEAR_MARGIN;
  // `!(x > y)` rather than `x <= y`, so a NaN takes the floor too
  const near = !(safe > PERSP_NEAR_MIN) || !Number.isFinite(safe) ? PERSP_NEAR_MIN : Math.max(PERSP_NEAR_MIN, stepDown(safe));
  const reach = span.farthest * FAR_MARGIN;
  const far = !(reach > PERSP_FAR_MIN) || !Number.isFinite(reach) ? PERSP_FAR_MIN : stepUp(reach);
  return { near, far };
}
