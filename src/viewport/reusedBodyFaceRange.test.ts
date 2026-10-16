// A body the viewport keeps from the last reply has to answer to THIS reply's
// face numbering.
//
// Tracker row d04febe3: after a fillet on a shelled body, clicking or hovering
// that body's outer walls lit a DIFFERENT body, and suppressing the fillet put
// it right again. Global face ids are handed out by position on every reply
// (assembly.ts), so the fillet's four new faces push every later body's range up
// by four. The later bodies arrive as `unchanged` stubs and the viewport reuses
// their meshes, which still carried the old range: the filleted body's last four
// face ids then resolved to the next body, which is the one that lit up.
//
// Everything here goes through the shipped path: replies come out of the real
// RebuildAssembly (a stub backed by the client's cache), setModel and the
// progressive stream run off Viewport.prototype against a stand-in (as
// loadFitGate.test.ts does, a real Viewport needs WebGL), and input arrives
// through the viewport's own hover and click handlers with a real Picker. The
// oracle is what the user sees: which body's vertex colours changed.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness, FakePointerEvent } from "./rig.testkit";
import { Viewport } from "./viewport";
import { ProgressiveModel } from "./progressive";
import { Picker } from "./picking";
import { disposeBody, type BodyMesh } from "./render";
import { RebuildAssembly, manifestFromBodies } from "../geometry/assembly";
import type { WireBody, WireBodyFull } from "../geometry/assembly";
import type { RebuildResult } from "../types";

/** A Viewport with the members the load path and the pointer handlers touch. */
function standIn() {
  const h = harness();
  const group = new THREE.Group();
  const vp = Object.create(Viewport.prototype) as Viewport & Record<string, unknown>;
  const hits: (number | null)[] = [];
  Object.assign(vp, {
    rig: h.rig,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) },
    scene: { modelGroup: group, renderer: { localClippingEnabled: false, setSize() {} } },
    progressive: new ProgressiveModel(group, disposeBody),
    picker: new Picker(),
    highlighter: null,
    model: null,
    lastResult: null,
    streaming: false,
    suspendPicking: false,
    selectionMode: "faces",
    datumQuads: [],
    hoveredDatum: null,
    selectedDatum: null,
    resolution: new THREE.Vector2(800, 600),
    targetGridZ: 0,
    datumPlaneDefs: [],
    analysis: "none",
    bodyPaint: {},
    texturePaint: {},
    zebra: false,
    combs: false,
    clipPlane: null,
    savedMats: new Map(),
    needsRender: false,
    lingerFrames: 0,
    userMovedCamera: false,
    cameraDriven: false,
    onHit: (hit: { kind: string; faceId?: number } | null) => hits.push(hit?.kind === "face" ? hit.faceId! : null),
  });
  // look straight down -x, so both cubes' +x faces face the camera
  h.rig.controls.setLookAt(400, 0, 0, 0, 0, 0, false);
  h.rig.update(0.016);
  h.rig.active.updateMatrixWorld(); // the renderer does this before a real frame
  return { vp, h, hits };
}

/** A 40 mm cube as a wire payload. `local` maps each of its 12 triangles to a
 *  body-local face id (the wire form; the assembler adds the global base). */
function cube(id: string, etag: string, centre: THREE.Vector3, local: number[]): WireBodyFull {
  const g = new THREE.BoxGeometry(40, 40, 40).toNonIndexed();
  g.translate(centre.x, centre.y, centre.z);
  const positions = Array.from(g.getAttribute("position").array as Float32Array);
  return {
    id, name: id, etag,
    positions,
    indices: Array.from({ length: positions.length / 3 }, (_, i) => i),
    faceIds: local,
    faceCount: Math.max(...local) + 1,
    edges: [],
  };
}
const A = new THREE.Vector3(0, -50, 0);
const B = new THREE.Vector3(0, 50, 0);
// BoxGeometry's triangles come in pairs per side, +x first
const SIX = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
// the same cube after a feature split its +x side: triangle 1 is a new face 6
const SEVEN = [0, 6, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const a6 = () => cube("a", "a-1", A, SIX);
const a7 = () => cube("a", "a-2", A, SEVEN);
const b6 = () => cube("b", "b-1", B, SIX);
const bStub: WireBody = { id: "b", name: "b", etag: "b-1", unchanged: true };

const HEAD = { protocol: 2 as const, bbox: { min: [-20, -70, -20], max: [20, 70, 20] } };

/** The client's side of a rebuild: assemble the wire bodies against its cache,
 *  then remember the full payloads (client.ts keeps them verbatim). */
function reply(cache: Map<string, WireBodyFull>, bodies: WireBody[]): RebuildResult {
  const b = RebuildAssembly.begin(HEAD, manifestFromBodies(bodies), cache, null, null);
  if (b.kind !== "stream") throw new Error(`expected a stream, got ${b.kind}`);
  for (const w of bodies) if (!w.unchanged) expect(b.assembly.writeBody(w)).toBe(true);
  for (const w of bodies) if (!w.unchanged) cache.set(w.id, w);
  const r = b.assembly.complete();
  if (!r) throw new Error("assembly incomplete");
  return r;
}

const bodyOf = (vp: Viewport, id: string): BodyMesh =>
  (vp as unknown as { model: { bodies: BodyMesh[] } }).model.bodies.find((b) => b.id === id)!;

/** Pixel of a world point on the stand-in's 800x600 canvas. */
function pixel(h: ReturnType<typeof harness>, p: THREE.Vector3) {
  const n = p.clone().project(h.rig.active);
  return { clientX: ((n.x + 1) / 2) * 800, clientY: ((1 - n.y) / 2) * 600 };
}

/** World centroid of one of a cube's triangles (its own buffer, its own index). */
function triangleCentre(w: WireBodyFull, t: number) {
  const p = w.positions as number[];
  const c = new THREE.Vector3();
  for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(p[(t * 3 + k) * 3]!, p[(t * 3 + k) * 3 + 1]!, p[(t * 3 + k) * 3 + 2]!));
  return c.divideScalar(3);
}

/** Bodies with at least one vertex whose live colour differs from its base. */
function lit(vp: Viewport): string[] {
  const out: string[] = [];
  for (const b of (vp as unknown as { model: { bodies: BodyMesh[] } }).model.bodies) {
    const c = b.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < c.array.length; i++) {
      if (Math.abs((c.array[i] as number) - b.baseColors[i]!) > 1e-6) { out.push(b.id); break; }
    }
  }
  return out;
}

type Handlers = { handleHover(e: unknown): void; handleClick(e: unknown): void };
function hover(vp: Viewport, at: { clientX: number; clientY: number }) {
  vp.clearSelection();
  (vp as unknown as Handlers).handleHover(new FakePointerEvent(at));
  return lit(vp);
}
function click(vp: Viewport, at: { clientX: number; clientY: number }) {
  vp.clearSelection();
  (vp as unknown as Handlers).handleClick(Object.assign(new FakePointerEvent(at), { ctrlKey: false, metaKey: false, shiftKey: false }));
  (vp as unknown as { highlighter: { clearHover(): void } }).highlighter.clearHover();
  return lit(vp);
}

/** Colour a face wears, read at the first vertex of its first triangle. */
function faceColour(body: BodyMesh, faceId: number): string {
  const t = body.faceTriangles.get(faceId)![0]!;
  const v = body.mesh.geometry.getIndex()!.getX(t * 3);
  const c = body.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
  return new THREE.Color(c.getX(v), c.getY(v), c.getZ(v)).getHexString();
}

describe("a reused body after an earlier body changed its face count (d04febe3)", () => {
  it("CONTROL: an all-stub reply keeps both meshes and both +x faces select on their own body", () => {
    const { vp, h, hits } = standIn();
    const cache = new Map<string, WireBodyFull>();
    vp.setModel(reply(cache, [a6(), b6()]));
    const before = { a: bodyOf(vp, "a").mesh, b: bodyOf(vp, "b").mesh };
    // a FRESH result object: re-sending the same one takes the visibility-only path
    vp.setModel(reply(cache, [{ id: "a", name: "a", etag: "a-1", unchanged: true }, bStub]));
    expect(bodyOf(vp, "a").mesh === before.a, "a was rebuilt").toBe(true);
    expect(bodyOf(vp, "b").mesh === before.b, "b was rebuilt").toBe(true);
    expect(click(vp, pixel(h, triangleCentre(a6(), 0)))).toEqual(["a"]);
    expect(click(vp, pixel(h, triangleCentre(b6(), 0)))).toEqual(["b"]);
    expect(hits).toEqual([0, 6]);
  });

  it("a gains a face while b arrives as a stub: a's new face lights on a, b's face reports its new id", () => {
    const { vp, h, hits } = standIn();
    const cache = new Map<string, WireBodyFull>();
    vp.setModel(reply(cache, [a6(), b6()]));
    const bMesh = bodyOf(vp, "b").mesh;
    const r2 = reply(cache, [a7(), bStub]);
    // precondition: the assembler renumbers b to follow a's seven faces
    expect(r2.bodies!.map((m) => [m.id, m.faceStart, m.faceCount])).toEqual([["a", 0, 7], ["b", 7, 6]]);
    vp.setModel(r2);
    expect(bodyOf(vp, "b").mesh === bMesh, "b should be reused, not rebuilt").toBe(true);

    const newFace = pixel(h, triangleCentre(a7(), 1));
    expect(hover(vp, newFace), "a's new face 6: hover lit the wrong body").toEqual(["a"]);
    expect(click(vp, newFace), "a's new face 6: the click lit the wrong body").toEqual(["a"]);
    expect(vp.getSelectedFaceIds()).toEqual([6]);

    const bFace = pixel(h, triangleCentre(b6(), 0));
    expect(click(vp, bFace)).toEqual(["b"]);
    expect(hits.at(-1), "b's +x face after the shift: the click reported the wrong face id").toBe(7);
    expect(vp.getSelectedFaceIds()).toEqual([7]);

    // body colours: a's face 6 wears a's colour, not the next body's
    vp.clearSelection();
    vp.setBodyPaint({ a: "#ff0000", b: "#0000ff" });
    expect(faceColour(bodyOf(vp, "a"), 6)).toBe("ff0000");
    expect(faceColour(bodyOf(vp, "b"), 7)).toBe("0000ff");
  });

  it("the stream: b is renumbered at begin, a's chunk paints in a's colour, and clicks after the commit land right", () => {
    const { vp, h, hits } = standIn();
    const cache = new Map<string, WireBodyFull>();
    vp.setModel(reply(cache, [a6(), b6()]));
    vp.setBodyPaint({ a: "#ff0000", b: "#0000ff" });
    const r2 = reply(cache, [a7(), bStub]);
    vp.beginProgressiveModel(2, r2.bodies!, r2, HEAD.bbox as RebuildResult["bbox"], [], false);
    expect(bodyOf(vp, "b").faceStart).toBe(7);
    expect([...bodyOf(vp, "b").faceTriangles.keys()].sort((x, y) => x - y)).toEqual([7, 8, 9, 10, 11, 12]);
    // picks are suppressed while the stream runs, so the chunk's paint is the effect here
    vp.appendProgressiveBodies(2, r2, [r2.bodies![0]!], new Map(), { triStart: 0, triEnd: 12 }, []);
    expect(faceColour(bodyOf(vp, "a"), 6)).toBe("ff0000");
    vp.setModel(r2);
    expect(faceColour(bodyOf(vp, "a"), 6)).toBe("ff0000");
    expect(click(vp, pixel(h, triangleCentre(a7(), 1)))).toEqual(["a"]);
    expect(click(vp, pixel(h, triangleCentre(b6(), 0)))).toEqual(["b"]);
    expect(hits).toEqual([6, 7]);
  });

  it("back down: open with the extra face, then lose it (suppressing the fillet)", () => {
    const { vp, h, hits } = standIn();
    const cache = new Map<string, WireBodyFull>();
    vp.setModel(reply(cache, [a7(), b6()]));
    vp.setModel(reply(cache, [a6(), bStub]));
    expect(click(vp, pixel(h, triangleCentre(b6(), 0)))).toEqual(["b"]);
    expect(click(vp, pixel(h, triangleCentre(a6(), 0)))).toEqual(["a"]);
    expect(hits, "b's +x face should report 6 once a is back to six faces").toEqual([6, 0]);
  });

  it("GUARD: the same etag with a different face count is rebuilt, never reused", () => {
    const { vp } = standIn();
    const cache = new Map<string, WireBodyFull>();
    vp.setModel(reply(cache, [a6(), b6()]));
    const bMesh = bodyOf(vp, "b").mesh;
    // b's payload claims the old etag but carries five faces
    const b5 = cube("b", "b-1", B, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4]);
    vp.setModel(reply(cache, [a6(), b5]));
    expect(bodyOf(vp, "b").mesh === bMesh, "b was reused with a stale face count").toBe(false);
    expect(bodyOf(vp, "b").faceCount).toBe(5);
  });
});
