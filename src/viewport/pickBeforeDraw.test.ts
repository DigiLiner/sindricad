// A pick must find what is on screen even when no frame has been drawn since it
// got there.
//
// The render loop draws on demand, in an animation frame, and three hit-tests
// the world matrix that only a draw refreshes. So an object added or moved
// since the last frame was tested where it used to be: a datum plane's quad at
// the origin, and the Section arrow at the origin too, because the tool placed
// it in its first tick, one frame after start(). CI runners that held frames
// back failed exactly there: the Section arrow drag read 20 (run 250) and "a
// ray at the plane hits it" came back null (run 233). The e2e specs now wait
// for drawn frames; these tests hold the APP to it, with no frame drawn at all.
//
// WHAT THIS OBSERVES: the real setDatumPlanes + pickDatumAt, and the real
// SectionTool's pointer handlers driven by pointer events at the arrow's screen
// position, with the real Viewport.rayFrom behind them. Nothing renders and no
// animation frame runs. A real Viewport needs WebGL, so the viewport methods
// run against a stand-in `this` (the datumHoverInModelView.test.ts pattern);
// the source checks at the end tie the stand-in's raycaster to the one the
// viewport and the picker really construct.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { Viewport } from "./viewport";
import { PickRaycaster } from "./pickRaycaster";
import { SectionTool } from "../features/sectionTool";
import viewportSrc from "./viewport.ts?raw";
import pickingSrc from "./picking.ts?raw";

vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

installFakeDocument();
class FakeInput extends FakeEl {}
const doc = globalThis.document as unknown as { createElement: (tag: string) => FakeEl; body: FakeEl };
doc.createElement = (tag: string) => (tag === "input" ? new FakeInput(tag) : new FakeEl(tag));
vi.stubGlobal("HTMLInputElement", FakeInput);
vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
// Frames are queued and never run: every pick below happens before the first.
let frames: FrameRequestCallback[] = [];
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
vi.stubGlobal("cancelAnimationFrame", () => {});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  frames = [];
  doc.body.children.length = 0;
});

const W = 1000;
const H = 700;
const RECT = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };

/** The viewport fields rayFrom reads, around a real camera. */
function viewportWith(camera: THREE.Camera) {
  const vp = Object.create(Viewport.prototype) as Record<string, unknown>;
  Object.assign(vp, {
    canvas: { getBoundingClientRect: () => RECT },
    ndc: new THREE.Vector2(),
    sharedRaycaster: new PickRaycaster(),
    rig: { active: camera },
  });
  return vp;
}

function toScreen(p: THREE.Vector3, camera: THREE.Camera) {
  const n = p.clone().project(camera);
  return { x: ((n.x + 1) / 2) * W, y: ((1 - n.y) / 2) * H };
}

describe("a datum plane is pickable the moment it is laid out", () => {
  it("before any frame draws it", () => {
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 5000);
    camera.position.set(100, 0, 400);
    camera.lookAt(100, 0, 0);
    camera.updateMatrixWorld(true);
    const scene = new THREE.Scene();
    const datumGroup = new THREE.Group();
    scene.add(datumGroup);
    const vp = viewportWith(camera) as Record<string, unknown> & Viewport;
    Object.assign(vp, { datumGroup, datumQuads: [], model: null, selectedDatum: null, hoveredDatum: null });

    // A plane 100 mm off to the side: its quad is 80 mm across, so wherever
    // it was before it was placed (the origin) is nowhere near the cursor.
    vp.setDatumPlanes([{ id: "f7", origin: [100, 0, 30], normal: [0, 0, 1] }] as never);
    const at = toScreen(new THREE.Vector3(100, 0, 30), camera);
    expect(vp.pickDatumAt(at.x, at.y)).toBe("f7");

    // ...and re-laid somewhere else (an edit moved it), still before a frame.
    vp.setDatumPlanes([{ id: "f7", origin: [100, 60, 30], normal: [0, 0, 1] }] as never);
    const moved = toScreen(new THREE.Vector3(100, 60, 30), camera);
    expect(vp.pickDatumAt(moved.x, moved.y)).toBe("f7");
  });
});

describe("the Section arrow can be grabbed the moment the tool starts", () => {
  // The model sits away from the origin, so an arrow left at the origin is
  // nowhere near the one on screen.
  const MODEL = new THREE.Box3(new THREE.Vector3(40, -20, -5), new THREE.Vector3(80, 20, 15));

  function harness() {
    // a front view: looking along +Y at the model's centre
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 5000);
    camera.position.set(60, -300, 5);
    camera.lookAt(60, 0, 5);
    camera.updateMatrixWorld(true);
    const raycasting = viewportWith(camera) as unknown as Viewport;
    let clip: THREE.Plane | null = null;
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const vp = {
      camera,
      modelBox: () => MODEL,
      setClipPlane(p: THREE.Plane | null) {
        clip = p;
      },
      get clipped() {
        return !!clip;
      },
      requestRender() {},
      projectToScreen: (p: THREE.Vector3) => toScreen(p, camera),
      pixelWorldSize: () => 0.5,
      snapStep: () => 1,
      domElement: {
        style: {} as Record<string, string>,
        addEventListener(type: string, fn: (e: unknown) => void) {
          (listeners[type] ??= []).push(fn);
        },
        removeEventListener(type: string, fn: (e: unknown) => void) {
          const list = listeners[type] ?? [];
          if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
        },
        getBoundingClientRect: () => RECT,
      },
      addToScene: (o: THREE.Object3D) => new THREE.Scene().add(o),
      removeFromScene: (o: THREE.Object3D) => o.removeFromParent(),
      rayFrom: (x: number, y: number) => raycasting.rayFrom(x, y),
    };
    const tool = new SectionTool(vp as never);
    const pointer = (type: string, p: { x: number; y: number }) => {
      let swallowed = false;
      const e = {
        button: 0,
        clientX: p.x,
        clientY: p.y,
        preventDefault() {},
        stopImmediatePropagation() {
          swallowed = true;
        },
      };
      for (const fn of [...(listeners[type] ?? [])]) fn(e);
      return swallowed;
    };
    return { tool, camera, pointer, cutAt: () => (clip ? -clip.constant : null) };
  }

  it("a press on the arrow takes hold of it, and the drag moves the cut", () => {
    const { tool, camera, pointer, cutAt } = harness();
    tool.start("Z");
    expect(cutAt()).toBeCloseTo(5, 6); // through the model's middle
    expect(frames.length, "no frame has run yet").toBeGreaterThan(0);

    // The arrow stands on the cut at (60, 0, 5), 0.5 mm per pixel: its shaft
    // runs 6..40 px up the axis. Press half way up it.
    const onShaft = toScreen(new THREE.Vector3(60, 0, 5 + 23 * 0.5), camera);
    expect(pointer("pointerdown", onShaft), "the press landed on the arrow").toBe(true);
    pointer("pointermove", { x: onShaft.x, y: onShaft.y - 40 }); // 20 mm up
    pointer("pointerup", { x: onShaft.x, y: onShaft.y - 40 });
    expect(cutAt()).toBeGreaterThan(15);
  });
});

describe("the raycasters a pick goes through bring their targets up to date", () => {
  it("the viewport's and the picker's", () => {
    expect(/sharedRaycaster = new PickRaycaster\(\)/.test(viewportSrc), "viewport.ts rayFrom").toBe(true);
    expect(/raycaster = new PickRaycaster\(\)/.test(pickingSrc), "picking.ts Picker").toBe(true);
  });

  it("an object moved since its matrices were last updated is hit where it is now", () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const parent = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial());
    parent.add(box);
    parent.updateMatrixWorld(true);
    parent.position.set(30, 0, 0); // a tool's gizmo group moves; its child is the target
    const ndc = new THREE.Vector2(...(() => {
      const n = new THREE.Vector3(30, 0, 0).project(camera);
      return [n.x, n.y] as const;
    })());

    const plain = new THREE.Raycaster();
    plain.setFromCamera(ndc, camera);
    expect(plain.intersectObjects([box], false), "the stale matrix: what the bug was").toHaveLength(0);

    const fresh = new PickRaycaster();
    fresh.setFromCamera(ndc, camera);
    expect(fresh.intersectObjects([box], false)).toHaveLength(1);
  });
});
