// "Keep sketch visible after Extrude" preference (report dbfbe70a): "Stop
// hiding the sketch every time I extrude... it could be a switch in
// 'preferences' in the future" (Paul Crabb, 0.1.244).
//
// Thomas's decision (triage dbfbe70a, by-design + needs_thomas): keep the
// MCAD-style auto-hide as the DEFAULT (unchanged), and add a preference that,
// when turned on, leaves a just-extruded sketch visible instead of
// re-hiding it. 6660a646 (show/hide-all lag) is a separate, deferred item —
// not touched here.
//
// This drives the REAL ExtrudeTool through a plain commit (no Start/End
// picks), the same harness shape as extrudeStartEnd.test.ts, with an
// in-memory localStorage so the preference functions (getKeepSketchVisible
// AfterExtrude / setKeepSketchVisibleAfterExtrude, extrudeTool.ts) read and
// write for real instead of silently no-op'ing (there is no localStorage in
// the vitest node environment by default).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchOverlay } from "../sketch/overlay";
import { setFieldParams, setUnit } from "../ui/units";
import type { CadDocument, Feature } from "../types";
import type { QueryResult } from "../geometry/client";

installFakeDocument();
(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeEl;
(globalThis as unknown as { Node: unknown }).Node ??= FakeEl;

class MemStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}
let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUnit("mm");
  setFieldParams(() => ({}));
});

const { ExtrudeTool, getKeepSketchVisibleAfterExtrude, setKeepSketchVisibleAfterExtrude } = await import("./extrudeTool");

const toScreen = (w: THREE.Vector3) => ({ x: 400 + 4 * w.x, y: 300 - 4 * w.z });

/** One sketch (s1, XY) with one profile region, nothing else — a plain
 *  extrude needs no Start/End picks at all. */
function doc(): CadDocument {
  return {
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: [{ id: "ra", type: "rectangle", x: -30, y: 0, width: 20, height: 20 }] },
    ],
    parameters: {},
  } as unknown as CadDocument;
}

function harness() {
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  body.children.length = 0;
  const d = doc();
  const overlay = new SketchOverlay();
  overlay.update(d);
  const scene = new THREE.Scene();
  const viewport = {
    suspendPicking: false,
    camera: new THREE.PerspectiveCamera(),
    pixelWorldSize: () => 0.25,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    projectToScreen: toScreen,
    tiltOffAxis: () => true,
    pointInSolid: (): boolean => false,
    pickEntity: (): unknown => null,
    pickFaceForPressPull: (): unknown => null,
    pickFacePlane: (): unknown => null,
    faceAnchor: (): unknown => null,
    pickVertexAt: (): unknown => null,
    planeHitsAt: (): { id: string; datum: boolean; distance: number }[] => [],
    datumPlaneOf: () => null,
    behindSurfaceAt: (): ((w: THREE.Vector3) => boolean) => () => false,
    showAllPlanes() {},
    hoverPlane() {},
    hoverFaceAt: () => null,
    hoverEdge() {},
    rayFrom: () => ({ ray: new THREE.Ray(new THREE.Vector3(-30, 0, 50), new THREE.Vector3(0, 0, -1)) }),
    clearHover() {},
    hoverDatum() {},
    domElement: {
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    },
  };
  const added: Feature[] = [];
  const visibilityCalls: { id: string; visible: boolean }[] = [];
  const store = {
    document: d,
    isParamBound: () => false,
    boundExpr: () => null,
    beginEditPreview() {},
    endEditPreview() {},
    setPreview: () => {},
    setEditPreview: () => {},
    buildState: {},
    hiddenBodyIds: () => [],
    nextId: () => "new1",
    addFeature: (f: Feature) => added.push(f),
    replaceFeature: (_id: string, f: Feature) => added.push(f),
    onBuild: () => () => {},
    setSketchVisibility: (id: string, visible: boolean) => visibilityCalls.push({ id, visible }),
    queryReferences: () => new Promise<QueryResult[]>(() => {}),
  };
  const tool = new ExtrudeTool(viewport as never, overlay, store as never);

  const panel = () => {
    const root = body.children.find((c) => c.className === "tool-panel extrude-panel");
    if (!root) throw new Error("the Extrude panel is not on the page");
    return root;
  };
  const ok = () => panel().children.find((c) => c.className === "tool-panel-buttons")!.children[0]!.dispatch("click");
  const create = () => {
    overlay.toggleRegionSelection(overlay.regions.find((wr) => wr.region.entityIds.includes("ra"))!, false);
    tool.start(() => {});
  };

  return { tool, store, added, visibilityCalls, create, ok };
}

describe("keep sketch visible after Extrude (dbfbe70a)", () => {
  it("the preference defaults to off (today's behaviour: re-hide on commit)", () => {
    expect(getKeepSketchVisibleAfterExtrude()).toBe(false);
  });

  it("default (preference off): committing a new extrude does NOT set a visibility override", () => {
    const h = harness();
    h.create();
    h.ok();
    expect(h.added).toHaveLength(1);
    expect(h.visibilityCalls, "the sketch falls back to the consumed-sketch default (hidden)").toEqual([]);
  });

  it("preference on: committing a NEW extrude keeps its sketch visible", () => {
    setKeepSketchVisibleAfterExtrude(true);
    const h = harness();
    h.create();
    h.ok();
    expect(h.added).toHaveLength(1);
    expect(h.visibilityCalls).toEqual([{ id: "s1", visible: true }]);
  });

  it("the preference round-trips through storage", () => {
    expect(getKeepSketchVisibleAfterExtrude()).toBe(false);
    setKeepSketchVisibleAfterExtrude(true);
    expect(getKeepSketchVisibleAfterExtrude()).toBe(true);
    setKeepSketchVisibleAfterExtrude(false);
    expect(getKeepSketchVisibleAfterExtrude()).toBe(false);
  });
});
