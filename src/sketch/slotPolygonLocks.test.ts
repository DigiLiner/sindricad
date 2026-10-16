// Lock a slot's length and a polygon's radius (tracker b6c83f35, promised on
// GitHub #41 as "slot and polygon locks"): "When I lock the length dimension
// for a slot, I can still drag the slot to a different length." Lock found
// nothing to lock ("Nothing to lock: every dimension on that geometry is
// already held, or it has none"), the badge offered no Lock, and a drag of the
// slot's side stretched it. The rule behind all three (directDims) still said
// a slot's length and a polygon's radius were never solved, so nothing could
// move them; since slots and polygons became solver geometry both are solver
// variables, and the drag is the solver doing its job on a length nothing held.
//
// The reporter's own sketch, through the gestures the user makes (a click on
// the slot, Constraints > Lock Dimension, a drag of its side, a number typed
// into its badge) on a real SketchMode with the real planegcs solver. What is
// read back is what the user sees: the stored constraints, the toast, and the
// SOLVED coordinates. A drag alone is a false oracle (a sketch the solver
// cannot move "holds" too), so every hold has an unlocked control beside it.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch } from "./liveSketch.testkit";
import { POLYGON_CENTRE, constraintDims, refPoint } from "./entityDims";
import { applyDrivingDimsDirect, dimBindingFor, governingDimAt, lockDimFor, planDimEdit } from "./directDims";
import { sketchDimRows } from "./dimRows";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { DimField, SketchConstraint } from "../types";

type Slot = Extract<ResolvedEntity, { type: "slot" }>;
type Poly = Extract<ResolvedEntity, { type: "polygon" }>;

/** The private badge hooks and editors the canvas labels call. */
interface Badges {
  entityDimConstraint(index: number, field: DimField): (() => void) | "free" | null;
  entityDimLock(index: number, field: DimField): (() => void) | null;
  editDimension(index: number, field: DimField, mm: number): void;
  pendingBindings: Map<string, { expr: string; kind: string }>;
}

/** The reporter's sketch (0.1.238), verbatim: a slot whose right centre sits
 *  on the origin, two vertical lines ending on its sides, a circle tangent to
 *  one side. */
const reporterDoc = (): { ents: ResolvedEntity[]; cons: SketchConstraint[] } => ({
  ents: [
    { type: "slot", id: "e17", x1: -138.76761379715427, y1: 3.053113317719181e-16, x2: -2.201634536491192e-19, y2: 2.1457071445499275e-31, width: 20 },
    { type: "line", id: "e19", x1: -41.51301886902108, y1: 30, x2: -41.51301886902108, y2: 10 },
    { type: "line", id: "e20", x1: -48.392520069085464, y1: -10, x2: -48.392520069085464, y2: -25 },
    { type: "circle", id: "e24", x: -12.125974371900895, y: 30, radius: 20 },
  ],
  cons: [
    { type: "vertical", line: "e19" },
    { type: "vertical", line: "e20" },
    { type: "pointOn", e: "e19", p: 1, curve: "e17~0" },
    { type: "pointOn", e: "e20", p: 0, curve: "e17~1" },
    { type: "distance", id: "c22", line: "e19", value: 20 },
    { type: "distance", id: "c23", line: "e20", value: 15 },
    { type: "horizontal", line: "e17~1" },
    { type: "coincident", e1: "e17", p1: 1, e2: "__origin__", p2: 0 },
    { type: "diameter", id: "c25", circle: "e24", value: 40 },
    { type: "tangent2", a: "e17~0", b: "e24" },
  ],
});
const LEN = 138.76761379715427;

const slotOf = (live: ReturnType<typeof liveSketch>) => live.ent("e17") as Slot;
const lenOf = (s: Slot) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const axisLocks = (cons: SketchConstraint[]) => cons.filter((c) => c.type === "distance" && c.line === "e17~2");

async function reporter(lock: SketchConstraint[] = []) {
  toasts.length = 0;
  const d = reporterDoc();
  const live = liveSketch(d.ents, [...d.cons, ...lock]);
  await live.settle();
  return { live, b: live.s as unknown as Badges, idx: live.s.entities.findIndex((e) => e.id === "e17") };
}

beforeEach(() => { toasts.length = 0; });

describe("Lock a slot's length", () => {
  it("click the slot, Constraints > Lock Dimension: its length is locked at what it reads", async () => {
    const { live } = await reporter();
    live.click(-70, 10); // the slot's top side, the way the user picks it
    expect([...live.s.selected]).toEqual(["e17~0"]);
    const before = live.s.constraints.length;
    live.s.lockDimensionCommand();
    await live.settle();
    expect(live.s.constraints).toHaveLength(before + 1);
    const locks = axisLocks(live.s.constraints);
    expect(locks).toHaveLength(1);
    expect((locks[0] as { value: number }).value).toBeCloseTo(LEN, 4);
    expect(toasts).toEqual([t("sketch.lockDims.locked", { count: 1 })]);
  });

  it("the armed Lock Dimension tool locks it with one click on the slot", async () => {
    const { live } = await reporter();
    live.s.lockDimensionCommand(); // nothing selected: arms the tool
    expect(live.s.tool).toBe("lockDimension");
    live.click(-70, 10);
    await live.settle();
    expect(axisLocks(live.s.constraints)).toHaveLength(1);
    expect(toasts).toEqual([t("sketch.lockDims.locked", { count: 1 })]);
  });

  it("the length badge offers Lock (and the width does not: nothing can move it)", async () => {
    const { live, b, idx } = await reporter();
    expect(b.entityDimConstraint(idx, "length")).toBe("free");
    expect(b.entityDimConstraint(idx, "width")).toBeNull();
    const lock = b.entityDimLock(idx, "length");
    expect(lock).toBeTypeOf("function");
    lock!();
    await live.settle();
    expect(axisLocks(live.s.constraints)).toHaveLength(1);
    expect(b.entityDimConstraint(idx, "length")).toBeTypeOf("function");
  });

  it("a drag of the slot's side stretches it unlocked (control) and moves it whole once locked", async () => {
    const free = await reporter();
    await free.live.drag([-70, 10], [-45, 10], 5);
    expect(Math.abs(lenOf(slotOf(free.live)) - LEN)).toBeGreaterThan(10); // the report: the drag stretched it

    const { live } = await reporter();
    live.click(-70, 10);
    live.s.lockDimensionCommand();
    await live.settle();
    toasts.length = 0;
    live.s.selected.clear();
    await live.drag([-70, 10], [-45, 10], 5);
    const s = slotOf(live);
    expect(lenOf(s)).toBeCloseTo(LEN, 4);
    expect(Math.hypot(s.x2, s.y2)).toBeLessThan(1e-6); // its right centre stays on the origin
    expect(live.s.overIdx.size).toBe(0);
    expect(toasts).toEqual([]);
  });

  it("typing a new length into a locked badge retypes the lock and the solver moves the slot to it", async () => {
    const { live, b, idx } = await reporter([{ type: "distance", id: "L", line: "e17~2", value: LEN }]);
    b.editDimension(idx, "length", 60);
    await live.settle();
    const locks = axisLocks(live.s.constraints);
    expect(locks).toHaveLength(1);
    expect((locks[0] as { value: number }).value).toBe(60);
    const s = slotOf(live);
    expect(s.x1).toBeCloseTo(-60, 6);
    expect(Math.hypot(s.x2, s.y2)).toBeLessThan(1e-6);
  });

  it("typing into a free badge locks it, and typing again retypes that one lock", async () => {
    const { live, b, idx } = await reporter();
    b.editDimension(idx, "length", 100);
    await live.settle();
    b.editDimension(idx, "length", 90);
    await live.settle();
    const locks = axisLocks(live.s.constraints);
    expect(locks).toHaveLength(1);
    expect((locks[0] as { value: number }).value).toBe(90);
    expect(lenOf(slotOf(live))).toBeCloseTo(90, 6);
  });

  it("a length the Dimension tool put on its two centres governs the badge: typing retypes it, adds no second lock", async () => {
    const tool: SketchConstraint = { type: "p2pDistance", id: "D", e1: "e17", p1: 0, e2: "e17", p2: 1, value: LEN };
    const { live, b, idx } = await reporter([tool]);
    expect(b.entityDimConstraint(idx, "length")).toBeTypeOf("function");
    b.editDimension(idx, "length", 80);
    await live.settle();
    expect(axisLocks(live.s.constraints)).toEqual([]);
    expect((live.s.constraints.find((c) => c.type === "p2pDistance") as { value: number }).value).toBe(80);
    expect(lenOf(slotOf(live))).toBeCloseTo(80, 6);
  });
});

/** a hexagon of radius 20 on the origin, and a line whose start is joined to
 *  its corner 0 */
const hexDoc = () => {
  const p1: Poly = { type: "polygon", id: "p1", x: 0, y: 0, radius: 20, sides: 6, angle: 0 };
  const c0 = refPoint(p1, 0)!, c1 = refPoint(p1, 1)!;
  const l1: ResolvedEntity = { type: "line", id: "l1", x1: c0.x, y1: c0.y, x2: c0.x + 20, y2: c0.y + 10 };
  const cons: SketchConstraint[] = [
    { type: "coincident", e1: "l1", p1: 0, e2: "p1", p2: 0 },
    { type: "coincident", e1: "p1", p1: POLYGON_CENTRE, e2: "__origin__", p2: 0 },
  ];
  return { p1, l1, cons, c0, side: { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 } };
};

describe("Lock a polygon's radius", () => {
  async function hex() {
    const d = hexDoc();
    const live = liveSketch([d.p1, d.l1], [...d.cons]);
    await live.settle();
    return { live, d, b: live.s as unknown as Badges, idx: live.s.entities.findIndex((e) => e.id === "p1") };
  }
  const radiusOf = (live: ReturnType<typeof liveSketch>) => (live.ent("p1") as Poly).radius;
  const spokes = (cons: SketchConstraint[]) =>
    cons.filter((c) => c.type === "p2pDistance" && c.e1 === "p1" && c.e2 === "p1" && c.p1 === POLYGON_CENTRE && c.p2 === 0);

  it("dragging a line joined to a corner grows an unlocked polygon (control) and not a locked one", async () => {
    const free = await hex();
    await free.live.drag([free.d.c0.x, free.d.c0.y], [30, 0], 5);
    expect(radiusOf(free.live)).toBeCloseTo(30, 3);

    const { live, d } = await hex();
    live.click(d.side.x, d.side.y);
    expect([...live.s.selected]).toEqual(["p1~0"]);
    live.s.lockDimensionCommand();
    await live.settle();
    expect(spokes(live.s.constraints)).toHaveLength(1);
    expect((spokes(live.s.constraints)[0] as { value: number }).value).toBeCloseTo(20, 9);
    expect(toasts).toEqual([t("sketch.lockDims.locked", { count: 1 })]);
    live.s.selected.clear();
    await live.drag([d.c0.x, d.c0.y], [30, 0], 5);
    expect(radiusOf(live)).toBeCloseTo(20, 6);
    expect(live.s.overIdx.size).toBe(0);
  });

  it("typing a radius into the locked badge retypes the lock", async () => {
    const { live, b, idx } = await hex();
    b.entityDimLock(idx, "radius")!();
    await live.settle();
    b.editDimension(idx, "radius", 25);
    await live.settle();
    expect(spokes(live.s.constraints)).toHaveLength(1);
    expect((spokes(live.s.constraints)[0] as { value: number }).value).toBe(25);
    expect(radiusOf(live)).toBeCloseTo(25, 6);
  });

  it("a radius a parameter drives offers no Lock, and Lock Dimension leaves it alone", async () => {
    const { live, b, idx } = await hex();
    b.pendingBindings.set("e:p1:radius", { expr: "r", kind: "length" });
    expect(b.entityDimConstraint(idx, "radius")).toBeNull();
    expect(b.entityDimLock(idx, "radius")).toBeNull();
    live.s.selected.add("p1");
    const before = live.s.constraints.length;
    live.s.lockDimensionCommand();
    await live.settle();
    expect(live.s.constraints).toHaveLength(before);
    expect(toasts).toEqual([t("sketch.lockDims.nothing")]);
  });
});

describe("the rules behind the badge", () => {
  const slot: Slot = { type: "slot", id: "e17", x1: -100, y1: 0, x2: 0, y2: 0, width: 20 };
  const poly: Poly = { type: "polygon", id: "p1", x: 0, y: 0, radius: 20, sides: 6, angle: 0 };
  const slotLock: SketchConstraint = { type: "distance", line: "e17~2", value: 100 };
  const polyLock: SketchConstraint = { type: "p2pDistance", e1: "p1", p1: POLYGON_CENTRE, e2: "p1", p2: 0, value: 20 };

  it("a slot's length locks as a distance on its axis, a polygon's radius as centre to corner 0", () => {
    expect(lockDimFor(slot, "length", 100)).toEqual(slotLock);
    expect(lockDimFor(slot, "width", 20)).toBeNull();
    expect(lockDimFor(poly, "radius", 20)).toEqual(polyLock);
    expect(governingDimAt([slotLock], slot, "length")).toBe(0);
    expect(governingDimAt([polyLock], poly, "radius")).toBe(0);
    // a reference dimension holds nothing
    expect(governingDimAt([{ ...polyLock, driven: true }], poly, "radius")).toBe("free");
  });

  it("a centre-to-corner or end-to-end dimension on some OTHER shape governs nothing here", () => {
    const line: ResolvedEntity = { type: "line", id: "e17", x1: 0, y1: 0, x2: 10, y2: 0 };
    const lineP2p: SketchConstraint = { type: "p2pDistance", e1: "e17", p1: 0, e2: "e17", p2: 1, value: 10 };
    expect(governingDimAt([lineP2p], line, "length")).toBe("free");
    expect(sketchDimRows([line], [lineP2p]).filter((r) => r.ref.kind === "constraint")).toHaveLength(1);
    const rect: ResolvedEntity = { type: "rectangle", id: "p1", x: 0, y: 0, width: 20, height: 10 };
    const rectP2p: SketchConstraint = { type: "p2pDistance", e1: "p1", p1: 0, e2: "p1", p2: 1, value: 20 };
    expect(sketchDimRows([rect], [rectP2p]).filter((r) => r.ref.kind === "constraint")).toHaveLength(1);
    expect(constraintDims([rect], [rectP2p])).toHaveLength(1);
  });

  it("a slot's or polygon's lock is listed and drawn once, by its badge", () => {
    expect(sketchDimRows([slot], [slotLock]).filter((r) => r.ref.kind === "constraint")).toHaveLength(0);
    expect(sketchDimRows([slot], [slotLock]).filter((r) => r.dim === t("common.length"))).toHaveLength(1);
    expect(constraintDims([slot], [slotLock])).toHaveLength(0);
    const rows = sketchDimRows([poly], [polyLock]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref.kind).toBe("entity");
    expect(constraintDims([poly], [polyLock])).toHaveLength(0);
    // the Dimension tool's own end-to-end length on a slot keeps its label, as a rectangle's does
    const toolP2p: SketchConstraint = { type: "p2pDistance", e1: "e17", p1: 0, e2: "e17", p2: 1, value: 100 };
    expect(constraintDims([slot], [toolP2p])).toHaveLength(1);
  });

  it("naming a parameter on a free slot length adds the lock first; on a polygon the radius itself takes it", () => {
    expect(dimBindingFor([], slot, "length", 100)).toEqual({ kind: "lock", c: slotLock });
    expect(dimBindingFor([slotLock], slot, "length", 100)).toEqual({ kind: "constraint", at: 0 });
    expect(dimBindingFor([], poly, "radius", 20)).toEqual({ kind: "entity", field: "radius" });
    expect(dimBindingFor([polyLock], poly, "radius", 20)).toEqual({ kind: "constraint", at: 0 });
  });

  it("typing into a free slot length or polygon radius plans a lock, written first", () => {
    expect(planDimEdit([], slot, "length", 80)).toEqual({ kind: "upsert", c: { ...slotLock, value: 80 }, moves: "e17", writeFirst: true });
    expect(planDimEdit([], poly, "radius", 12)).toEqual({ kind: "upsert", c: { ...polyLock, value: 12 }, moves: "p1", writeFirst: true });
    expect(planDimEdit([], slot, "width", 12)).toEqual({ kind: "direct" });
  });

  it("with no solver, a slot or polygon lock still sizes the shape", () => {
    const s = { ...slot }, p = { ...poly };
    expect(applyDrivingDimsDirect([s, p], [{ ...slotLock, value: 60 }, { ...polyLock, value: 12 }])).toBe(true);
    expect(lenOf(s)).toBeCloseTo(60, 9);
    expect(s.x1).toBe(-100); // the start holds, as a line's does
    expect(p.radius).toBe(12);
    const t2 = { ...slot };
    applyDrivingDimsDirect([t2], [{ type: "p2pDistance", e1: "e17", p1: 0, e2: "e17", p2: 1, value: 70 }]);
    expect(lenOf(t2)).toBeCloseTo(70, 9);
  });
});
