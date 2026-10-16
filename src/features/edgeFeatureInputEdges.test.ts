// Field reports e470c0e2, 6c2fc3ba, 55a4cca2 and 77f004a6: once a fillet or
// chamfer preview is up, the model on screen IS the blend, and the tool picked
// and walked its tangent chain over that. A click on, or a chain through, an
// edge the blend itself generated stored that edge's midpoint, which the
// sidecar resolves on the body BEFORE the blend, where the edge does not exist:
// it silently bound whatever unrelated edge was nearest (a full-height 45
// degree corner fill, a chamfer moving onto edges never clicked) or tied
// between two and failed the preview as "ambiguous edge reference".
//
// Driven through the tool's real pointer listeners, with the real Picker and
// real line objects over the sidecar's own display edges for each body and
// for the preview a first click produces (blendPickFixtures.json, from
// sidecar/tools/gen_blend_pick_fixtures.py). The fake viewport shows the
// preview from the moment the tool pushes one, as the store does. It serves
// both the old picking calls (the live model) and the new ones, so the same
// test runs against the code before the fix.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import { BodyEdges } from "../viewport/edgeLines";
import { Picker } from "../viewport/picking";
import { edgeSelectorFrom, midMatchTol, nearestEdgeByMid, polylineMid, type Vec3 } from "../viewport/edgeMatch";
import type { ModelView } from "../viewport/render";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { Feature, Selector } from "../types";
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
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 1;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

// imported after the globals above: EdgeFeatureTool constructs a DimInput at
// field-initialisation time, which appends to document.body.
const { EdgeFeatureTool } = await import("./edgeFeatureTool");

type Edge = { id: string; body: string; points: Vec3[] };
interface Case {
  name: string;
  input: Edge[];
  preview: Edge[];
  first: Vec3;
  second: Vec3;
  expectedFirst: number[];
  expectedSecond: number[];
  /** look at the second click from 40 mm away instead of framing the body */
  closeUp: boolean;
}
const cases = (fixtures as unknown as { cases: Case[] }).cases;

const W = 1200;
const H = 900;
const RECT = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect;

/** `edit`: re-open the first click's blend as a committed feature instead of
 *  creating it: the viewport starts on the committed model (blend applied),
 *  and `rollBack` delivers the build of the model before it. */
function harness(c: Case, edit = false) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const el = {
    style: { cursor: "" },
    clientWidth: W,
    clientHeight: H,
    addEventListener(type: string, cb: (e: unknown) => void) {
      handlers[type] = cb;
    },
    removeEventListener() {},
  };

  // what the viewport is showing: the body, then the live preview once pushed
  const resolution = new THREE.Vector2(W, H);
  const inputDraw = new BodyEdges(c.input, resolution);
  const previewDraw = new BodyEdges(c.preview, resolution);
  let shown = edit ? previewDraw : inputDraw;
  const view = () => ({ bodies: [], orphanEdges: shown }) as unknown as ModelView;
  const previews: (Feature | null)[] = [];
  const show = (f: Feature | null) => {
    previews.push(f);
    shown = f ? previewDraw : inputDraw;
  };
  const committed: Feature = {
    id: "f9",
    type: "fillet",
    edges: c.expectedFirst.map((i) => edgeSelectorFrom(c.input[i]!)!),
    radius: 1,
  } as Feature;
  let onBuild: ((s: unknown) => void) | null = null;
  const store = {
    document: { features: edit ? [committed] : [], parameters: [] },
    buildState: { result: null },
    nextId: () => "prev1",
    isParamBound: () => false,
    setPreview: show,
    beginEditPreview() {},
    setEditPreview: show,
    onBuild: (fn: (s: unknown) => void) => {
      onBuild = fn;
      return () => {};
    },
  } as unknown as DocumentStore;
  const rollBack = () => {
    shown = inputDraw;
    onBuild?.({ building: false, result: { featureErrors: [], diagnostics: [] } });
  };

  // an oblique view from the front left, far enough out to see the whole body
  const box = new THREE.Box3();
  for (const e of c.input) for (const p of e.points) box.expandByPoint(new THREE.Vector3(...p));
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100000);
  const target = c.closeUp ? new THREE.Vector3(...c.second) : centre;
  const distance = c.closeUp ? 40 : size * 1.6;
  camera.position.copy(target).add(new THREE.Vector3(-0.55, -1, 0.9).normalize().multiplyScalar(distance));
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
    // the drag handle is never under a click in these tests
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(1e7, 1e7, 1e7), new THREE.Vector3(0, 0, 1)),
    // the model on screen
    visibleEdgeLines: () => shown.visibleRefs(),
    pickEdgeOn: (x: number, y: number, o: BodyEdges[]) =>
      picker.pickEdgeOn(x, y, RECT, camera, o.map((d) => d.object)),
    // what the tool called before the fix, against the same model on screen
    emphasizeEdges() {},
    hoverEdge() {},
    pickEdgeAt: (x: number, y: number) => picker.pickEdge(x, y, RECT, camera, view()),
    edgeLineByMid: (mid: Vec3) => {
      const i = nearestEdgeByMid(shown.refs, mid, midMatchTol(size));
      return i == null ? null : shown.refs[i];
    },
  } as unknown as Viewport;

  const tool = new EdgeFeatureTool(viewport, store);
  if (edit) expect(tool.startEdit("f9", () => {}), "precondition: the edit opened").toBe(true);
  else tool.start("fillet", () => {});
  const click = (world: Vec3) => {
    const s = toScreen(new THREE.Vector3(...world));
    handlers["pointerdown"]?.({
      button: 0,
      clientX: s.x,
      clientY: s.y,
      shiftKey: false,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  };
  const ghosts = () => (tool as unknown as { ghosts: { sel: Selector; points: Vec3[] }[] }).ghosts;
  return { click, ghosts, previews, rollBack };
}

/** The input edge a member's DRAWN line is, or -1 when it is not one. */
function drawnAs(c: Case, points: Vec3[]): number {
  return c.input.findIndex(
    (e) => e.points.length === points.length && e.points.every((p, i) => p.every((v, k) => v === points[i]![k])),
  );
}

/** The input edge a member's SELECTOR binds, as the sidecar resolves
 *  by:"nearest" on the body before the blend (geom_select.py: least distance to
 *  each edge's centre), or -2 when two edges tie for it (the sidecar refuses
 *  that as an ambiguous reference). */
function boundTo(c: Case, sel: Selector): number {
  const p = (sel as { point: Vec3 }).point;
  const d = c.input
    .map((e, i) => ({ i, d: Math.hypot(...(polylineMid(e.points)!.map((v, k) => v - p[k]!) as Vec3)) }))
    .sort((a, b) => a.d - b.d);
  if (d.length > 1 && d[1]!.d - d[0]!.d < 1e-3) return -2;
  return d[0]!.i;
}

/** The second click, and what every member then binds. */
function expectSecondClick(c: Case, h: ReturnType<typeof harness>) {
  h.click(c.second);
  const members = h.ghosts().map((g) => ({ drawn: drawnAs(c, g.points), bound: boundTo(c, g.sel) }));
  const bound = members.map((m) => m.bound).sort((a, b) => a - b);
  if (c.expectedSecond.length) {
    expect(bound, "the edges the feature will actually blend").toEqual(c.expectedSecond);
  } else {
    expect(members.length, "the click on the generated edge added an edge").toBe(c.expectedFirst.length + 1);
  }
  for (const m of members) {
    expect(m.bound, "every stored point binds an edge, without a tie").toBeGreaterThanOrEqual(0);
    expect(m.drawn, "the line drawn for a member is the edge it binds").toBe(m.bound);
  }
}

const sortedDrawn = (c: Case, h: ReturnType<typeof harness>) =>
  h.ghosts().map((g) => drawnAs(c, g.points)).sort((a, b) => a - b);

describe("fillet/chamfer picks only the edges the blend is made from, not its live preview", () => {
  for (const c of cases) {
    it(c.name, () => {
      const h = harness(c);
      h.click(c.first);
      expect(h.previews.at(-1), "precondition: the first click put a preview up").toBeTruthy();
      expect(sortedDrawn(c, h), "the first click lands on the body itself, before any preview").toEqual(
        c.expectedFirst,
      );
      expectSecondClick(c, h);
    });
  }
});

describe("re-opening a committed fillet picks from the model before it", () => {
  for (const c of cases) {
    it(c.name, () => {
      const h = harness(c, true);
      // the committed blend is still on screen until the rolled-back build lands
      h.click(c.second);
      expect(h.ghosts(), "nothing is pickable before the model before the feature arrives").toEqual([]);
      h.rollBack();
      expect(h.previews.at(-1), "precondition: the edit pushed its preview").toBeTruthy();
      expect(sortedDrawn(c, h), "the saved edges, matched on the model before the feature").toEqual(
        c.expectedFirst,
      );
      expectSecondClick(c, h);
    });
  }
});
