// Report 9dec2462: no zoom, pan or orbit while the pointer is over a dimension
// badge. The badges live in #viewport-overlay, a sibling of the canvas, and take
// pointer events; the wheel zoom and camera-controls listen on the canvas only,
// so a wheel turn bubbled past the canvas and a middle/right press was
// swallowed by the badge's own pointerdown. Constraint glyph badges had the
// same hole.
//
// These drive the REAL SketchDimensions and SketchGlyphs on the fakeDom stub
// with an EventTarget standing in for the canvas, and assert what reaches it:
// everything the canvas listens for (the viewport's wheel zoom, camera-controls'
// orbit/pan) runs off exactly that event. The stub does not bubble, so a wheel
// turn over a badge is dispatched on the layer it bubbles to, with the badge as
// its target, which is where the browser delivers it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument, installFakeEvents } from "../ui/fakeDom.testkit";
import { SketchDimensions } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

installFakeDocument();
installFakeEvents();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

/** A canvas that records what reaches it. */
function makeCanvas() {
  const canvas = new EventTarget();
  const got: Event[] = [];
  for (const type of ["wheel", "pointerdown"]) canvas.addEventListener(type, (e) => got.push(e));
  return { canvas, got };
}

function viewportOver(canvas: EventTarget) {
  return {
    camera: new THREE.PerspectiveCamera(),
    projectToScreen: () => ({ x: 0, y: 0 }),
    projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
    domElement: canvas,
  } as unknown as Viewport;
}

const press = (button: number, at = { x: 100, y: 100 }) => ({
  type: "pointerdown",
  button,
  buttons: button === 1 ? 4 : button === 2 ? 2 : 1,
  pointerId: 1,
  pointerType: "mouse",
  clientX: at.x,
  clientY: at.y,
  stopPropagation: () => {},
  preventDefault: () => {},
});

const wheel = (target: FakeEl) => {
  const e = { type: "wheel", deltaY: -120, deltaMode: 0, clientX: 100, clientY: 100, target, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
  return e;
};

const contextmenu = { preventDefault: () => {}, stopPropagation: () => {} };
const move = (x: number, y: number) => window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }));
const release = () => window.dispatchEvent(new PointerEvent("pointerup", { clientX: 100, clientY: 100 }));

describe("9dec2462: camera navigation over a dimension badge", () => {
  let canvas: ReturnType<typeof makeCanvas>;
  let dims: SketchDimensions;
  let badge: FakeEl;
  let layer: FakeEl;
  let menu: ReturnType<typeof vi.fn<() => void>>;
  let overlap: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    body().innerHTML = "";
    canvas = makeCanvas();
    dims = new SketchDimensions(viewportOver(canvas.canvas), () => {});
    menu = vi.fn<() => void>();
    overlap = vi.fn(() => false);
    dims.onLabelMenu = menu;
    dims.onOverlapPick = overlap as unknown as (e: PointerEvent) => boolean;
    dims.show([], plane, [{ anchor: new THREE.Vector2(0, 0), valueMm: 10, commit: () => {} }]);
    badge = byClass(body(), "sketch-dim")[0]!;
    layer = byClass(body(), "sketch-dims")[0]!;
  });

  it("a wheel turn over the badge zooms: the canvas gets it, delta and position intact", () => {
    const e = wheel(badge);
    layer.dispatch("wheel", e);
    expect(canvas.got).toHaveLength(1);
    expect(canvas.got[0]).toMatchObject({ type: "wheel", deltaY: -120, clientX: 100, clientY: 100 });
    expect(e.defaultPrevented).toBe(true);
  });

  it("a wheel turn over an open inline editor does not zoom away from it", () => {
    layer.dispatch("wheel", wheel(new FakeEl("input")));
    expect(canvas.got).toHaveLength(0);
  });

  it("a middle press over the badge starts the canvas's orbit/pan", () => {
    badge.dispatch("pointerdown", press(1));
    expect(canvas.got).toHaveLength(1);
    expect(canvas.got[0]).toMatchObject({ type: "pointerdown", button: 1, buttons: 4, pointerType: "mouse", clientX: 100 });
    expect(overlap).not.toHaveBeenCalled(); // and still selects nothing
  });

  it("a left press stays the badge's own: nothing reaches the canvas", () => {
    badge.dispatch("pointerdown", press(0));
    expect(canvas.got).toHaveLength(0);
    expect(overlap).toHaveBeenCalledTimes(1);
  });

  it("a right DRAG pans and does not also open the badge's menu", () => {
    badge.dispatch("pointerdown", press(2));
    expect(canvas.got).toHaveLength(1);
    expect(canvas.got[0]).toMatchObject({ type: "pointerdown", button: 2 });
    badge.dispatch("contextmenu", contextmenu); // WebKit: fired while still held
    move(160, 130);
    release();
    expect(menu).not.toHaveBeenCalled();
  });

  it("a right CLICK still opens the badge's menu, on the release (WebKit order)", () => {
    badge.dispatch("pointerdown", press(2));
    badge.dispatch("contextmenu", contextmenu);
    expect(menu).not.toHaveBeenCalled(); // could still turn into a pan
    move(102, 101); // a hand's tremor, not a pan
    release();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(badge.classList.contains("is-selected")).toBe(true);
  });

  it("a right CLICK opens the menu where contextmenu comes after the release", () => {
    badge.dispatch("pointerdown", press(2));
    release();
    badge.dispatch("contextmenu", contextmenu);
    expect(menu).toHaveBeenCalledTimes(1);
  });
});

describe("9dec2462: camera navigation over a constraint glyph", () => {
  let canvas: ReturnType<typeof makeCanvas>;
  let glyphs: SketchGlyphs;
  let badge: FakeEl;
  let layer: FakeEl;
  let menu: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    body().innerHTML = "";
    canvas = makeCanvas();
    glyphs = new SketchGlyphs(viewportOver(canvas.canvas));
    menu = vi.fn<() => void>();
    glyphs.onMenu = menu;
    glyphs.onOverlapPick = () => false;
    glyphs.show([{ cIndex: 0, label: "∥", pos: new THREE.Vector2(0, 0) }], plane, new Set(), new Set());
    badge = byClass(body(), "sketch-glyph")[0]!;
    layer = byClass(body(), "sketch-glyphs")[0]!;
  });

  it("a wheel turn over the glyph zooms", () => {
    layer.dispatch("wheel", wheel(badge));
    expect(canvas.got).toHaveLength(1);
    expect(canvas.got[0]).toMatchObject({ type: "wheel", deltaY: -120 });
  });

  it("a middle press over the glyph orbits", () => {
    badge.dispatch("pointerdown", press(1));
    expect(canvas.got).toMatchObject([{ type: "pointerdown", button: 1 }]);
  });

  it("a right drag pans without the menu; a right click opens it", () => {
    badge.dispatch("pointerdown", press(2));
    badge.dispatch("contextmenu", contextmenu);
    move(170, 100);
    release();
    expect(canvas.got).toMatchObject([{ type: "pointerdown", button: 2 }]);
    expect(menu).not.toHaveBeenCalled();

    badge.dispatch("pointerdown", press(2));
    badge.dispatch("contextmenu", contextmenu);
    release();
    expect(menu).toHaveBeenCalledTimes(1);
  });
});
