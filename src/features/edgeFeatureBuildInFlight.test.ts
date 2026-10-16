// Fillet/Chamfer opened while a rebuild is still running.
//
// Since b484650 the tool picks from a frozen snapshot of the edges it blends
// (blendInputEdges.ts), not from the live model. The snapshot is the model on
// screen, and while a build runs that is the OUTGOING model: the viewport only
// takes a settled build. Two ways in, both found driving the real app:
//
// - Fillet started while a chamfer just added was still building: after the
//   build landed, the chamfer's own edges could not be picked and the edge it
//   consumed still could, storing a point that ties between two edges on the
//   new body.
// - Double-clicking a committed fillet while a rebuild ran: the tool took the
//   in-flight build's settle (the OLD document, with the fillet still in it)
//   for its roll-back, so no saved edge got a ghost and the fillet's own
//   generated edges became the pickable set.
//
// Driven through the REAL DocumentStore over a backend whose replies the test
// releases one at a time, with a viewport that swaps its model on a settled
// build the way main.ts's bridge does (and is subscribed before the tool, as
// it is at boot). Pointer input goes through the tool's own listeners and the
// real Picker over the sidecar's display edges (blendPickFixtures.json).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import { BodyEdges } from "../viewport/edgeLines";
import { Picker } from "../viewport/picking";
import { edgeSelectorFrom, midMatchTol, nearestEdgeByMid, polylineMid, type Vec3 } from "../viewport/edgeMatch";
import { DocumentStore } from "../document/store";
import { t } from "../i18n";
import type { GeometryBackend } from "../geometry/client";
import type { Viewport } from "../viewport/viewport";
import type { CadDocument, Feature, RebuildReply, Selector } from "../types";
import fixtures from "./blendPickFixtures.json";

const promptEl = new FakeEl("div");
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeEl(tag),
  body: new FakeEl("body"),
  getElementById: (id: string) => (id === "prompt" ? promptEl : null),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 1;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

// imported after the globals above: EdgeFeatureTool constructs a DimInput at
// field-initialisation time, which appends to document.body.
const { EdgeFeatureTool } = await import("./edgeFeatureTool");

type Edge = { id: string; body: string; points: Vec3[] };
interface Case { name: string; input: Edge[]; preview: Edge[]; first: Vec3; expectedFirst: number[] }
// A 1 mm chamfer on the frame's inside top edge: `input` is the body before it,
// `preview` the body after it. `first` is the edge the chamfer consumes.
const c = (fixtures as unknown as { cases: Case[] }).cases.find((x) => x.name.startsWith("frame: chamfer an inside edge"))!;
const BEFORE = c.input;
const AFTER = c.preview;
const sameEdge = (a: Edge, b: Edge) =>
  a.points.length === b.points.length && a.points.every((p, i) => p.every((v, k) => v === b.points[i]![k]));
const CONSUMED = c.first; // only on the body before the chamfer
// an edge the chamfer generated, on the body after it only
const GENERATED: Vec3 = [0, -31, 27.200000762939453];
const onlyAfter = (points: Vec3[]) =>
  AFTER.some((e) => sameEdge(e, { id: "", body: "", points })) && !BEFORE.some((e) => sameEdge(e, { id: "", body: "", points }));

const W = 1200;
const H = 900;
const RECT = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect;

const CHAMFER: Feature = { id: "c1", type: "chamfer", edges: [edgeSelectorFrom(BEFORE[9]!)!], distance: 1 } as Feature;

/** The real store over a backend that holds every reply until released. The
 *  "geometry" is which side of the chamfer the sent document is on. */
function rig(features: Feature[]) {
  const requests: { features: string[]; release: () => void }[] = [];
  const backend = {
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    rebuild(doc: CadDocument) {
      const ids = doc.features.map((f) => f.id);
      return new Promise<RebuildReply>((resolve) => {
        requests.push({
          features: ids,
          release: () =>
            resolve({
              ok: true,
              result: {
                mesh: { positions: [], indices: [], faceIds: [] },
                edges: [],
                bbox: { min: [-50, -50, 0], max: [50, 50, 30] },
                bodies: [],
                // what main.ts's bridge would draw: tagged here, read below
                blended: ids.some((id) => id === "c1" || id === "f9"),
              } as unknown as Extract<RebuildReply, { ok: true }>["result"],
            }),
        });
      });
    },
    async cancel() { return true; },
    connected: true,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(backend, { parameters: {}, features } as unknown as CadDocument);

  const handlers: Record<string, (e: unknown) => void> = {};
  const el = {
    style: { cursor: "" },
    clientWidth: W,
    clientHeight: H,
    addEventListener(type: string, cb: (e: unknown) => void) { handlers[type] = cb; },
    removeEventListener() {},
  };
  const resolution = new THREE.Vector2(W, H);
  const beforeDraw = new BodyEdges(BEFORE, resolution);
  const afterDraw = new BodyEdges(AFTER, resolution);
  let shown: BodyEdges | null = null;
  // main.ts's bridge, subscribed at boot and so ahead of any tool: only a
  // SETTLED build replaces the model on screen
  store.onBuild((s) => {
    if (s.result && !s.building) shown = (s.result as unknown as { blended: boolean }).blended ? afterDraw : beforeDraw;
  });

  // 25 mm from the chamfer, so its 1 mm offset is ~40 px on screen, well
  // outside the edge grab radius: a click says WHICH edge, not just "an edge"
  const target = new THREE.Vector3(0, -30.5, 26.7);
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100000);
  camera.position.copy(target).add(new THREE.Vector3(-0.55, -1, 0.9).normalize().multiplyScalar(25));
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const toScreen = (v: THREE.Vector3) => {
    const p = v.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
  };
  const picker = new Picker();
  const viewport = {
    camera,
    domElement: el,
    suspendPicking: false,
    clearHover() {},
    requestRender() {},
    addToScene() {},
    removeFromScene() {},
    addEdgeOverlay: (o: BodyEdges[]) => o.forEach((d) => d.setResolution(resolution)),
    selectedEdgeSelectors: () => [],
    projectToScreen: toScreen,
    pixelWorldSize: () => 1,
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(1e7, 1e7, 1e7), new THREE.Vector3(0, 0, 1)),
    visibleEdgeLines: () => shown?.visibleRefs() ?? [],
    pickEdgeOn: (x: number, y: number, o: BodyEdges[]) => picker.pickEdgeOn(x, y, RECT, camera, o.map((d) => d.object)),
    edgeLineByMid: (mid: Vec3) => {
      const refs = shown?.refs ?? [];
      const i = nearestEdgeByMid(refs, mid, midMatchTol(100));
      return i == null ? null : refs[i];
    },
  } as unknown as Viewport;

  const pointer = (type: string, world: Vec3) => {
    const s = toScreen(new THREE.Vector3(...world));
    handlers[type]?.({
      button: 0, clientX: s.x, clientY: s.y, shiftKey: false, ctrlKey: false, metaKey: false,
      preventDefault() {}, stopImmediatePropagation() {},
    });
  };
  const tool = new EdgeFeatureTool(viewport, store);
  return {
    store,
    tool,
    requests,
    click: (w: Vec3) => pointer("pointerdown", w),
    cursorAt: (w: Vec3) => (pointer("pointermove", w), el.style.cursor),
    ghosts: () => (tool as unknown as { ghosts: { sel: Selector; points: Vec3[] }[] }).ghosts,
    /** let the store's awaits after a released reply run */
    settle: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); },
  };
}

const pickPrompt = () => t("feature.edge.pick.fillet");
const prompt = () => promptEl.textContent;

describe("Fillet started while the build of an added chamfer is still running", () => {
  it("picks from the model that build lands, not from the one it replaces", async () => {
    const h = rig([]);
    void h.store.rebuildNow();
    h.requests[0]!.release();
    await h.settle();

    h.store.addFeature(CHAMFER); // its build starts at once and is still running...
    expect(h.store.buildState.building, "precondition: a build is in flight").toBe(true);
    h.tool.start("fillet", () => {}); // ...when the user presses F

    // during the build: the outgoing model offers nothing to click
    expect(h.cursorAt(CONSUMED), "an edge of the outgoing model looked clickable").toBe("default");
    h.click(CONSUMED);
    expect(h.ghosts(), "a click during the build picked an edge of the outgoing model").toEqual([]);
    expect(h.requests.length, "a click during the build started a preview").toBe(2);
    expect(prompt()).toBe(t("feature.edge.waitForBuild"));

    h.requests[1]!.release();
    await h.settle();
    expect(prompt(), "the pick prompt comes back once the build lands").toBe(pickPrompt());
    expect(h.cursorAt(CONSUMED), "the edge the chamfer consumed is still pickable").toBe("default");
    expect(h.cursorAt(GENERATED), "the chamfer's own edge is not pickable").toBe("pointer");

    h.click(GENERATED);
    const g = h.ghosts();
    expect(g.length, "the click on the chamfer's edge selected nothing").toBeGreaterThan(0);
    for (const m of g) expect(onlyAfter(m.points), "a member is not an edge of the chamfered body").toBe(true);
    const clicked = g[0]!;
    expect((clicked.sel as { point: Vec3 }).point).toEqual(polylineMid(clicked.points));
    expect(h.requests.at(-1)!.features, "the click put a fillet preview up").toContain("c1");
    expect(h.requests.length).toBe(3);
  });

  it("CONTROL: started with nothing building, the model on screen is pickable at once", async () => {
    const h = rig([CHAMFER]);
    void h.store.rebuildNow();
    h.requests[0]!.release();
    await h.settle();
    h.tool.start("fillet", () => {});
    expect(prompt()).toBe(pickPrompt());
    expect(h.cursorAt(GENERATED)).toBe("pointer");
    expect(h.cursorAt(CONSUMED)).toBe("default");
  });

  it("a build that starts under the open tool hands the pick over to the model it lands", async () => {
    const h = rig([]);
    void h.store.rebuildNow();
    h.requests[0]!.release();
    await h.settle();
    h.tool.start("fillet", () => {});
    expect(h.cursorAt(CONSUMED), "precondition: the body before the chamfer is pickable").toBe("pointer");
    h.store.addFeature(CHAMFER);
    expect(h.cursorAt(CONSUMED)).toBe("default");
    h.requests[1]!.release();
    await h.settle();
    expect(h.cursorAt(GENERATED)).toBe("pointer");
    expect(h.cursorAt(CONSUMED)).toBe("default");
    expect(prompt()).toBe(pickPrompt());
  });
});

describe("re-opening a committed fillet while a rebuild is in flight", () => {
  const FILLET: Feature = { id: "f9", type: "fillet", edges: [edgeSelectorFrom(BEFORE[9]!)!], radius: 1 } as Feature;

  async function open(raced: boolean) {
    const h = rig([FILLET]);
    void h.store.rebuildNow();
    h.requests[0]!.release(); // the committed fillet is on screen
    await h.settle();
    if (raced) void h.store.rebuildNow(); // some edit's rebuild, still running
    expect(h.tool.startEdit("f9", () => {}), "precondition: the edit opened").toBe(true);
    return h;
  }

  it("waits for the roll-back, then ghosts the saved edge on the model before the fillet", async () => {
    const h = await open(true);
    h.requests[1]!.release(); // the in-flight build settles first, with the fillet still in it
    await h.settle();
    expect(h.ghosts(), "the edit seeded from the build that was already running").toEqual([]);
    expect(prompt(), "the edit left 'rolling back' before the roll-back landed").toBe(t("feature.rollingBack"));
    const rollBack = h.requests[2]!;
    expect(rollBack.features, "precondition: the next build is the roll-back").not.toContain("f9");

    rollBack.release();
    await h.settle();
    const drawn = h.ghosts().map((g) => BEFORE.findIndex((e) => sameEdge(e, { id: "", body: "", points: g.points })));
    expect(drawn, "the saved edge has no ghost").toEqual(c.expectedFirst);
    expect(h.cursorAt(GENERATED), "the fillet's own generated edge is pickable in its edit").toBe("default");
    expect(h.requests.at(-1)!.features, "the edit pushed its preview").toContain("f9");
  });

  it("CONTROL: nothing in flight, the first settle is the roll-back", async () => {
    const h = await open(false);
    expect(h.requests[1]!.features).not.toContain("f9");
    h.requests[1]!.release();
    await h.settle();
    expect(h.ghosts().length).toBe(c.expectedFirst.length);
    expect(h.requests.at(-1)!.features).toContain("f9");
  });
});
