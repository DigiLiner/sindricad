// A constraint glyph sits ON the geometry it constrains — the ∥ badge lands at
// the MIDPOINT of the line it names, the ⊙ badge on the shared endpoint — and
// the badge's "geometry beats label" hook (SketchMode.labelOverlapSelect) then
// hands that click to the entity underneath, selects it, and rebuilds the glyph
// layer out from under the badge. The click delete was therefore unreachable for
// every constraint whose badge lands on its own operand: report 59c5a7d7,
// "could not delete a parallel constraint, tried double clicking it".
//
// These drive the REAL SketchGlyphs over the fakeDom stub with the REAL
// pickEntity wired as the overlap hook, so they observe the EFFECT a user would
// notice — is the constraint gone from the document — rather than that a
// listener exists.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs } from "./glyphs";
import { pickEntity } from "./modify";
import { compileAndSolve } from "./sketchSolve";
import { SketchMode } from "./sketchMode";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const viewport = {
  camera: new THREE.PerspectiveCamera(),
  projectToScreen: () => ({ x: 0, y: 0 }),
  projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
} as unknown as Viewport;
const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

/** The pick tolerance SketchMode feeds in: 9 px at the reporter's zoom. */
const TOL = 9 * 0.05;

/** A live glyph layer over `ents` + `cons`, wired the way SketchMode wires it:
 *  onDelete splices the constraint and REBUILDS (which destroys the badge), and
 *  onOverlapPick is a faithful copy of SketchMode.labelOverlapSelect's SELECT
 *  branch — real pickEntity, and a rebuild when geometry claims the pick. (A
 *  press on a point's drag handle takes its other branch and starts the point
 *  drag; glyphPointDrag.test.ts drives the real method for that.) */
function mount(ents: ResolvedEntity[], cons: SketchConstraint[]) {
  body().innerHTML = "";
  const glyphs = new SketchGlyphs(viewport);
  const state = { selected: "", menuFor: -1 };
  const redraw = () => glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
  glyphs.onDelete = (i) => { cons.splice(i, 1); redraw(); };
  glyphs.onOverlapPick = (e) => {
    const p = (e as unknown as { plane: THREE.Vector2 }).plane;
    const idx = pickEntity(ents, p, TOL);
    const ent = idx >= 0 ? ents[idx] : undefined;
    if (!ent) return false;
    state.selected = ent.id;
    redraw(); // refreshActive() → the badge is detached mid-gesture
    return true;
  };
  glyphs.onMenu = (_e, i) => { state.menuFor = i; glyphs.onDelete?.(i); };
  redraw();
  return { glyphs, state, badges: () => byClass(body(), "sketch-glyph") };
}

/** a mouse/pointer event as the handlers read it, carrying the sketch-plane
 *  point the badge sits at (the overlap hook converts screen→plane for real).
 *  `client` is the SCREEN position: the double-press detector reads it, so two
 *  presses that land far apart must not be read as one double-click. */
const evt = (at: THREE.Vector2, button = 0, client = { x: 0, y: 0 }) => ({
  button,
  clientX: client.x,
  clientY: client.y,
  plane: at,
  stopPropagation: () => {},
  preventDefault: () => {},
});

describe("report 59c5a7d7: a parallel glyph on its own line", () => {
  // the reporter's own geometry, lifted from his attached document: two lines
  // each held parallel to a rectangle EDGE, plus a point-to-line dimension.
  // (bug-reports/ is gitignored, so the numbers live here rather than a fixture.)
  const load = () => ({
    ents: [
      { type: "rectangle", id: "e1", x: 0, y: 0.0028419448963319383, width: 115.8277144353254, height: 68.7100973521085 },
      { type: "line", id: "e5", x1: -51.14769231494422, y1: 17.078464224740824, x2: -10.229663843610291, y2: 17.078464224740824 },
      { type: "line", id: "e7", x1: -56.67388223431796, y1: 10.330518902368029, x2: -56.67388223431796, y2: -29.352206827082245 },
    ] as ResolvedEntity[],
    cons: [
      { type: "parallel", l1: "e5", l2: "e1~2" },
      { type: "parallel", l1: "e7", l2: "e1~3" },
      { type: "p2lDistance", id: "c11", e: "e5", p: 0, line: "e1~0", value: 5 },
    ] as SketchConstraint[],
  });

  it("really does sit on the line it names (the precondition for the bug)", () => {
    const { ents, cons } = load();
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥");
    expect(g).toBeTruthy();
    expect(pickEntity(ents, g!.pos, TOL)).toBeGreaterThanOrEqual(0);
  });

  it("a left-click still belongs to the geometry underneath (unchanged)", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g.pos));
    badge.dispatch("click", evt(g.pos));
    expect(m.state.selected).toBe("e5");
    expect(cons.filter((c) => c.type === "parallel")).toHaveLength(2);
  });

  it("a right-click deletes it", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g.pos, 2));
    badge.dispatch("contextmenu", evt(g.pos, 2));
    expect(cons.some((c) => c.type === "parallel" && c.l1 === "e5")).toBe(false);
    expect(cons).toHaveLength(2);
  });

  it("a right press never hands the click to the geometry underneath", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos, 2));
    expect(m.state.selected).toBe(""); // the badge survived to its own menu
  });

  it("a double-click deletes it — what the reporter tried", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    // a real double click: two press/click pairs. The first press hands the
    // click to the line underneath and REBUILDS, so the second press lands on a
    // different element — the badge cannot be the one remembering it happened.
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    m.badges()[0]!.dispatch("click", evt(g.pos));
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    expect(cons.some((c) => c.type === "parallel" && c.l1 === "e5")).toBe(false);
  });

  it("the click after a double-click delete does not delete a second constraint", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const before = cons.length;
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    m.badges()[0]!.dispatch("click", evt(g.pos));
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    m.badges()[0]!.dispatch("click", evt(g.pos)); // the press's own trailing click
    expect(cons).toHaveLength(before - 1);
  });

  it("two presses on the same badge far apart on screen are not a double-click", () => {
    // The badge is one element wherever the camera is, so without the screen
    // distance guard a click here, a pan, and a click there would read as a
    // double-click and delete a constraint the user only ever single-clicked.
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const before = cons.length;
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos, 0, { x: 400, y: 120 }));
    m.badges()[0]!.dispatch("click", evt(g.pos, 0, { x: 400, y: 120 }));
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos, 0, { x: 402, y: 300 }));
    expect(cons).toHaveLength(before);
  });
});

describe("the solver stops enforcing a deleted constraint", () => {
  const seed = (): ResolvedEntity[] => [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 },
    { type: "line", id: "b", x1: 0, y1: 10, x2: 40, y2: 16 },
  ];
  const angleOf = (ents: ResolvedEntity[], id: string) => {
    const e = ents.find((q) => q.id === id);
    if (e?.type !== "line") throw new Error("line lost");
    return Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
  };

  it("the two lines stop being pulled parallel once the glyph deletes it", async () => {
    const ents = seed();
    const cons: SketchConstraint[] = [{ type: "parallel", l1: "a", l2: "b" }];
    const held = await compileAndSolve(seed(), cons);
    expect(held.ok).toBe(true);
    expect(angleOf(held.entities, "b")).toBeCloseTo(angleOf(held.entities, "a"), 6);

    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons)[0]!;
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g.pos, 2));
    badge.dispatch("contextmenu", evt(g.pos, 2));
    expect(cons).toHaveLength(0);

    const free = await compileAndSolve(seed(), cons);
    expect(free.ok).toBe(true);
    expect(angleOf(free.entities, "b")).not.toBeCloseTo(angleOf(free.entities, "a"), 3);
  });
});

// The audit behind report efc5d3f3 ("check which constraints are missing the
// ability to be deleted"): every geometric constraint type, with real geometry
// under its badge, must still be removable.
describe("every geometric constraint is deletable with geometry under its badge", () => {
  const scene = (): ResolvedEntity[] => [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 },
    { type: "line", id: "b", x1: 0, y1: 10, x2: 40, y2: 10 },
    { type: "circle", id: "c1", x: 10, y: -20, radius: 5 },
    { type: "circle", id: "c2", x: 30, y: -20, radius: 5 },
  ];
  const cases: [string, SketchConstraint][] = [
    ["horizontal", { type: "horizontal", line: "a" }],
    ["vertical", { type: "vertical", line: "a" }],
    ["parallel", { type: "parallel", l1: "a", l2: "b" }],
    ["perpendicular", { type: "perpendicular", l1: "a", l2: "b" }],
    ["collinear", { type: "collinear", l1: "a", l2: "b" }],
    ["equal", { type: "equal", l1: "a", l2: "b" }],
    ["equalRadius", { type: "equalRadius", a: "c1", b: "c2" }],
    ["tangent", { type: "tangent", line: "a", circle: "c1" }],
    ["tangent2", { type: "tangent2", a: "c1", b: "c2" }],
    ["coincident", { type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 }],
    ["concentric", { type: "concentric", c1: "c1", c2: "c2" }],
    ["midpoint", { type: "midpoint", e: "c1", p: 0, line: "a" }],
    ["symmetric", { type: "symmetric", e1: "a", p1: 0, e2: "b", p2: 0, line: "a" }],
    ["fix", { type: "fix", e: "a", p: 0 }],
  ];

  it.each(cases)("%s", (_name, c) => {
    const ents = scene();
    const cons: SketchConstraint[] = [c];
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons)[0];
    expect(g).toBeTruthy(); // a constraint with no badge is its own bug
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g!.pos, 2));
    badge.dispatch("contextmenu", evt(g!.pos, 2));
    expect(cons).toHaveLength(0);
  });
});

// A tangent's badge now sits where the curves touch (34bede7e). For an arc
// drawn off a line's end that is the shared end, the very spot the coincident's
// ⊙ marks. Two badges on one spot used to be drawn one exactly over the other,
// so the lower one could be neither read nor right-clicked away.
describe("badges on the same spot sit side by side", () => {
  const s2 = Math.SQRT1_2;
  const ents: ResolvedEntity[] = [
    { type: "line", id: "l", x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: "arc", id: "a", x1: 100, y1: 0, x2: 120, y2: 20, mx: 100 + 20 * s2, my: 20 - 20 * s2 },
  ];
  const cons: SketchConstraint[] = [
    { type: "coincident", e1: "l", p1: 1, e2: "a", p2: 0 },
    { type: "tangent2", a: "l", b: "a" },
    { type: "horizontal", line: "l" },
    { type: "fix", e: "a", p: 0 },
  ];
  /** screen px of a plane point: 3 px per mm, y up, origin at (100, 400) */
  const projecting = {
    camera: new THREE.PerspectiveCamera(),
    projectToOverlay: (w: THREE.Vector3) => ({ x: 100 + w.x * 3, y: 400 - w.y * 3, width: 900, height: 700 }),
  } as unknown as Viewport;
  const drawnAt = (el: FakeEl) => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform ?? "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };

  it("the tangent beside the fix on the joint, the H on its own spot untouched", () => {
    body().innerHTML = "";
    const glyphs = new SketchGlyphs(projecting);
    glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
    (glyphs as unknown as { loop: () => void }).loop();
    const [coinc, tan, h, fix] = byClass(body(), "sketch-glyph");
    expect([coinc?.textContent, tan?.textContent, h?.textContent, fix?.textContent]).toEqual(["⊙", "T", "H", "⚓"]);
    const near = (x: number, y: number) => ({ x: expect.closeTo(x, 6), y: expect.closeTo(y, 6) });
    const joint = { x: 100 + 100 * 3, y: 400 };
    // The coincident, the tangent and the fix all mark the joint, so they form
    // ONE group (grouped by the real anchor, before any nudge) laid out in a
    // row just above the joint, alternating right and left: none covers the
    // point, none covers another. Before, the tangent stayed on the joint while
    // the coincident was nudged 12 px off it, and the two 16 px badges
    // overlapped (sketch_palette_e2e "...and not on top of the ⊙").
    expect(drawnAt(coinc!)).toEqual(near(joint.x + 12, joint.y - 12));
    expect(drawnAt(tan!)).toEqual(near(joint.x - 12, joint.y - 12));
    expect(drawnAt(fix!)).toEqual(near(joint.x + 12 + 20, joint.y - 12));
    const box = (el: FakeEl) => { const c = drawnAt(el)!; return { l: c.x - 8, r: c.x + 8, t: c.y - 8, b: c.y + 8 }; };
    const apart = (a: FakeEl, b: FakeEl) => { const p = box(a), q = box(b); return p.l >= q.r || q.l >= p.r || p.t >= q.b || q.t >= p.b; };
    expect(apart(coinc!, tan!) && apart(coinc!, fix!) && apart(tan!, fix!)).toBe(true);
    for (const el of [coinc!, tan!, fix!]) {
      const q = box(el);
      expect(joint.x >= q.l && joint.x <= q.r && joint.y >= q.t && joint.y <= q.b).toBe(false);
    }
    // H used to land exactly on the line's own midpoint — the regression this
    // file now guards against (a badge there intercepts the click a
    // double-press on the line needs for chain-select, see
    // "a line-midpoint badge never sits on its own line" below). It is now
    // nudged LINE_MIDPOINT_OFFSET_PX (12px) perpendicular to the line's
    // on-screen direction; this line is horizontal on screen, so the nudge is
    // purely vertical: +12px in screen y.
    expect(drawnAt(h!)).toEqual(near(100 + 50 * 3, 400 + 12));
  });
});

// The regression this fix closes: since 3a63f7d a perpendicular badges BOTH
// its operands, each badge landing at center(line) — the line's own on-screen
// midpoint. A double-press there is the documented delete escape hatch, but
// it is also exactly where a user double-clicks the LINE to select its chain:
// the badge's pointerdown claims the click first (stopPropagation), so the
// click silently deletes the constraint instead of selecting the chain. The
// fix nudges a line-midpoint badge off that pixel; this test checks the
// nudge actually lands clear of each line's own midpoint, not just that *a*
// nudge happened.
describe("a line-midpoint badge never sits on its own line", () => {
  const ents: ResolvedEntity[] = [
    { type: "line", id: "l1", x1: 0, y1: 0, x2: 0, y2: 100 },
    { type: "line", id: "l2", x1: 0, y1: 100, x2: 100, y2: 100 },
  ];
  const cons: SketchConstraint[] = [{ type: "perpendicular", l1: "l1", l2: "l2" }];
  /** screen px of a plane point: 3 px per mm, y up, origin at (100, 400). */
  const projecting = {
    camera: new THREE.PerspectiveCamera(),
    projectToOverlay: (w: THREE.Vector3) => ({ x: 100 + w.x * 3, y: 400 - w.y * 3, width: 900, height: 700 }),
  } as unknown as Viewport;
  const drawnAt = (el: FakeEl) => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform ?? "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  // independently computed on-screen midpoints — NOT reusing the production
  // code under test — of l1 and l2 respectively.
  const mid1 = { x: 100 + 0 * 3, y: 400 - 50 * 3 };
  const mid2 = { x: 100 + 50 * 3, y: 400 - 100 * 3 };

  it("both ⊥ badges sit clear of either line's own midpoint", () => {
    body().innerHTML = "";
    const glyphs = new SketchGlyphs(projecting);
    glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
    (glyphs as unknown as { loop: () => void }).loop();
    const badges = byClass(body(), "sketch-glyph").filter((el) => el.textContent === "⊥");
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      const at = drawnAt(badge)!;
      expect(at, "must not sit exactly on l1's on-screen midpoint").not.toEqual(mid1);
      expect(at, "must not sit exactly on l2's on-screen midpoint").not.toEqual(mid2);
    }
  });
});

// Through the Select tool's own pointer handler, not just the glyph layer in
// isolation: in the real webview a badge is a DOM element sitting ABOVE the
// canvas, and its pointerdown calls stopPropagation — so when a badge renders
// at the exact pixel a user double-clicks, SketchMode.onPointerDown's
// chain-select branch never runs at all, and the badge's own isDoublePress ->
// onDelete fires instead. This models that DOM z-order choice the way a real
// browser's elementFromPoint would: whichever element (a glyph badge, or
// nothing i.e. the canvas) actually sits at the clicked pixel wins the press.
describe("double-click at a line's midpoint reaches chain-select, not the badge", () => {
  const ents: ResolvedEntity[] = [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "b", x1: 10, y1: 0, x2: 10, y2: 10 },
  ];
  const cons: SketchConstraint[] = [{ type: "perpendicular", l1: "a", l2: "b" }];
  /** screen px of a plane point: 3 px per mm, y up, origin at (100, 400). */
  const projecting = {
    camera: new THREE.PerspectiveCamera(),
    projectToOverlay: (w: THREE.Vector3) => ({ x: 100 + w.x * 3, y: 400 - w.y * 3, width: 900, height: 700 }),
  } as unknown as Viewport;
  const drawnAt = (el: FakeEl) => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform ?? "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  // line a's own exact on-screen midpoint — the pixel the user double-clicks.
  const midA = { x: 100 + 5 * 3, y: 400 - 0 * 3 };
  const press = (x: number, y: number) => ({
    button: 0, shiftKey: false, ctrlKey: false, clientX: x, clientY: y, pointerId: 1,
    stopPropagation: () => {}, preventDefault: () => {},
  });

  /** A bare SketchMode whose real private methods (entityChain, takeWhole,
   *  onPointerDown) run unstubbed — only data and the geometry/DOM queries
   *  they read are faked, the same pattern doublePress.test.ts's makeMode and
   *  chainSelect.test.ts's withEntities use. */
  function makeSelectMode(target: THREE.Vector2) {
    const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
    Object.assign(s, {
      tool: "select",
      entities: ents,
      selected: new Set<string>(),
      dims: { clearSelection() {} },
      overlay: { activeRegionAt: () => null },
      viewport: { domElement: { setPointerCapture() {} } },
      snapAt: () => ({ p: target, kind: "free" }),
      planePoint: () => target,
      pickPoint: () => null,
      pickTol: () => 0.5,
      derivedEntities: () => [],
      textEntityAt: () => null,
      refreshActive: () => {},
    });
    const down = (e: ReturnType<typeof press>) =>
      (s as unknown as { onPointerDown: (e: PointerEvent) => void }).onPointerDown(e as unknown as PointerEvent);
    return { s, down };
  }

  it("no badge renders on the line's own on-screen midpoint", () => {
    body().innerHTML = "";
    const glyphs = new SketchGlyphs(projecting);
    glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
    (glyphs as unknown as { loop: () => void }).loop();
    const hitBadge = byClass(body(), "sketch-glyph").find((el) => {
      const at = drawnAt(el);
      return at && Math.round(at.x) === Math.round(midA.x) && Math.round(at.y) === Math.round(midA.y);
    });
    // Before the fix this found the ⊥ badge (the measured bug: elementFromPoint
    // at a line's midpoint returned the constraint badge), which would have
    // claimed the press below and deleted the constraint instead of selecting
    // the chain.
    expect(hitBadge, "a badge must not sit on the line's own midpoint pixel").toBeUndefined();
  });

  it("a double-press there selects the whole chain and touches no constraint", () => {
    const { s, down } = makeSelectMode(new THREE.Vector2(5, 0)); // plane point (5,0): a's own midpoint
    down(press(midA.x, midA.y));
    down(press(midA.x, midA.y));
    expect(cons).toHaveLength(1); // the perpendicular constraint is untouched
    const selected = (s as unknown as { selected: Set<string> }).selected;
    expect([...selected].sort()).toEqual(["a", "b"]); // chain select reached
  });
});

// The on-point nudge (9e4c9bb5, ON_POINT_LABELS above) pushes a coincident or
// pointOn badge a few screen pixels clear of the point it marks, so the point
// still shows through. But a badge whose REAL anchor is comfortably on screen,
// near an edge, can be pushed past that edge by the nudge alone and vanish —
// losing the badge (and its on-canvas delete affordance) for a constraint the
// user can see fine, which is worse than the overlap the nudge was fixing.
describe("the on-point nudge must not cull a badge whose real anchor is on screen", () => {
  /** screen px of a plane point: 3 px per mm, y up, origin at (100, 400), in a
   *  900x700 overlay — the same convention as "badges on the same spot". */
  const projecting = {
    camera: new THREE.PerspectiveCamera(),
    projectToOverlay: (w: THREE.Vector3) => ({ x: 100 + w.x * 3, y: 400 - w.y * 3, width: 900, height: 700 }),
  } as unknown as Viewport;
  // chosen so the screen anchor lands at (400, 5): 5px from the top edge,
  // clearly on screen, but only 5px of headroom before the -12px y-nudge
  // (ON_POINT_OFFSET_PX) carries it past y=0.
  const wx = 100, wy = (400 - 5) / 3;
  const ents: ResolvedEntity[] = [
    { type: "line", id: "h", x1: wx - 20, y1: wy, x2: wx + 20, y2: wy },
    { type: "line", id: "b", x1: wx, y1: wy, x2: wx + 40, y2: wy - 40 },
  ];
  const cons: SketchConstraint[] = [
    { type: "horizontal", line: "h" },
    { type: "coincident", e1: "b", p1: 0, e2: "b", p2: 1 },
  ];

  it("an unnudged badge at the same on-screen spot is not culled, but the coincident badge is", () => {
    body().innerHTML = "";
    const glyphs = new SketchGlyphs(projecting);
    glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
    (glyphs as unknown as { loop: () => void }).loop();
    const [h, coinc] = byClass(body(), "sketch-glyph");
    expect([h?.textContent, coinc?.textContent]).toEqual(["H", "⊙"]);
    expect(h!.style.visibility).not.toBe("hidden");
    expect(coinc!.style.visibility).not.toBe("hidden");
  });
});

// Finding: the fix (⚓) badge was left out of ON_POINT_LABELS, so it rendered
// exactly on the point it marks — reproducing 9e4c9bb5's "badge covers the
// point I am trying to target" for fix instead of coincident.
describe("a fix badge is nudged clear of its point too, the same as coincident", () => {
  const projecting = {
    camera: new THREE.PerspectiveCamera(),
    projectToOverlay: (w: THREE.Vector3) => ({ x: 100 + w.x * 3, y: 400 - w.y * 3, width: 900, height: 700 }),
  } as unknown as Viewport;
  const ents: ResolvedEntity[] = [{ type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 }];
  const cons: SketchConstraint[] = [{ type: "fix", e: "a", p: 0 }];

  it("does not land on the exact screen spot of the point it fixes", () => {
    body().innerHTML = "";
    const glyphs = new SketchGlyphs(projecting);
    glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
    (glyphs as unknown as { loop: () => void }).loop();
    const [fix] = byClass(body(), "sketch-glyph");
    expect(fix?.textContent).toBe("⚓");
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(fix!.style.transform ?? "");
    const drawn = { x: Number(m![1]), y: Number(m![2]) };
    const point = { x: 100, y: 400 }; // (a, p=0) is the entity's first endpoint, at plane (0,0)
    expect(drawn).not.toEqual({ x: point.x, y: point.y });
  });
});
