// Showing all sketches, and any Bodies-eye click while sketches are shown,
// blocked the UI for 40-130 ms on 15-20 sketches (tracker 6660a646, promised on
// GH #41 as "the show/hide-all lag"). Every SketchOverlay.update() threw away
// every sketch's curves and fills and rebuilt them all: Line2 per entity,
// region detection, a ShapeGeometry per region. A visibility toggle changes
// nothing a sketch draws, so it must hand back the SAME objects it built
// before, and an edited sketch must never come back stale.
//
// The harness enters where the click does, as far as node allows: a real
// DocumentStore, the Browser's own groupVisibilityToggle, then
// store.setSketchesVisibility + overlay.update (main.ts's
// onSetSketchesVisibility verbatim), and the Bodies eye through
// store.setBodiesVisibility -> onBuild -> overlay.update.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

vi.mock("./region", async (orig) => {
  const m = await orig<typeof import("./region")>();
  return { ...m, detectRegions: vi.fn(m.detectRegions) };
});

import { detectRegions } from "./region";
import { SketchOverlay, SELECT_COLOR, type WorldRegion } from "./overlay";
import { DocumentStore } from "../document/store";
import { groupVisibilityToggle } from "../ui/browserTree";
import type { CadDocument, Feature, PlaneDef, RebuildReply } from "../types";
import type { GeometryBackend } from "../geometry/client";

const noBackend = (): GeometryBackend => ({
  async rebuild(): Promise<RebuildReply> {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus: () => () => {},
  connected: true,
}) as unknown as GeometryBackend;

type Sketch = Extract<Feature, { type: "sketch" }>;

/** A mix that exercises every drawing path: crossing rectangle and circles
 *  (planarized regions), polygon, slot, a line+arc D, a point, a spline. The
 *  circles and the arc draw as GROUPS with a nested centre marker, so a
 *  dispose that only walks the top level misses geometry. */
function cell(tag: string, ox: number, oy: number): Sketch["entities"] {
  return [
    { id: `${tag}r`, type: "rectangle", x: ox, y: oy, width: 20, height: 12 },
    { id: `${tag}c1`, type: "circle", x: ox + 20, y: oy + 6, radius: 5 },
    { id: `${tag}c2`, type: "circle", x: ox + 40, y: oy + 6, radius: 3 },
    { id: `${tag}p`, type: "polygon", x: ox + 55, y: oy + 6, radius: 5, sides: 6, angle: 0 },
    { id: `${tag}s`, type: "slot", x1: ox + 70, y1: oy + 6, x2: ox + 80, y2: oy + 6, width: 4 },
    { id: `${tag}l`, type: "line", x1: ox + 90, y1: oy, x2: ox + 90, y2: oy + 12 },
    { id: `${tag}a`, type: "arc", x1: ox + 90, y1: oy, x2: ox + 90, y2: oy + 12, mx: ox + 96, my: oy + 6 },
    { id: `${tag}pt`, type: "point", x: ox + 100, y: oy },
    { id: `${tag}sp`, type: "spline", points: [{ x: ox + 105, y: oy }, { x: ox + 110, y: oy + 8 }, { x: ox + 115, y: oy }] },
  ];
}

function makeDoc(): CadDocument {
  return {
    parameters: { w: 20 },
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: cell("a", 0, 0) },
      {
        id: "s2", type: "sketch", plane: "XY",
        entities: [...cell("b", 0, 40), { id: "bw", type: "rectangle", x: 0, y: 80, width: "w", height: 6 }],
      },
      { id: "s3", type: "sketch", plane: "XZ", entities: cell("c", 0, 0) },
      { id: "d1", type: "datumPlane", plane: "XY", offset: 5 },
      { id: "s4", type: "sketch", plane: "XY", planeId: "d1", entities: cell("d", 0, 0) },
    ],
  } as unknown as CadDocument;
}

// SketchOverlay keeps these private; the test reads them the way the
// pickers and the scene do.
type Peek = {
  committed: THREE.Group;
  fills: THREE.Group;
  committedSketches: { sketchId: string }[];
};
const peek = (o: SketchOverlay) => o as unknown as Peek;

/** Every geometry under these objects, nested ones included. */
function geometriesOf(objs: readonly THREE.Object3D[]): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const o of objs) {
    o.traverse((c) => {
      const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g) out.push(g);
    });
  }
  return out;
}

/** Counts dispose() on every geometry the overlay currently draws. */
function armDispose(o: SketchOverlay) {
  const disposed = new Set<THREE.BufferGeometry>();
  const objs = [...peek(o).committed.children, ...peek(o).fills.children];
  const geos = geometriesOf(objs);
  for (const g of geos) g.addEventListener("dispose", () => disposed.add(g));
  return { geos, disposed };
}

function sketchObjects(o: SketchOverlay, sketchId: string): THREE.Object3D[] {
  return [
    ...peek(o).committed.children.filter((c) => c.userData.sketchId === sketchId),
    ...o.regions.filter((r) => r.sketchId === sketchId).map((r) => r.fill!),
  ];
}

/** What a frame draws, by identity: every curve object and fill, and their geometries. */
function snapshot(o: SketchOverlay) {
  const curves = [...peek(o).committed.children];
  const fills = o.regions.map((r) => r.fill!);
  return {
    curves,
    curveGeos: curves.map((c) => (c as THREE.Mesh).geometry ?? null),
    fills,
    fillGeos: fills.map((f) => f.geometry),
    regionSketches: o.regions.map((r) => r.sketchId),
    sketches: peek(o).committedSketches.map((s) => s.sketchId),
  };
}

function harness(doc = makeDoc()) {
  const store = new DocumentStore(noBackend(), doc);
  const overlay = new SketchOverlay();
  overlay.sketchVisible = (id) => store.sketchVisibilityOverride(id) ?? true;
  const sketchIds = () => store.document.features.filter((f) => f.type === "sketch").map((f) => f.id);
  let snap: Map<string, boolean> | null = null;
  // main.ts tree.onSetSketchesVisibility, after the Browser computed the batch
  const toggleAllSketches = () => {
    const r = groupVisibilityToggle(sketchIds(), overlay.sketchVisible, snap);
    snap = r.snapshot;
    store.setSketchesVisibility(r.next);
    overlay.update(store.document);
  };
  // main.ts's onBuild repaint, reached by the visibility-only emit of the Bodies eye
  store.onBuild((s) => {
    if (!s.building) overlay.update(store.document);
  });
  const setBodyVisible = (on: boolean) => store.setBodiesVisibility(new Map([["b1", on]]));
  overlay.update(store.document);
  return { store, overlay, toggleAllSketches, setBodyVisible };
}

/** Swap one sketch's entities (or any feature field) the way an edit does:
 *  a new feature object in a new document. */
function edit(store: DocumentStore, id: string, patch: Partial<Feature>) {
  const doc = store.document;
  const next = {
    ...doc,
    features: doc.features.map((f) => (f.id === id ? ({ ...f, ...patch } as Feature) : f)),
  };
  (store as unknown as { doc: CadDocument }).doc = next;
}

const detectCalls = () => vi.mocked(detectRegions).mock.calls.length;

beforeEach(() => {
  vi.mocked(detectRegions).mockClear();
});

describe("Sketches eye: hide all then show all reuses what was built", () => {
  it("hiding draws nothing and disposes nothing; showing hands back the same objects", () => {
    const { overlay, toggleAllSketches } = harness();
    const before = snapshot(overlay);
    expect(before.sketches).toEqual(["s1", "s2", "s3", "s4"]);
    expect(before.fills.length).toBeGreaterThan(20);
    const detect0 = detectCalls();
    const { geos, disposed } = armDispose(overlay);
    expect(geos.length).toBeGreaterThan(before.curves.length); // nested geometries exist

    toggleAllSketches(); // hide all
    expect(overlay.regions).toHaveLength(0);
    expect(peek(overlay).committed.children).toHaveLength(0);
    expect(peek(overlay).fills.children).toHaveLength(0);
    expect(peek(overlay).committedSketches).toHaveLength(0);
    expect(disposed.size).toBe(0);

    toggleAllSketches(); // show all
    const after = snapshot(overlay);
    expect(after.curves.length).toBe(before.curves.length);
    after.curves.forEach((c, i) => expect(c).toBe(before.curves[i]));
    after.curveGeos.forEach((g, i) => expect(g).toBe(before.curveGeos[i]));
    expect(after.fills.length).toBe(before.fills.length);
    after.fills.forEach((f, i) => expect(f).toBe(before.fills[i]));
    after.fillGeos.forEach((g, i) => expect(g).toBe(before.fillGeos[i]));
    expect(after.regionSketches).toEqual(before.regionSketches); // document order
    expect(after.sketches).toEqual(["s1", "s2", "s3", "s4"]);
    expect(peek(overlay).fills.children).toHaveLength(before.fills.length);
    expect(detectCalls()).toBe(detect0);
    expect(disposed.size).toBe(0);
  });

  it("the Bodies eye with sketches shown rebuilds nothing", () => {
    const { overlay, setBodyVisible } = harness();
    const before = snapshot(overlay);
    const detect0 = detectCalls();
    const { disposed } = armDispose(overlay);

    setBodyVisible(false);
    setBodyVisible(true);

    const after = snapshot(overlay);
    after.curves.forEach((c, i) => expect(c).toBe(before.curves[i]));
    after.fills.forEach((f, i) => expect(f).toBe(before.fills[i]));
    expect(after.fills.length).toBe(before.fills.length);
    expect(detectCalls()).toBe(detect0);
    expect(disposed.size).toBe(0);
  });

  it("shown again after a hide is at least four times faster than a cold build", () => {
    const sketches: Feature[] = [];
    for (let i = 0; i < 10; i++) {
      const ents = [0, 1, 2, 3, 4].flatMap((k) => cell(`k${i}_${k}_`, 0, k * 25));
      sketches.push({ id: `s${i}`, type: "sketch", plane: "XY", entities: ents } as Feature);
    }
    const doc = { parameters: {}, features: sketches } as unknown as CadDocument;
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1]!;
    const cold: number[] = [];
    for (let i = 0; i < 3; i++) {
      const o = new SketchOverlay();
      const t0 = performance.now();
      o.update(doc);
      cold.push(performance.now() - t0);
    }
    const { overlay, toggleAllSketches, store } = harness(doc);
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) {
      toggleAllSketches(); // hide
      const t0 = performance.now();
      toggleAllSketches(); // show
      warm.push(performance.now() - t0);
    }
    expect(overlay.regions.length).toBeGreaterThan(0);
    expect(store.document.features).toHaveLength(10);
    const c = median(cold), w = median(warm);
    expect(w < c / 4 || w < 5, `show after hide ${w.toFixed(1)} ms vs cold ${c.toFixed(1)} ms`).toBe(true);
  });
});

describe("an edited sketch is never shown stale", () => {
  it("moving one entity rebuilds that sketch only, and frees what it drew", () => {
    const { store, overlay, toggleAllSketches } = harness();
    const before = snapshot(overlay);
    const old2 = sketchObjects(overlay, "s2");
    const old2Geos = geometriesOf(old2);
    const { disposed } = armDispose(overlay);
    const detect0 = detectCalls();

    const s2 = store.document.features.find((f) => f.id === "s2") as Sketch;
    edit(store, "s2", {
      entities: s2.entities.map((e) => (e.id === "bl" ? { ...e, x1: 91, x2: 91 } : e)),
    } as Partial<Feature>);
    overlay.update(store.document);

    const new2 = sketchObjects(overlay, "s2");
    for (const o of new2) expect(old2).not.toContain(o);
    // every geometry the old drawing owned, nested ones included, was freed
    for (const g of old2Geos) expect(disposed.has(g)).toBe(true);
    expect(disposed.size).toBe(old2Geos.length);
    expect(detectCalls()).toBe(detect0 + 1);
    // the other three are the very same objects
    for (const id of ["s1", "s3", "s4"]) {
      const was = before.fills.filter((_, i) => before.regionSketches[i] === id);
      const now = overlay.regions.filter((r) => r.sketchId === id).map((r) => r.fill);
      now.forEach((f, i) => expect(f).toBe(was[i]));
    }
    // the moved line is drawn where the edit put it
    const line = peek(overlay).committed.children.find((c) => c.userData.entityId === "bl")!;
    const pts = (line.userData as { pts: THREE.Vector3[] }).pts;
    expect(pts[0]!.x).toBeCloseTo(91);

    // edit -> hide -> show shows the edit
    toggleAllSketches();
    toggleAllSketches();
    const again = peek(overlay).committed.children.find((c) => c.userData.entityId === "bl")!;
    expect(again).toBe(line);
    expect((again.userData as { pts: THREE.Vector3[] }).pts[0]!.x).toBeCloseTo(91);
  });

  it("an edit made while hidden is drawn when shown again", () => {
    const { store, overlay, toggleAllSketches } = harness();
    toggleAllSketches(); // hide
    const s1 = store.document.features.find((f) => f.id === "s1") as Sketch;
    edit(store, "s1", {
      entities: s1.entities.map((e) => (e.id === "al" ? { ...e, x1: 93, x2: 93 } : e)),
    } as Partial<Feature>);
    overlay.update(store.document); // the doc-change repaint, sketches still hidden
    toggleAllSketches(); // show
    const line = peek(overlay).committed.children.find((c) => c.userData.entityId === "al")!;
    expect((line.userData as { pts: THREE.Vector3[] }).pts[0]!.x).toBeCloseTo(93);
  });

  it("a parameter driving a sketch rebuilds that sketch only", () => {
    const { store, overlay } = harness();
    const before = snapshot(overlay);
    const detect0 = detectCalls();
    (store as unknown as { doc: CadDocument }).doc = {
      ...store.document,
      parameters: { ...store.document.parameters, w: 30 },
    };
    overlay.update(store.document);
    expect(detectCalls()).toBe(detect0 + 1);
    const bw = peek(overlay).committed.children.find((c) => c.userData.entityId === "bw")!;
    const xs = (bw.userData as { pts: THREE.Vector3[] }).pts.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30);
    for (const id of ["s1", "s3", "s4"]) {
      const was = before.fills.filter((_, i) => before.regionSketches[i] === id);
      const now = overlay.regions.filter((r) => r.sketchId === id).map((r) => r.fill);
      now.forEach((f, i) => expect(f).toBe(was[i]));
    }
    for (const f of overlay.regions.filter((r) => r.sketchId === "s2").map((r) => r.fill)) {
      expect(before.fills).not.toContain(f);
    }
  });

  it("a face-anchored sketch whose resolved plane moved is rebuilt on the new plane", () => {
    const { store, overlay } = harness();
    const planeA: PlaneDef = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const planeB: PlaneDef = { origin: [0, 0, 7], normal: [0, 0, 1], xdir: [1, 0, 0] };
    let resolved: Record<string, PlaneDef> = { s3: planeA };
    overlay.resolvedPlanes = () => resolved;
    overlay.update(store.document);
    const before = snapshot(overlay);
    const detect0 = detectCalls();
    resolved = { s3: planeB };
    overlay.update(store.document);
    expect(detectCalls()).toBe(detect0 + 1);
    const s3 = overlay.regions.filter((r) => r.sketchId === "s3");
    expect(s3.length).toBeGreaterThan(0);
    for (const r of s3) expect(r.interior3D.z).toBeCloseTo(7);
    for (const id of ["s1", "s2", "s4"]) {
      const was = before.fills.filter((_, i) => before.regionSketches[i] === id);
      const now = overlay.regions.filter((r) => r.sketchId === id).map((r) => r.fill);
      now.forEach((f, i) => expect(f).toBe(was[i]));
    }
  });

  it("a datum offset change (Inspector offset, Move sketch plane) moves the sketch on it", () => {
    const { store, overlay } = harness();
    const old4 = sketchObjects(overlay, "s4");
    const old4Geos = geometriesOf(old4);
    const { disposed } = armDispose(overlay);
    const detect0 = detectCalls();
    edit(store, "d1", { offset: 8 } as Partial<Feature>);
    overlay.update(store.document);
    expect(detectCalls()).toBe(detect0 + 1);
    for (const r of overlay.regions.filter((r) => r.sketchId === "s4")) expect(r.interior3D.z).toBeCloseTo(8);
    for (const g of old4Geos) expect(disposed.has(g)).toBe(true);
    expect(disposed.size).toBe(old4Geos.length);
  });

  it("a deleted sketch's geometry is freed, and the same sketch re-added is built fresh", () => {
    const { store, overlay } = harness();
    const s3 = store.document.features.find((f) => f.id === "s3")!;
    const old3 = sketchObjects(overlay, "s3");
    const old3Geos = geometriesOf(old3);
    const { disposed } = armDispose(overlay);
    (store as unknown as { doc: CadDocument }).doc = {
      ...store.document,
      features: store.document.features.filter((f) => f.id !== "s3"),
    };
    overlay.update(store.document);
    expect(overlay.regions.some((r) => r.sketchId === "s3")).toBe(false);
    for (const g of old3Geos) expect(disposed.has(g)).toBe(true);
    expect(disposed.size).toBe(old3Geos.length);

    (store as unknown as { doc: CadDocument }).doc = {
      ...store.document,
      features: [...store.document.features, s3],
    };
    const detect0 = detectCalls();
    overlay.update(store.document);
    expect(detectCalls()).toBe(detect0 + 1);
    for (const o of sketchObjects(overlay, "s3")) expect(old3).not.toContain(o);
  });

  it("a sketch with text is rebuilt every time, and its old drawing is freed", () => {
    // Glyph outlines land asynchronously and are not part of the document, so
    // a text sketch is never reused; it must not leak either.
    const doc = makeDoc();
    (doc.features[0] as Sketch).entities.push({ id: "tx", type: "text", text: "Hi", x: 0, y: -20, height: 5 });
    const { overlay, toggleAllSketches } = harness(doc);
    const count = () => peek(overlay).committed.children.length + peek(overlay).fills.children.length;
    const n0 = count();
    const old1 = sketchObjects(overlay, "s1");
    const old1Geos = geometriesOf(old1);
    const { disposed } = armDispose(overlay);
    overlay.update(doc);
    for (const o of sketchObjects(overlay, "s1")) expect(old1).not.toContain(o);
    for (const g of old1Geos) expect(disposed.has(g)).toBe(true);
    expect(count()).toBe(n0);
    // and hidden, the last drawing is freed rather than kept forever
    const kept = geometriesOf(sketchObjects(overlay, "s1"));
    const armed2 = new Set<THREE.BufferGeometry>();
    for (const g of kept) g.addEventListener("dispose", () => armed2.add(g));
    toggleAllSketches(); // hide
    toggleAllSketches(); // show
    for (const g of kept) expect(armed2.has(g)).toBe(true);
    expect(count()).toBe(n0);
  });
});

describe("selection colour across a hide and show", () => {
  const pick = (o: SketchOverlay): WorldRegion => o.regions.find((r) => r.sketchId === "s2")!;
  const hex = (wr: WorldRegion) => ((wr.fill!.material as THREE.MeshBasicMaterial).color.getHex());

  it("a selected area is still selected, and still drawn selected", () => {
    const { overlay, toggleAllSketches } = harness();
    const wr = pick(overlay);
    overlay.toggleRegionSelection(wr, false);
    const matSel = wr.fill!.material;
    expect(hex(wr)).toBe(SELECT_COLOR);
    toggleAllSketches();
    toggleAllSketches();
    expect(overlay.selectedRegions()).toContain(wr);
    expect(wr.fill!.material).toBe(matSel);
  });

  it("an area deselected while hidden comes back unselected", () => {
    const { overlay, toggleAllSketches } = harness();
    const wr = pick(overlay);
    overlay.toggleRegionSelection(wr, false);
    toggleAllSketches(); // hide
    overlay.clearRegionSelection();
    toggleAllSketches(); // show
    // the area drawn at that spot now, whichever object draws it
    const now = pick(overlay);
    const other = overlay.regions.find((r) => r.sketchId === "s1")!;
    expect(now.fill!.material).toBe(other.fill!.material);
    expect(hex(now)).not.toBe(SELECT_COLOR);
    expect(wr.interior3D.distanceTo(now.interior3D)).toBeLessThan(1e-9);
  });
});
